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
const { run, get, all, batchUpsertContacts, DB_DIR } = require('./db');

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
  }, 8000);
}

async function initWhatsAppEngine() {
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  const { version } = await fetchLatestBaileysVersion();

  // If already registered from previous session, initialize as connecting
  if (state.creds?.registered) {
    connectionStatus = 'connecting';
  }

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
      connectionStatus = shouldReconnect ? 'connecting' : 'disconnected';
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
      
      // Auto-fetch participating groups and sync in background
      try {
        const groups = await sock.groupFetchAllParticipating();
        const groupRecords = [];
        for (const [gid, gData] of Object.entries(groups)) {
          groupRecords.push({
            jid: gid,
            name: gData.subject || 'WhatsApp Group',
            phone: '',
            is_group: 1
          });
        }
        if (groupRecords.length > 0) {
          await batchUpsertContacts(groupRecords);
        }
      } catch (_) {}
    }
  });

  // 1. Initial Multi-Device History Sync (contacts, chats & message pushNames)
  sock.ev.on('messaging-history.set', async ({ contacts, chats, messages }) => {
    markSyncing();
    const batch = [];

    if (contacts && contacts.length) {
      for (const c of contacts) {
        if (!c.id || c.id.endsWith('@lid')) continue;
        batch.push({
          jid: c.id,
          name: c.name || c.notify || c.verifiedName || '',
          phone: c.id.split('@')[0].replace(/\D/g, ''),
          is_group: c.id.endsWith('@g.us') ? 1 : 0
        });
      }
    }

    if (chats && chats.length) {
      for (const ch of chats) {
        if (!ch.id || ch.id.endsWith('@lid')) continue;
        batch.push({
          jid: ch.id,
          name: ch.name || '',
          phone: ch.id.endsWith('@g.us') ? '' : ch.id.split('@')[0].replace(/\D/g, ''),
          is_group: ch.id.endsWith('@g.us') ? 1 : 0
        });
      }
    }

    if (messages && messages.length) {
      for (const m of messages) {
        if (!m.key) continue;
        const jid = m.key.remoteJid;
        const sender = m.key.participant || jid;
        const pushName = m.pushName || '';
        if (jid && !jid.endsWith('@g.us') && !jid.endsWith('@lid')) {
          batch.push({ jid, name: pushName, phone: jid.split('@')[0].replace(/\D/g, ''), is_group: 0 });
        } else if (sender && !sender.endsWith('@g.us') && !sender.endsWith('@lid')) {
          batch.push({ jid: sender, name: pushName, phone: sender.split('@')[0].replace(/\D/g, ''), is_group: 0 });
        }
      }
    }

    if (batch.length > 0) {
      await batchUpsertContacts(batch);
    }
  });

  // 2. Real-Time Contacts Updates
  sock.ev.on('contacts.set', async ({ contacts }) => {
    if (!contacts || !contacts.length) return;
    const batch = contacts.map(c => ({
      jid: c.id,
      name: c.name || c.notify || c.verifiedName || '',
      phone: (c.id || '').split('@')[0].replace(/\D/g, ''),
      is_group: (c.id || '').endsWith('@g.us') ? 1 : 0
    }));
    await batchUpsertContacts(batch);
  });

  sock.ev.on('contacts.upsert', async (contacts) => {
    if (!contacts || !contacts.length) return;
    const batch = contacts.map(c => ({
      jid: c.id,
      name: c.name || c.notify || c.verifiedName || '',
      phone: (c.id || '').split('@')[0].replace(/\D/g, ''),
      is_group: (c.id || '').endsWith('@g.us') ? 1 : 0
    }));
    await batchUpsertContacts(batch);
  });

  sock.ev.on('contacts.update', async (updates) => {
    if (!updates || !updates.length) return;
    const batch = updates.map(u => ({
      jid: u.id,
      name: u.name || u.notify || '',
      phone: (u.id || '').split('@')[0].replace(/\D/g, ''),
      is_group: (u.id || '').endsWith('@g.us') ? 1 : 0
    }));
    await batchUpsertContacts(batch);
  });

  // 3. Real-Time Chats & Messages
  sock.ev.on('chats.set', async ({ chats }) => {
    if (!chats || !chats.length) return;
    const batch = chats.map(ch => ({
      jid: ch.id,
      name: ch.name || '',
      phone: (ch.id || '').endsWith('@g.us') ? '' : (ch.id || '').split('@')[0].replace(/\D/g, ''),
      is_group: (ch.id || '').endsWith('@g.us') ? 1 : 0
    }));
    await batchUpsertContacts(batch);
  });

  sock.ev.on('chats.upsert', async (chats) => {
    if (!chats || !chats.length) return;
    const batch = chats.map(ch => ({
      jid: ch.id,
      name: ch.name || '',
      phone: (ch.id || '').endsWith('@g.us') ? '' : (ch.id || '').split('@')[0].replace(/\D/g, ''),
      is_group: (ch.id || '').endsWith('@g.us') ? 1 : 0
    }));
    await batchUpsertContacts(batch);
  });

  sock.ev.on('messages.upsert', async ({ messages }) => {
    const batch = [];
    for (const m of messages || []) {
      if (!m.key) continue;
      const jid = m.key.remoteJid;
      const sender = m.key.participant || jid;
      const pushName = (m.pushName || '').trim();
      if (pushName && jid && !jid.endsWith('@g.us') && !jid.endsWith('@lid')) {
        batch.push({ jid, name: pushName, phone: jid.split('@')[0].replace(/\D/g, ''), is_group: 0 });
      } else if (pushName && sender && !sender.endsWith('@g.us') && !sender.endsWith('@lid')) {
        batch.push({ jid: sender, name: pushName, phone: sender.split('@')[0].replace(/\D/g, ''), is_group: 0 });
      }
    }
    if (batch.length > 0) {
      await batchUpsertContacts(batch);
    }
  });

  return sock;
}

