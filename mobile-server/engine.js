const {
  default: makeWASocket,
  DisconnectReason,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  Browsers,
  delay
} = require('@whiskeysockets/baileys');
const pino = require('pino');
const QRCode = require('qrcode');
const path = require('path');
const fs = require('fs');
const { run, all, DB_DIR } = require('./db');

const AUTH_DIR = path.join(DB_DIR, 'auth_info_baileys');
if (!fs.existsSync(AUTH_DIR)) {
  fs.mkdirSync(AUTH_DIR, { recursive: true });
}

let sock = null;
let currentQr = null;
let connectionStatus = 'connecting'; // 'connecting', 'qr', 'connected', 'disconnected'
let userProfile = null;
let isSyncing = false;
let syncTimeout = null;

function markSyncing() {
  isSyncing = true;
  if (syncTimeout) clearTimeout(syncTimeout);
  syncTimeout = setTimeout(() => {
    isSyncing = false;
  }, 12000);
}

async function initWhatsAppEngine() {
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  const { version, isLatest } = await fetchLatestBaileysVersion();

  sock = makeWASocket({
    version,
    logger: pino({ level: 'silent' }),
    auth: state,
    browser: Browsers.ubuntu('Chrome'),
    syncFullHistory: true,
    generateHighQualityLinkPreview: true
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      connectionStatus = 'qr';
      try {
        currentQr = await QRCode.toDataURL(qr);
      } catch (err) {
        console.error('Failed to generate QR code data URL:', err);
      }
    }

    if (connection === 'close') {
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
      connectionStatus = 'disconnected';
      currentQr = null;
      userProfile = null;
      isSyncing = false;
      console.log(`[WhatsApp Engine] Connection closed. Status: ${statusCode}. Reconnecting: ${shouldReconnect}`);

      if (shouldReconnect) {
        setTimeout(initWhatsAppEngine, 3000);
      } else {
        console.log('[WhatsApp Engine] Session logged out. Clearing auth data...');
        try { fs.rmSync(AUTH_DIR, { recursive: true, force: true }); } catch (_) {}
        setTimeout(initWhatsAppEngine, 1000);
      }
    } else if (connection === 'open') {
      connectionStatus = 'connected';
      currentQr = null;
      userProfile = sock.user;
      markSyncing();
      console.log(`[WhatsApp Engine] Connected successfully as: ${userProfile?.name || userProfile?.id}`);
      
      // Auto-fetch all groups and sync them into contacts table
      try {
        const groups = await sock.groupFetchAllParticipating();
        for (const [gid, groupData] of Object.entries(groups)) {
          await upsertContactRecord(gid, groupData.subject || '', null, 1);
        }
      } catch (_) {}
    }
  });

  // Helper to persist contacts into SQLite
  async function upsertContactRecord(jid, rawName, rawPhone, isGroup = 0) {
    if (!jid || jid === 'status@broadcast' || jid.endsWith('@lid') || jid.includes('broadcast')) return;
    if (!jid.endsWith('@s.whatsapp.net') && !jid.endsWith('@g.us')) return;

    const isGrp = isGroup || (jid.endsWith('@g.us') ? 1 : 0);
    const phone = rawPhone || (isGrp ? '' : jid.split('@')[0].replace(/\D/g, ''));
    let name = (rawName || '').trim();
    if (name.includes('@') || name === phone) name = '';

    try {
      await run(`
        INSERT INTO contacts (jid, name, phone, is_group, updated_at)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(jid) DO UPDATE SET
          name = CASE
            WHEN nullif(excluded.name, '') IS NOT NULL THEN excluded.name
            WHEN contacts.name LIKE '%@%' OR contacts.name = contacts.phone THEN ''
            ELSE contacts.name
          END,
          phone = coalesce(nullif(excluded.phone, ''), contacts.phone),
          updated_at = excluded.updated_at
      `, [jid, name, phone, isGrp, Date.now()]);
    } catch (_) {}
  }

  // 1. Initial Multi-Device History Sync (contains all contacts & chats)
  sock.ev.on('messaging-history.set', async ({ contacts, chats }) => {
    if (contacts && contacts.length) {
      for (const c of contacts) {
        await upsertContactRecord(c.id, c.name || c.notify || c.verifiedName || '', null);
      }
    }
    if (chats && chats.length) {
      for (const ch of chats) {
        await upsertContactRecord(ch.id, ch.name || '', null, ch.id?.endsWith('@g.us') ? 1 : 0);
      }
    }
  });

  // 2. Contacts events
  sock.ev.on('contacts.set', async ({ contacts }) => {
    for (const c of contacts || []) {
      await upsertContactRecord(c.id, c.name || c.notify || c.verifiedName || '', null);
    }
  });

  sock.ev.on('contacts.upsert', async (contacts) => {
    for (const c of contacts || []) {
      await upsertContactRecord(c.id, c.name || c.notify || c.verifiedName || '', null);
    }
  });

  sock.ev.on('contacts.update', async (updates) => {
    for (const u of updates || []) {
      if (u.id && (u.name || u.notify)) {
        await upsertContactRecord(u.id, u.name || u.notify || '', null);
      }
    }
  });

  // 3. Chats & Groups events
  sock.ev.on('chats.set', async ({ chats }) => {
    for (const ch of chats || []) {
      await upsertContactRecord(ch.id, ch.name || '', null, ch.id?.endsWith('@g.us') ? 1 : 0);
    }
  });

  sock.ev.on('chats.upsert', async (chats) => {
    for (const ch of chats || []) {
      await upsertContactRecord(ch.id, ch.name || '', null, ch.id?.endsWith('@g.us') ? 1 : 0);
    }
  });

  sock.ev.on('groups.update', async (updates) => {
    for (const g of updates || []) {
      if (g.id && g.subject) {
        await upsertContactRecord(g.id, g.subject, null, 1);
      }
    }
  });

  sock.ev.on('messages.upsert', async ({ messages }) => {
    for (const m of messages || []) {
      if (!m.key?.remoteJid) continue;
      const jid = m.key.remoteJid;
      const isGrp = jid.endsWith('@g.us') ? 1 : 0;
      const name = m.pushName || '';
      await upsertContactRecord(jid, name, null, isGrp);
    }
  });

  return sock;
}

