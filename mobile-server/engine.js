const {
  default: makeWASocket,
  DisconnectReason,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  Browsers,
  delay
} = require("@whiskeysockets/baileys");
const pino = require("pino");
const QRCode = require("qrcode");
const path = require("path");
const fs = require("fs");
const { run, get, all, batchUpsertContacts, migrateLegacyData, DB_DIR } = require("./db");

const SESSIONS_BASE_DIR = path.join(DB_DIR, "sessions");
if (!fs.existsSync(SESSIONS_BASE_DIR)) {
  fs.mkdirSync(SESSIONS_BASE_DIR, { recursive: true });
}

// User-Scoped WhatsApp Session Class
class UserWhatsAppSession {
  constructor(userId) {
    this.userId = userId;
    this.sock = null;
    this.currentQr = null;
    this.connectionStatus = "disconnected"; // "connecting", "qr", "connected", "disconnected"
    this.userProfile = null;
    this.isSyncing = false;
    this.syncTimeout = null;
    this.authDir = path.join(SESSIONS_BASE_DIR, userId, "auth_info_baileys");

    if (!fs.existsSync(this.authDir)) {
      fs.mkdirSync(this.authDir, { recursive: true });
    }
  }

  markSyncing(duration = 5000) {
    this.isSyncing = true;
    if (this.syncTimeout) clearTimeout(this.syncTimeout);
    this.syncTimeout = setTimeout(() => {
      this.isSyncing = false;
    }, duration);
  }

