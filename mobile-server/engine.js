const {
  default: makeWASocket,
  DisconnectReason,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
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

async function initWhatsAppEngine() {
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  const { version, isLatest } = await fetchLatestBaileysVersion();

  sock = makeWASocket({
    version,
    logger: pino({ level: 'silent' }),
    printQRInTerminal: true,
    auth: state,
    browser: ['WhatsApp Scheduler PWA', 'Chrome', '128.0.0.0'],
    syncFullHistory: false,
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
      console.log(`[WhatsApp Engine] Connected successfully as: ${userProfile?.name || userProfile?.id}`);
    }
  });

  // Sync contacts into SQLite
  sock.ev.on('contacts.upsert', async (contacts) => {
    for (const c of contacts) {
      if (!c?.id) continue;
      const jid = c.id;
      const name = c.name || c.notify || c.verifiedName || '';
      const isGroup = jid.endsWith('@g.us') ? 1 : 0;
      const phone = jid.split('@')[0].replace(/\D/g, '');
      try {
        await run(`
          INSERT INTO contacts (jid, name, phone, is_group, updated_at)
          VALUES (?, ?, ?, ?, ?)
          ON CONFLICT(jid) DO UPDATE SET
            name = coalesce(nullif(excluded.name, ''), contacts.name),
            updated_at = excluded.updated_at
        `, [jid, name, phone, isGroup, Date.now()]);
      } catch (_) {}
    }
  });

  return sock;
}

function getStatus() {
  return {
    status: connectionStatus,
    qr: currentQr,
    user: userProfile ? {
      id: userProfile.id,
      name: userProfile.name || userProfile.id?.split(':')[0] || 'My WhatsApp'
    } : null
  };
}

async function requestPairingCode(phoneNumber) {
  if (!sock) throw new Error('WhatsApp engine not initialized');
  const cleaned = phoneNumber.replace(/\D/g, '');
  if (!cleaned) throw new Error('Invalid phone number');
  const code = await sock.requestPairingCode(cleaned);
  return code;
}

async function formatRecipientJid(recipient) {
  let target = String(recipient || '').trim();
  if (target.includes('@s.whatsapp.net') || target.includes('@g.us')) {
    return target;
  }

  // 1. Check if it matches a contact name in the SQLite database
  const contact = await require('./db').get(
    `SELECT jid FROM contacts WHERE lower(name) = lower(?) OR phone = ? LIMIT 1`,
    [target, target.replace(/\D/g, '')]
  );
  if (contact?.jid) return contact.jid;

  // 2. Format as direct phone number
  const digits = target.replace(/\D/g, '');
  if (digits.length >= 7) {
    return `${digits}@s.whatsapp.net`;
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
  sendWhatsAppMessage,
  logoutSession
};