function getStatus() {
  return {
    status: connectionStatus,
    syncing: isSyncing,
    qr: currentQr,
    user: userProfile ? {
      id: userProfile.id,
      name: userProfile.name || userProfile.id?.split(':')[0] || 'My WhatsApp'
    } : null
  };
}

async function requestPairingCode(phoneNumber) {
  if (!sock) throw new Error('WhatsApp engine not initialized');
  let cleaned = String(phoneNumber || '').replace(/\D/g, '');
  if (cleaned.startsWith('0')) cleaned = cleaned.replace(/^0+/, '');
  if (cleaned.length < 8) throw new Error('Invalid phone number. Include country code (e.g. 919876543210)');

  if (sock.authState?.creds?.registered) {
    throw new Error('WhatsApp is already registered/linked.');
  }

  const code = await sock.requestPairingCode(cleaned);
  return code;
}

async function getProfilePicture(jid) {
  if (!sock || connectionStatus !== 'connected') return null;
  try {
    const url = await sock.profilePictureUrl(jid, 'preview');
    return url;
  } catch (_) {
    return null;
  }
}

async function formatRecipientJid(recipient) {
  let target = String(recipient || '').trim();
  if (target.includes('@s.whatsapp.net') || target.includes('@g.us')) {
    return target;
  }

  // 1. Check if it matches a contact name in the SQLite database
  let contact = await require('./db').get(
    `SELECT jid FROM contacts WHERE lower(name) = lower(?) LIMIT 1`,
    [target]
  );
  if (contact?.jid) return contact.jid;

  const rawDigits = target.replace(/\D/g, '');
  let normalizedDigits = rawDigits;
  if (rawDigits.length === 10) {
    normalizedDigits = '91' + rawDigits;
  } else if (rawDigits.length === 11 && rawDigits.startsWith('0')) {
    normalizedDigits = '91' + rawDigits.slice(1);
  }

  // 2. Check by phone number only if digits are present
  if (rawDigits.length > 0) {
    contact = await require('./db').get(
      `SELECT jid FROM contacts 
       WHERE phone = ? 
          OR phone = ? 
          OR phone = ? 
       LIMIT 1`,
      [rawDigits, normalizedDigits, rawDigits.startsWith('91') ? rawDigits.slice(2) : rawDigits]
    );
    if (contact?.jid) return contact.jid;
  }

  // 3. Format as direct phone number (auto-defaults 10-digits to India +91)
  if (normalizedDigits.length >= 7) {
    return `${normalizedDigits}@s.whatsapp.net`;
  }

  throw new Error(`Could not resolve contact JID for: "${recipient}"`);
}

async function sendWhatsAppMessage(recipient, text, attachments = []) {
  if (connectionStatus !== 'connected' || !sock) {
    throw new Error('WhatsApp engine is not connected.');
  }

  const jid = await formatRecipientJid(recipient);

  // Send attachments first if present
  if (attachments && attachments.length > 0) {
    for (let i = 0; i < attachments.length; i++) {
      const file = attachments[i];
      const filePath = path.isAbsolute(file.path) ? file.path : path.join(__dirname, file.path);
      if (!fs.existsSync(filePath)) {
        throw new Error(`Attachment file not found: ${file.name || filePath}`);
      }

      const fileBuffer = fs.readFileSync(filePath);
      const mimeType = file.mimetype || file.type || 'application/octet-stream';
      const fileName = file.originalname || file.name || path.basename(filePath);
      const caption = (i === attachments.length - 1 && text) ? text : '';

      if (mimeType.startsWith('image/')) {
        await sock.sendMessage(jid, {
          image: fileBuffer,
          caption,
          mimetype: mimeType,
          fileName
        });
      } else if (mimeType.startsWith('video/')) {
        await sock.sendMessage(jid, {
          video: fileBuffer,
          caption,
          mimetype: mimeType,
          fileName
        });
      } else if (mimeType.startsWith('audio/')) {
        await sock.sendMessage(jid, {
          audio: fileBuffer,
          mimetype: mimeType,
          fileName
        });
      } else {
        // Send as Document (CSVs, PDFs, DOCX, ZIP, etc.)
        await sock.sendMessage(jid, {
          document: fileBuffer,
          mimetype: mimeType,
          fileName,
          caption
        });
      }
      await delay(1000);
    }
  } else if (text) {
    // Plain text message
    await sock.sendMessage(jid, { text });
  }

  return { success: true, jid };
}

async function logoutSession() {
  if (sock) {
    try { await sock.logout(); } catch (_) {}
  }
  try { fs.rmSync(AUTH_DIR, { recursive: true, force: true }); } catch (_) {}
  connectionStatus = 'disconnected';
  userProfile = null;
  currentQr = null;
  setTimeout(initWhatsAppEngine, 1000);
  return { success: true };
}

module.exports = {
  initWhatsAppEngine,
  getStatus,
  requestPairingCode,
  getProfilePicture,
  sendWhatsAppMessage,
  logoutSession
};