  async init() {
    if (this._isInitializing) return this.sock;
    this._isInitializing = true;
    try {
      const { state, saveCreds } = await useMultiFileAuthState(this.authDir);
      const { version } = await fetchLatestBaileysVersion();

      if (state.creds?.registered) {
        this.connectionStatus = "connecting";
      }

      this.sock = makeWASocket({
        version,
        logger: pino({ level: "silent" }),
        auth: state,
        browser: Browsers.ubuntu("Chrome"),
        syncFullHistory: process.env.WA_SYNC_FULL_HISTORY === "true",
        generateHighQualityLinkPreview: true
      });

      this.sock.ev.on("creds.update", saveCreds);

      this.sock.ev.on("connection.update", async (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
          this.connectionStatus = "qr";
          try {
            this.currentQr = await QRCode.toDataURL(qr);
          } catch (err) {
            console.error(`[WhatsApp Engine ${this.userId}] Failed to generate QR:`, err);
          }
        }

        if (connection === "close") {
          const statusCode = lastDisconnect?.error?.output?.statusCode;
          const isLoggedOut = (
            statusCode === DisconnectReason.loggedOut ||
            statusCode === DisconnectReason.badSession ||
            statusCode === DisconnectReason.multideviceMismatch ||
            statusCode === 401 ||
            statusCode === 403
          );
          const shouldReconnect = !isLoggedOut;
          this.connectionStatus = shouldReconnect ? "connecting" : "disconnected";
          this.currentQr = null;
          this.userProfile = null;
          this.isSyncing = false;

          if (isLoggedOut) {
            console.log(`[WhatsApp Engine ${this.userId}] WhatsApp unlinked. Resetting auth state...`);
            if (this.sock) {
              try { await this.sock.logout(); } catch (_) {
                try { this.sock.end(new Error("Logged out")); } catch (_) {}
              }
            }
            try { fs.rmSync(this.authDir, { recursive: true, force: true }); } catch (_) {}
            try {
              await run("INSERT INTO settings (user_id, key, value) VALUES (?, 'phonebook_imported', '0') ON CONFLICT(user_id, key) DO UPDATE SET value = '0'", [this.userId]);
              await run("DELETE FROM contacts WHERE user_id = ?", [this.userId]);
            } catch (_) {}
            setTimeout(() => this.init(), 1000);
          } else if (shouldReconnect) {
            setTimeout(() => this.init(), 3000);
          }
        } else if (connection === "open") {
          this.connectionStatus = "connected";
          this.currentQr = null;
          this.userProfile = this.sock.user;
          console.log(`[WhatsApp Engine ${this.userId}] Connected successfully as: ${this.userProfile?.name || this.userProfile?.id}`);

          // Auto-fetch participating groups
          try {
            const groups = await this.sock.groupFetchAllParticipating();
            const groupRecords = [];
            for (const [gid, gData] of Object.entries(groups)) {
              groupRecords.push({
                jid: gid,
                name: gData.subject || "WhatsApp Group",
                phone: "",
                is_group: 1
              });
            }
            if (groupRecords.length > 0) {
              await batchUpsertContacts(this.userId, groupRecords);
            }
          } catch (_) {}
        }
      });

      // Contact & chat sync handlers
      this.sock.ev.on("messaging-history.set", async ({ contacts, chats, messages }) => {
        this.markSyncing(6000);
        const batch = [];

        if (contacts && contacts.length) {
          for (const c of contacts) {
            if (!c.id || c.id.endsWith("@lid")) continue;
            batch.push({
              jid: c.id,
              name: c.name || c.notify || c.verifiedName || "",
              phone: c.id.split("@")[0].replace(/\D/g, ""),
              is_group: c.id.endsWith("@g.us") ? 1 : 0
            });
          }
        }

        if (chats && chats.length) {
          for (const ch of chats) {
            if (!ch.id || ch.id.endsWith("@lid")) continue;
            batch.push({
              jid: ch.id,
              name: ch.name || "",
              phone: ch.id.endsWith("@g.us") ? "" : ch.id.split("@")[0].replace(/\D/g, ""),
              is_group: ch.id.endsWith("@g.us") ? 1 : 0
            });
          }
        }

        if (messages && messages.length) {
          for (const m of messages) {
            if (!m.key) continue;
            const jid = m.key.remoteJid;
            const sender = m.key.participant || jid;
            const pushName = m.pushName || "";
            if (jid && !jid.endsWith("@g.us") && !jid.endsWith("@lid")) {
              batch.push({ jid, name: pushName, phone: jid.split("@")[0].replace(/\D/g, ""), is_group: 0 });
            } else if (sender && !sender.endsWith("@g.us") && !sender.endsWith("@lid")) {
              batch.push({ jid: sender, name: pushName, phone: sender.split("@")[0].replace(/\D/g, ""), is_group: 0 });
            }
          }
        }

        if (batch.length > 0) {
          await batchUpsertContacts(this.userId, batch);
        }
        this.isSyncing = false;
      });

      this.sock.ev.on("contacts.set", async ({ contacts }) => {
        if (!contacts || !contacts.length) return;
        const batch = contacts.map(c => ({
          jid: c.id,
          name: c.name || c.notify || c.verifiedName || "",
          phone: (c.id || "").split("@")[0].replace(/\D/g, ""),
          is_group: (c.id || "").endsWith("@g.us") ? 1 : 0
        }));
        await batchUpsertContacts(this.userId, batch);
      });

      this.sock.ev.on("contacts.upsert", async (contacts) => {
        if (!contacts || !contacts.length) return;
        const batch = contacts.map(c => ({
          jid: c.id,
          name: c.name || c.notify || c.verifiedName || "",
          phone: (c.id || "").split("@")[0].replace(/\D/g, ""),
          is_group: (c.id || "").endsWith("@g.us") ? 1 : 0
        }));
        await batchUpsertContacts(this.userId, batch);
      });

      this.sock.ev.on("contacts.update", async (updates) => {
        if (!updates || !updates.length) return;
        const batch = updates.map(u => ({
          jid: u.id,
          name: u.name || u.notify || "",
          phone: (u.id || "").split("@")[0].replace(/\D/g, ""),
          is_group: (u.id || "").endsWith("@g.us") ? 1 : 0
        }));
        await batchUpsertContacts(this.userId, batch);
      });

      this.sock.ev.on("chats.set", async ({ chats }) => {
        if (!chats || !chats.length) return;
        const batch = chats.map(ch => ({
          jid: ch.id,
          name: ch.name || "",
          phone: (ch.id || "").endsWith("@g.us") ? "" : (ch.id || "").split("@")[0].replace(/\D/g, ""),
          is_group: (ch.id || "").endsWith("@g.us") ? 1 : 0
        }));
        await batchUpsertContacts(this.userId, batch);
      });

      this.sock.ev.on("chats.upsert", async (chats) => {
        if (!chats || !chats.length) return;
        const batch = chats.map(ch => ({
          jid: ch.id,
          name: ch.name || "",
          phone: (ch.id || "").endsWith("@g.us") ? "" : (ch.id || "").split("@")[0].replace(/\D/g, ""),
          is_group: (ch.id || "").endsWith("@g.us") ? 1 : 0
        }));
        await batchUpsertContacts(this.userId, batch);
      });

      this.sock.ev.on("messages.upsert", async ({ messages }) => {
        const batch = [];
        for (const m of messages || []) {
          if (!m.key) continue;
          const jid = m.key.remoteJid;
          const sender = m.key.participant || jid;
          const pushName = (m.pushName || "").trim();
          if (pushName && jid && !jid.endsWith("@g.us") && !jid.endsWith("@lid")) {
            batch.push({ jid, name: pushName, phone: jid.split("@")[0].replace(/\D/g, ""), is_group: 0 });
          } else if (pushName && sender && !sender.endsWith("@g.us") && !sender.endsWith("@lid")) {
            batch.push({ jid: sender, name: pushName, phone: sender.split("@")[0].replace(/\D/g, ""), is_group: 0 });
          }
        }
        if (batch.length > 0) {
          await batchUpsertContacts(this.userId, batch);
        }
      });

      return this.sock;
    } catch (err) {
      console.error(`[WhatsApp Engine ${this.userId}] Initialization error:`, err.message);
    } finally {
      this._isInitializing = false;
    }
  }

  async getStatus() {
    if (!this.sock && !this._isInitializing) {
      this.init().catch(() => {});
    }

    let count = 0;
    let phonebookCount = 0;
    let phonebookImported = false;

    try {
      const row = await get("SELECT COUNT(*) as count FROM contacts WHERE user_id = ? AND jid NOT LIKE '%@lid' AND (jid LIKE '%@s.whatsapp.net' OR jid LIKE '%@g.us')", [this.userId]);
      count = row ? row.count : 0;

      const pbRow = await get("SELECT COUNT(*) as count FROM contacts WHERE user_id = ? AND name_source = 'phonebook' AND nullif(name, '') IS NOT NULL", [this.userId]);
      phonebookCount = pbRow ? pbRow.count : 0;

      const setting = await get("SELECT value FROM settings WHERE user_id = ? AND key = 'phonebook_imported'", [this.userId]);
      phonebookImported = setting ? setting.value === "1" : false;
    } catch (_) {}

    return {
      status: this.connectionStatus,
      syncing: this.isSyncing && count === 0,
      contactCount: count,
      phonebookContactCount: phonebookCount,
      phonebookImported: phonebookImported && phonebookCount > 0,
      qr: this.currentQr,
      user: this.userProfile ? {
        id: this.userProfile.id,
        name: this.userProfile.name || this.userProfile.id?.split(":")[0] || "My WhatsApp"
      } : null
    };
  }

  async requestPairingCode(phoneNumber) {
    if (!this.sock) {
      await this.init();
    }
    if (!this.sock) throw new Error("WhatsApp engine not initialized for this account.");
    let cleaned = String(phoneNumber || "").replace(/\D/g, "");
    if (cleaned.startsWith("0")) cleaned = cleaned.replace(/^0+/, "");
    
    if (cleaned.length === 10) {
      cleaned = "91" + cleaned;
    }

    if (cleaned.length < 8) throw new Error("Invalid phone number. Please enter a valid 10-digit mobile number.");

    if (this.sock.authState?.creds?.registered) {
      throw new Error("WhatsApp is already registered/linked on this account.");
    }

    const code = await this.sock.requestPairingCode(cleaned);
    return code;
  }

  async getProfilePicture(jid) {
    if (!this.sock || this.connectionStatus !== "connected") return null;
    try {
      const url = await this.sock.profilePictureUrl(jid, "preview");
      return url;
    } catch (_) {
      return null;
    }
  }

  async formatRecipientJid(recipient) {
    let target = String(recipient || "").trim();
    if (!target) throw new Error("Recipient is empty");

    if (target.includes("@s.whatsapp.net") || target.includes("@g.us")) {
      return target;
    }

    const formattedMatch = target.match(/^(.*?)\s*[\(\[]([+0-9\s-]+)[\)\]]$/);
    if (formattedMatch) {
      const namePart = formattedMatch[1].trim();
      const phonePart = formattedMatch[2].trim();
      const phoneDigits = phonePart.replace(/\D/g, "");

      if (phoneDigits.length >= 7) {
        let normalized = phoneDigits;
        if (phoneDigits.length === 10) {
          normalized = "91" + phoneDigits;
        } else if (phoneDigits.length === 11 && phoneDigits.startsWith("0")) {
          normalized = "91" + phoneDigits.slice(1);
        }
        return `${normalized}@s.whatsapp.net`;
      }

      if (namePart) {
        const contact = await get(
          "SELECT jid FROM contacts WHERE user_id = ? AND lower(name) = lower(?) LIMIT 1",
          [this.userId, namePart]
        );
        if (contact?.jid) return contact.jid;
      }
    }

    let contact = await get(
      "SELECT jid FROM contacts WHERE user_id = ? AND lower(name) = lower(?) LIMIT 1",
      [this.userId, target]
    );
    if (contact?.jid) return contact.jid;

    let groupContact = await get(
      "SELECT jid FROM contacts WHERE user_id = ? AND is_group = 1 AND lower(name) = lower(?) LIMIT 1",
      [this.userId, target]
    );
    if (groupContact?.jid) return groupContact.jid;

    const rawDigits = target.replace(/\D/g, "");
    if (rawDigits.length >= 7) {
      let normalizedDigits = rawDigits;
      if (rawDigits.length === 10) {
        normalizedDigits = "91" + rawDigits;
      } else if (rawDigits.length === 11 && rawDigits.startsWith("0")) {
        normalizedDigits = "91" + rawDigits.slice(1);
      }

      contact = await get(
        `SELECT jid FROM contacts 
         WHERE user_id = ? 
           AND (phone = ? OR phone = ? OR phone = ?) 
         LIMIT 1`,
        [this.userId, rawDigits, normalizedDigits, rawDigits.startsWith("91") ? rawDigits.slice(2) : rawDigits]
      );
      if (contact?.jid) return contact.jid;

      return `${normalizedDigits}@s.whatsapp.net`;
    }

    throw new Error(`Could not resolve WhatsApp contact for: "${recipient}".`);
  }

  async sendMessage(recipient, text, attachments = []) {
    if (this.connectionStatus !== "connected" || !this.sock) {
      throw new Error(`WhatsApp is not connected for user account.`);
    }

    const jid = await this.formatRecipientJid(recipient);

    if (attachments && attachments.length > 0) {
      for (let i = 0; i < attachments.length; i++) {
        const file = attachments[i];
        const filePath = path.isAbsolute(file.path) ? file.path : path.join(__dirname, file.path);
        if (!fs.existsSync(filePath)) {
          throw new Error(`Attachment file not found: ${file.name || filePath}`);
        }

        const fileBuffer = fs.readFileSync(filePath);
        const mimeType = file.mimetype || file.type || "application/octet-stream";
        const fileName = file.originalname || file.name || path.basename(filePath);
        const caption = (i === attachments.length - 1 && text) ? text : "";

        if (mimeType.startsWith("image/")) {
          await this.sock.sendMessage(jid, { image: fileBuffer, caption, mimetype: mimeType, fileName });
        } else if (mimeType.startsWith("video/")) {
          await this.sock.sendMessage(jid, { video: fileBuffer, caption, mimetype: mimeType, fileName });
        } else if (mimeType.startsWith("audio/")) {
          await this.sock.sendMessage(jid, { audio: fileBuffer, mimetype: mimeType, fileName });
        } else {
          await this.sock.sendMessage(jid, { document: fileBuffer, mimetype: mimeType, fileName, caption });
        }
        await delay(1000);
      }
    } else if (text) {
      await this.sock.sendMessage(jid, { text });
    }

    return { success: true, jid };
  }

  async logout() {
    console.log(`[WhatsApp Engine ${this.userId}] User triggered explicit logout. Wiping session files...`);
    if (this.sock) {
      try { await this.sock.logout(); } catch (_) {
        try { this.sock.end(new Error("Logged out")); } catch (_) {}
      }
    }
    try { fs.rmSync(this.authDir, { recursive: true, force: true }); } catch (_) {}
    try {
      await run("INSERT INTO settings (user_id, key, value) VALUES (?, 'phonebook_imported', '0') ON CONFLICT(user_id, key) DO UPDATE SET value = '0'", [this.userId]);
      await run("DELETE FROM contacts WHERE user_id = ?", [this.userId]);
    } catch (_) {}
    this.connectionStatus = "disconnected";
    this.userProfile = null;
    this.currentQr = null;
    this.isSyncing = false;
    setTimeout(() => this.init(), 1000);
    return { success: true };
  }
}