async function getStatus() {
  let count = 0;
  try {
    const row = await get(`SELECT COUNT(*) as count FROM contacts WHERE jid NOT LIKE '%@lid' AND (jid LIKE '%@s.whatsapp.net' OR jid LIKE '%@g.us')`);
    count = row ? row.count : 0;
  } catch (_) {}

  return {
    status: connectionStatus,
    syncing: isSyncing,
    contactCount: count,
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
  
  if (cleaned.length === 10) {
    cleaned = '91' + cleaned;
  }

  if (cleaned.length < 8) throw new Error('Invalid phone number. Please enter a valid 10-digit mobile number.');

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

  // 1. Check if it matches a contact name in SQLite
  let contact = await get(
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

  // 2. Check by phone number in SQLite
  if (rawDigits.length > 0) {
    contact = await get(
      `SELECT jid FROM contacts 
       WHERE phone = ? 
          OR phone = ? 
          OR phone = ? 
       LIMIT 1`,
      [rawDigits, normalizedDigits, rawDigits.startsWith('91') ? rawDigits.slice(2) : rawDigits]
    );
    if (contact?.jid) return contact.jid;
  }

  // 3. Format direct JID (defaults 10-digit Indian numbers to +91)
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
        await sock.sendMessage(jid, { image: fileBuffer, caption, mimetype: mimeType, fileName });
      } else if (mimeType.startsWith('video/')) {
        await sock.sendMessage(jid, { video: fileBuffer, caption, mimetype: mimeType, fileName });
      } else if (mimeType.startsWith('audio/')) {
        await sock.sendMessage(jid, { audio: fileBuffer, mimetype: mimeType, fileName });
      } else {
        await sock.sendMessage(jid, { document: fileBuffer, mimetype: mimeType, fileName, caption });
      }
      await delay(1000);
    }
  } else if (text) {
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
