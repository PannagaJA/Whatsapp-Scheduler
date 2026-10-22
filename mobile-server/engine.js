const {
  default: makeWASocket,
  DisconnectReason,
  fetchLatestBaileysVersion,
  Browsers,
  delay
} = require("@whiskeysockets/baileys");
const pino = require("pino");
const QRCode = require("qrcode");
const path = require("path");
const fs = require("fs");
const { run, get, all, batchUpsertContacts, migrateLegacyData, DB_DIR } = require("./db");
const {
  useEncryptedAuthState,
  readDecryptedJson,
  writeEncryptedJson,
  migrateSessionDirectory,
  getSessionEncryptionKey
} = require("./sessionCrypto");

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
    this.reconnectTimer = null;
    this.lastMessageSentAt = 0;
    this.isExplicitlyLoggedOut = false;
    this.isDestroyed = false;
    this._isInitializing = false;
    this._initPromise = null;
    this._lastInitError = null;
    this.authDir = path.join(SESSIONS_BASE_DIR, userId, "auth_info_baileys");
  }

  async waitForInitialization() {
    if (this._initPromise) {
      try {
        await this._initPromise;
      } catch (_) {}
    }
  }

  ensureAuthDir() {
    if (this.isDestroyed) return false;
    if (!fs.existsSync(this.authDir)) {
      fs.mkdirSync(this.authDir, { recursive: true });
    }
    return true;
  }

  clearReconnectTimer() {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  markSyncing(duration = 5000) {
    if (this.isDestroyed || this.isExplicitlyLoggedOut) return;
    this.isSyncing = true;
    if (this.syncTimeout) clearTimeout(this.syncTimeout);
    this.syncTimeout = setTimeout(() => {
      this.isSyncing = false;
    }, duration);
  }

  async init(force = false) {
    if (this.isDestroyed) {
      return null;
    }
    if (force) {
      this.isExplicitlyLoggedOut = false;
      this._lastInitError = null;
    } else if (this.isExplicitlyLoggedOut) {
      return null;
    }

    if (this._initPromise) return this._initPromise;
    this._isInitializing = true;
    this.connectionStatus = "connecting";
    this.clearReconnectTimer();

    this._initPromise = (async () => {
      try {
      if (this.isDestroyed || (this.isExplicitlyLoggedOut && !force)) return null;
      this.ensureAuthDir();
      const encryptionKey = getSessionEncryptionKey();

      // Safely migrate any plaintext session files before initialization
      try {
        migrateSessionDirectory(this.authDir, encryptionKey);
      } catch (migErr) {
        console.error(`[WhatsApp Engine ${this.userId}] Session migration warning:`, migErr.message);
      }

      // Clear any leftover unconfirmed pairing state before loading auth state so registration can succeed
      const credsFile = path.join(this.authDir, "creds.json");
      if (fs.existsSync(credsFile)) {
        try {
          const raw = readDecryptedJson(credsFile, encryptionKey);
          if (raw && raw.me && !raw.registered && !raw.account) {
            delete raw.me;
            delete raw.pairingCode;
            writeEncryptedJson(credsFile, raw, encryptionKey);
          }
        } catch (_) {}
      }

      const { state, saveCreds } = await useEncryptedAuthState(this.authDir, encryptionKey);
      const { version } = await fetchLatestBaileysVersion();

      if (this.isDestroyed || (this.isExplicitlyLoggedOut && !force)) return null;

      this.connectionStatus = "connecting";

      if (this.sock) {
        const oldSock = this.sock;
        this.sock = null;
        try {
          if (oldSock.ev && typeof oldSock.ev.removeAllListeners === "function") {
            oldSock.ev.removeAllListeners();
          }
          oldSock.end(new Error("Replacing existing socket during init"));
        } catch (_) {}
      }

      this.sock = makeWASocket({
        version,
        logger: pino({ level: "silent" }),
        auth: state,
        browser: Browsers.ubuntu("Chrome"),
        syncFullHistory: process.env.WA_SYNC_FULL_HISTORY === "true",
        generateHighQualityLinkPreview: true,
        qrTimeout: 180000,
        connectTimeoutMs: 60000
      });

      const currentSock = this.sock;

      currentSock.ev.on("creds.update", (...args) => {
        if (this.isDestroyed || this.isExplicitlyLoggedOut) return;
        if (this.sock !== currentSock) return;
        saveCreds(...args);
      });

      currentSock.ev.on("connection.update", async (update) => {
        if (this.isDestroyed) return;
        if (this.sock !== currentSock) return;
        if (this.isExplicitlyLoggedOut) {
          this.connectionStatus = "disconnected";
          this.currentQr = null;
          this.userProfile = null;
          this.isSyncing = false;
          this.clearReconnectTimer();
          return;
        }

        const { connection, lastDisconnect, qr, isNewLogin } = update;

        if (isNewLogin) {
          this.connectionStatus = "connecting";
          this.currentQr = null;
        }

        if (connection === "connecting") {
          this.connectionStatus = "connecting";
        }

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
          const isRestartRequired = statusCode === DisconnectReason.restartRequired; // 515
          // Only true loggedOut (401) is treated as a potential phone-side unlink.
          // badSession (500), multideviceMismatch, 403, 408, 428 are transient network/server glitches and MUST reconnect.
          const isLoggedOut = (statusCode === DisconnectReason.loggedOut || statusCode === 401) && !isRestartRequired;
          const wasRegistered = Boolean(this.userProfile || currentSock.authState?.creds?.registered || currentSock.authState?.creds?.account || currentSock.authState?.creds?.me);

          // Retry on unexpected 401 disconnects across server restarts before giving up
          if (isLoggedOut && wasRegistered) {
            this._loggedOutRetryCount = (this._loggedOutRetryCount || 0) + 1;
            if (this._loggedOutRetryCount < 3) {
              console.log(`[WhatsApp Engine ${this.userId}] Received disconnect (401). Retrying connection (attempt ${this._loggedOutRetryCount}/3)...`);
              if (this.sock === currentSock) {
                this.sock = null;
              }
              try { currentSock.end(new Error("Retrying connection after 401")); } catch (_) {}
              if (!this.isDestroyed && !this.isExplicitlyLoggedOut) {
                this.clearReconnectTimer();
                this.reconnectTimer = setTimeout(() => {
                  this.reconnectTimer = null;
                  if (!this.isDestroyed && !this.isExplicitlyLoggedOut) {
                    this.init().catch(err => console.error(`[WhatsApp Engine ${this.userId}] Reconnect retry error:`, err.message));
                  }
                }, 3000);
              }
              return;
            }

            console.log(`[WhatsApp Engine ${this.userId}] WhatsApp session disconnected (401). Preserving credentials on disk...`);
            this.connectionStatus = "disconnected";
            this._loggedOutRetryCount = 0;
            if (this.sock === currentSock) {
              this.sock = null;
            }
            try { currentSock.end(new Error("Disconnected (401)")); } catch (_) {}
            return;
          }

          const shouldReconnect = !isLoggedOut || isRestartRequired || !wasRegistered;
          this.connectionStatus = shouldReconnect ? "connecting" : "disconnected";
          this.currentQr = null;
          this.userProfile = null;
          this.isSyncing = false;
          this.clearReconnectTimer();

          if (shouldReconnect) {
            if (this.sock === currentSock) {
              this.sock = null;
            }
            try { currentSock.end(new Error("Connection reconnecting")); } catch (_) {}
            if (!this.isDestroyed && !this.isExplicitlyLoggedOut) {
              this.clearReconnectTimer();
              this.reconnectTimer = setTimeout(() => {
                this.reconnectTimer = null;
                if (!this.isDestroyed && !this.isExplicitlyLoggedOut) {
                  this.init().catch(err => console.error(`[WhatsApp Engine ${this.userId}] Reconnect error:`, err.message));
                }
              }, isRestartRequired ? 500 : 3000);
            }
          }
        } else if (connection === "open") {
          this.connectionStatus = "connected";
          this.currentQr = null;
          this.userProfile = this.sock.user || this.sock.authState?.creds?.me;
          this._loggedOutRetryCount = 0;
          console.log(`[WhatsApp Engine ${this.userId}] Connected successfully as: ${this.userProfile?.name || this.userProfile?.id}`);

          // Immediately persist confirmed credentials to creds.json on disk
          try {
            await saveCreds();
          } catch (saveErr) {
            console.error(`[WhatsApp Engine ${this.userId}] Failed persisting creds on connection open:`, saveErr.message);
          }

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
        if (this.isDestroyed || this.isExplicitlyLoggedOut) return;
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
        this._lastInitError = err;
        this.connectionStatus = "disconnected";
        return null;
      } finally {
        this._isInitializing = false;
        this._initPromise = null;
      }
    })();

    return this._initPromise;
  }

  async getStatus(opts = {}) {
    const forceInit = opts.forceInit === true;
    if (this.isDestroyed) {
      return {
        status: "disconnected",
        syncing: false,
        contactCount: 0,
        phonebookContactCount: 0,
        phonebookImported: false,
        qr: null,
        user: null
      };
    }

    if (forceInit) {
      this.isExplicitlyLoggedOut = false;
      const isConnecting = this.connectionStatus === "connecting" || this._isInitializing;
      const hasActiveQr = Boolean(this.sock && (this.connectionStatus === "qr" || this.currentQr));
      const isConnected = this.connectionStatus === "connected";
      if (!isConnecting && !isConnected && !hasActiveQr) {
        this.init(true).catch(() => {});
      }
    } else if (!this.sock && !this._isInitializing && !this.isExplicitlyLoggedOut) {
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

    const hasSavedSession = Boolean(
      this.userProfile || 
      this.sock?.authState?.creds?.registered || 
      (fs.existsSync(path.join(this.authDir, "creds.json")) && !this.isExplicitlyLoggedOut)
    );

    return {
      status: this.connectionStatus,
      syncing: this.isSyncing && count === 0,
      contactCount: count,
      phonebookContactCount: phonebookCount,
      phonebookImported: phonebookImported && phonebookCount > 0,
      qr: this.currentQr,
      error: this._lastInitError ? this._lastInitError.message : null,
      hasSavedSession: hasSavedSession,
      user: (this.userProfile || this.sock?.authState?.creds?.me) ? {
        id: (this.userProfile || this.sock?.authState?.creds?.me).id,
        name: (this.userProfile || this.sock?.authState?.creds?.me).name || (this.userProfile || this.sock?.authState?.creds?.me).id?.split(":")[0] || "My WhatsApp"
      } : null
    };
  }

  async waitForSocketOpen(timeoutMs = 10000) {
    if (this.sock?.ws?.isOpen) return;
    if (this.sock?.waitForSocketOpen) {
      try {
        await this.sock.waitForSocketOpen();
        return;
      } catch (_) {}
    }
    return new Promise((resolve, reject) => {
      if (!this.sock?.ws) return reject(new Error("No active WhatsApp socket."));
      if (this.sock.ws.isOpen) return resolve();
      let cleanup;
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error("Timeout waiting for WhatsApp connection to open."));
      }, timeoutMs);
      const onOpen = () => { cleanup(); resolve(); };
      const onClose = (err) => { cleanup(); reject(err || new Error("Socket closed")); };
      cleanup = () => {
        clearTimeout(timer);
        this.sock?.ws?.off("open", onOpen);
        this.sock?.ws?.off("close", onClose);
        this.sock?.ws?.off("error", onClose);
      };
      this.sock.ws.on("open", onOpen);
      this.sock.ws.on("close", onClose);
      this.sock.ws.on("error", onClose);
    });
  }

  async waitForSocketReadyForPairing(timeoutMs = 15000) {
    if (this.sock?.authState?.creds?.registered) return;
    if (this.sock?.ws?.isOpen && this.connectionStatus === "qr") {
      return;
    }

    return new Promise((resolve, reject) => {
      let isDone = false;
      let trackedSock = null;

      const timer = setTimeout(() => {
        cleanup();
        reject(new Error("Timeout waiting for WhatsApp connection to be ready. Please try again in a few moments."));
      }, timeoutMs);

      const checkInterval = setInterval(() => {
        if (isDone) return;
        if (this.sock?.ws?.isOpen && this.connectionStatus === "qr") {
          cleanup();
          resolve();
          return;
        }
        // If socket was replaced (e.g. after 515 restart), follow the replacement socket
        if (this.sock && this.sock !== trackedSock && this.sock.ev) {
          if (trackedSock?.ev) {
            try { trackedSock.ev.off("connection.update", onUpdate); } catch (_) {}
          }
          trackedSock = this.sock;
          trackedSock.ev.on("connection.update", onUpdate);
        }
      }, 100);

      const onUpdate = (update) => {
        if (isDone) return;
        if (update.qr || (this.sock?.ws?.isOpen && this.connectionStatus === "qr")) {
          cleanup();
          resolve();
        } else if (update.connection === "close") {
          const statusCode = update.lastDisconnect?.error?.output?.statusCode;
          if (statusCode === 515) {
            // Transient restart required; continue waiting and follow the restarted socket
            return;
          }
          cleanup();
          reject(new Error("WhatsApp connection closed while establishing handshake. Please try again."));
        }
      };

      const cleanup = () => {
        if (isDone) return;
        isDone = true;
        clearTimeout(timer);
        clearInterval(checkInterval);
        if (trackedSock?.ev) {
          try { trackedSock.ev.off("connection.update", onUpdate); } catch (_) {}
        }
        if (this.sock?.ev && this.sock !== trackedSock) {
          try { this.sock.ev.off("connection.update", onUpdate); } catch (_) {}
        }
      };

      if (this.sock?.ev) {
        trackedSock = this.sock;
        trackedSock.ev.on("connection.update", onUpdate);
      }

      // Check once more in case it became ready during setup
      if (this.sock?.ws?.isOpen && this.connectionStatus === "qr") {
        cleanup();
        resolve();
      }
    });
  }

  async requestPairingCode(phoneNumber) {
    if (this.isDestroyed) {
      throw new Error("WhatsApp session is destroyed.");
    }
    this.isExplicitlyLoggedOut = false;

    let cleaned = String(phoneNumber || "").replace(/\D/g, "");
    if (cleaned.startsWith("0")) cleaned = cleaned.replace(/^0+/, "");
    
    if (cleaned.length === 10) {
      cleaned = "91" + cleaned;
    }

    if (cleaned.length < 8) throw new Error("Invalid phone number. Please enter a valid 10-digit mobile number.");

    const credsFile = path.join(this.authDir, "creds.json");

    // Wait for any in-progress initialization before continuing
    await this.waitForInitialization();

    const isActivelyConnected = this.connectionStatus === "connected" && this.sock?.ws?.isOpen;
    if (isActivelyConnected) {
      throw new Error("WhatsApp is already actively connected on this account. Please unlink your account first if you want to pair a different device.");
    }

    // Only wipe when resetting an actual previously linked account.
    // For pending/unlinked pairing attempts, preserve stable client keys (registrationId & identityKey).
    // Reusing stable client keys prevents WhatsApp from flagging the companion client as spam and ensures
    // the push notification ("Are you trying to link a device?") is reliably delivered to the phone.
    const hasPreviousLinkedAccount = Boolean(
      this.sock?.authState?.creds?.registered ||
      this.sock?.authState?.creds?.account ||
      this.userProfile
    );

    if (hasPreviousLinkedAccount && !isActivelyConnected) {
      try {
        if (this.sock) {
          this.sock.end(new Error("Resetting previous linked account for fresh pairing"));
          this.sock = null;
        }
        fs.rmSync(this.authDir, { recursive: true, force: true });
      } catch (_) {}
      await this.init(true);
    } else if (!this.sock || !this.sock.ws || this.connectionStatus === "disconnected") {
      await this.init(false);
    } else {
      // Re-use current socket & stable identity keys! Clear transient pairing fields so a fresh code can be requested
      if (this.sock?.authState?.creds) {
        delete this.sock.authState.creds.me;
        delete this.sock.authState.creds.pairingCode;
      }
    }

    const getInitErrorMessage = () => {
      if (this._lastInitError?.message) {
        return `WhatsApp engine not initialized for this account: ${this._lastInitError.message}`;
      }
      return "WhatsApp engine not initialized for this account.";
    };

    if (!this.sock) {
      throw new Error(getInitErrorMessage());
    }

    // Wait until the socket is ready for companion pairing (registration handshake complete)
    try {
      await this.waitForSocketReadyForPairing(15000);
    } catch (_) {
      await this.init(true);
      if (!this.sock) {
        throw new Error(getInitErrorMessage());
      }
      await this.waitForSocketReadyForPairing(15000);
    }

    if (!this.sock) {
      throw new Error(getInitErrorMessage());
    }

    if (this.sock.authState?.creds?.registered && this.connectionStatus === "connected") {
      throw new Error("WhatsApp is already registered/linked on this account.");
    }

    try {
      const code = await this.sock.requestPairingCode(cleaned);
      return code;
    } catch (err) {
      // Revert incomplete credentials so auth directory isn't left corrupted for future QR/pairing attempts
      if (this.sock?.authState?.creds?.me && !this.sock?.authState?.creds?.registered && !this.sock?.authState?.creds?.account) {
        delete this.sock.authState.creds.me;
        delete this.sock.authState.creds.pairingCode;
        if (fs.existsSync(credsFile)) {
          try {
            const encryptionKey = getSessionEncryptionKey();
            const raw = readDecryptedJson(credsFile, encryptionKey);
            if (raw && raw.me && !raw.registered && !raw.account) {
              delete raw.me;
              delete raw.pairingCode;
              writeEncryptedJson(credsFile, raw, encryptionKey);
            }
          } catch (_) {}
        }
      }
      throw err;
    }
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

    // Responsible Messaging Rate Pacing & Jitter (SEC-005)
    const minDelayMs = parseInt(process.env.MESSAGE_MIN_DELAY_MS !== undefined ? process.env.MESSAGE_MIN_DELAY_MS : (process.env.NODE_ENV === "test" ? "0" : "1000"), 10);
    const maxDelayMs = parseInt(process.env.MESSAGE_MAX_DELAY_MS !== undefined ? process.env.MESSAGE_MAX_DELAY_MS : (process.env.NODE_ENV === "test" ? "0" : "3000"), 10);

    if (maxDelayMs > 0 && this.lastMessageSentAt > 0) {
      const now = Date.now();
      const elapsed = now - this.lastMessageSentAt;
      const targetSpacing = minDelayMs + (maxDelayMs > minDelayMs ? Math.floor(Math.random() * (maxDelayMs - minDelayMs + 1)) : 0);
      if (elapsed < targetSpacing) {
        await delay(targetSpacing - elapsed);
      }
    }
    this.lastMessageSentAt = Date.now();

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
    this.isExplicitlyLoggedOut = true;
    this.clearReconnectTimer();
    if (this.syncTimeout) {
      clearTimeout(this.syncTimeout);
      this.syncTimeout = null;
    }
    if (this.sock) {
      const sockToClose = this.sock;
      this.sock = null;
      try { await sockToClose.logout(); } catch (_) {
        try { sockToClose.end(new Error("Logged out")); } catch (_) {}
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
    // Explicitly do NOT automatically reconnect after logout
    return { success: true };
  }

  async destroy() {
    this.isDestroyed = true;
    this.isExplicitlyLoggedOut = true;
    this.clearReconnectTimer();
    if (this.syncTimeout) {
      clearTimeout(this.syncTimeout);
      this.syncTimeout = null;
    }
    if (this.sock) {
      const sockToClose = this.sock;
      this.sock = null;
      try { await sockToClose.logout(); } catch (_) {
        try { sockToClose.end(new Error("Session destroyed")); } catch (_) {}
      }
    }
    this.connectionStatus = "disconnected";
    this.userProfile = null;
    this.currentQr = null;
    this.isSyncing = false;
  }
}

// Session Registry: Map<userId, UserWhatsAppSession>
const userSessions = new Map();

function getOrCreateUserSession(userId) {
  if (!userId) throw new Error("User ID is required for WhatsApp session operation");
  if (!userSessions.has(userId)) {
    const session = new UserWhatsAppSession(userId);
    userSessions.set(userId, session);
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
        try {
          migrateSessionDirectory(targetDir, getSessionEncryptionKey());
        } catch (_) {}
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
    const encryptionKey = getSessionEncryptionKey();
    if (!fs.existsSync(SESSIONS_BASE_DIR)) return;

    // Load registered user IDs to instantly restore valid user sessions without scanning dead test dirs
    let registeredUserIds = null;
    try {
      const users = await all("SELECT id FROM users");
      if (users && users.length > 0) {
        registeredUserIds = new Set(users.map(u => u.id));
      }
    } catch (_) {}

    const sessionUserDirs = fs.readdirSync(SESSIONS_BASE_DIR);
    for (const userId of sessionUserDirs) {
      if (registeredUserIds && !registeredUserIds.has(userId)) {
        continue;
      }
      const authDir = path.join(SESSIONS_BASE_DIR, userId, "auth_info_baileys");
      const credsFile = path.join(authDir, "creds.json");
      if (fs.existsSync(credsFile)) {
        try {
          migrateSessionDirectory(authDir, encryptionKey);
          const creds = readDecryptedJson(credsFile, encryptionKey);
          if (creds && (creds.registered || creds.me || creds.account)) {
            console.log(`[WhatsApp Engine ${userId}] Resuming authenticated WhatsApp session on startup...`);
            const session = getOrCreateUserSession(userId);
            session.init().catch(err => {
              console.error(`[WhatsApp Engine ${userId}] Error initializing session on startup:`, err.message);
            });
          }
        } catch (e) {
          console.error(`[WhatsApp Engine ${userId}] Error restoring creds on boot:`, e.message);
        }
      }
    }
  } catch (err) {
    console.error("[WhatsApp Engine] Error booting active sessions:", err.message);
  }
}

// Gracefully close all active sockets during server restart or shutdown
async function closeAllActiveSessions() {
  const closeTasks = [];
  for (const [userId, session] of userSessions.entries()) {
    session.clearReconnectTimer();
    if (session.sock) {
      const sock = session.sock;
      session.sock = null;
      closeTasks.push(new Promise((resolve) => {
        try {
          if (sock.ev && typeof sock.ev.removeAllListeners === "function") {
            sock.ev.removeAllListeners();
          }
          if (sock.ws && sock.ws.isOpen) {
            sock.end(undefined);
          }
        } catch (_) {}
        resolve();
      }));
    }
  }
  await Promise.all(closeTasks);
  await new Promise(r => setTimeout(r, 200));
}

// Cleanup session resources on user deletion
async function closeAndCleanupUserSession(userId) {
  if (!userId) return;
  const session = userSessions.get(userId);
  if (session) {
    await session.destroy();
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
  closeAllActiveSessions,
  closeAndCleanupUserSession,
  getStatus: (userId, opts) => getOrCreateUserSession(userId).getStatus(opts),
  requestPairingCode: (userId, phone) => getOrCreateUserSession(userId).requestPairingCode(phone),
  getProfilePicture: (userId, jid) => getOrCreateUserSession(userId).getProfilePicture(jid),
  formatRecipientJid: (userId, recipient) => getOrCreateUserSession(userId).formatRecipientJid(recipient),
  sendWhatsAppMessage: (userId, recipient, text, attachments) => getOrCreateUserSession(userId).sendMessage(recipient, text, attachments),
  logoutSession: (userId) => getOrCreateUserSession(userId).logout()
};