// Session Registry: Map<userId, UserWhatsAppSession>
const userSessions = new Map();

function getOrCreateUserSession(userId) {
  if (!userId) throw new Error("User ID is required for WhatsApp session operation");
  if (!userSessions.has(userId)) {
    const session = new UserWhatsAppSession(userId);
    userSessions.set(userId, session);
    session.init().catch(err => console.error(`[WhatsApp Engine ${userId}] Session boot error:`, err.message));
  }
  return userSessions.get(userId);
}

// Safe Legacy Migration helper
async function migrateLegacyAuthState() {
  const legacyAuthDir = path.join(DB_DIR, "auth_info_baileys");
  if (fs.existsSync(path.join(legacyAuthDir, "creds.json"))) {
    const adminUser = await get("SELECT id FROM users WHERE role = 'admin' ORDER BY created_at ASC LIMIT 1");
    if (adminUser?.id) {
      const targetDir = path.join(SESSIONS_BASE_DIR, adminUser.id, "auth_info_baileys");
      if (!fs.existsSync(targetDir) || fs.readdirSync(targetDir).length === 0) {
        fs.mkdirSync(targetDir, { recursive: true });
        const files = fs.readdirSync(legacyAuthDir);
        for (const file of files) {
          fs.copyFileSync(path.join(legacyAuthDir, file), path.join(targetDir, file));
        }
        console.log(`[Migration] Migrated legacy WhatsApp session keys to admin user ${adminUser.id}`);
      }
      await migrateLegacyData(adminUser.id);
    }
  }
}

// Global initialization of active sessions
async function initAllActiveSessions() {
  try {
    await migrateLegacyAuthState();
    const users = await all("SELECT id FROM users");
    for (const u of users) {
      const session = getOrCreateUserSession(u.id);
      await session.init();
    }
  } catch (err) {
    console.error("[WhatsApp Engine] Error booting active sessions:", err.message);
  }
}

// Cleanup session resources on user deletion
async function closeAndCleanupUserSession(userId) {
  if (!userId) return;
  const session = userSessions.get(userId);
  if (session) {
    if (session.sock) {
      try {
        await session.sock.logout();
      } catch (_) {
        try { session.sock.end(new Error("User deleted")); } catch (_) {}
      }
    }
    userSessions.delete(userId);
  }

  // Safely wipe session files on disk
  const userSessionDir = path.join(SESSIONS_BASE_DIR, userId);
  try {
    if (fs.existsSync(userSessionDir)) {
      fs.rmSync(userSessionDir, { recursive: true, force: true });
    }
  } catch (err) {
    console.error(`[WhatsApp Engine] Failed to wipe session dir for user ${userId}:`, err.message);
  }

  // Safely wipe user uploads on disk
  const userUploadsDir = path.join(DB_DIR, "uploads", userId);
  try {
    if (fs.existsSync(userUploadsDir)) {
      fs.rmSync(userUploadsDir, { recursive: true, force: true });
    }
  } catch (err) {
    console.error(`[WhatsApp Engine] Failed to wipe uploads dir for user ${userId}:`, err.message);
  }
}

module.exports = {
  getOrCreateUserSession,
  initAllActiveSessions,
  closeAndCleanupUserSession,
  getStatus: (userId) => getOrCreateUserSession(userId).getStatus(),
  requestPairingCode: (userId, phone) => getOrCreateUserSession(userId).requestPairingCode(phone),
  getProfilePicture: (userId, jid) => getOrCreateUserSession(userId).getProfilePicture(jid),
  formatRecipientJid: (userId, recipient) => getOrCreateUserSession(userId).formatRecipientJid(recipient),
  sendWhatsAppMessage: (userId, recipient, text, attachments) => getOrCreateUserSession(userId).sendMessage(recipient, text, attachments),
  logoutSession: (userId) => getOrCreateUserSession(userId).logout()
};
