const express = require("express");
const multer = require("multer");
const cors = require("cors");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const { db, run, get, all, DB_DIR } = require("./db");
const {
  initWhatsAppEngine,
  getStatus,
  requestPairingCode,
  getProfilePicture,
  formatRecipientJid,
  sendWhatsAppMessage,
  logoutSession
} = require("./engine");
const { startScheduler } = require("./scheduler");

const app = express();
const PORT = process.env.PORT || 3000;

// Setup Storage for Attachments
const UPLOADS_DIR = path.join(DB_DIR, "uploads");
if (!fs.existsSync(UPLOADS_DIR)) {
  fs.mkdirSync(UPLOADS_DIR, { recursive: true });
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOADS_DIR),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, `${Date.now()}-${crypto.randomBytes(4).toString("hex")}${ext}`);
  }
});
const upload = multer({ storage, limits: { fileSize: 50 * 1024 * 1024 } }); // 50MB limit

// In-Memory Staged Files Cache (For Share Target API)
const shareCache = new Map();

// Middleware
app.use(cors());
app.use((req, res, next) => {
  res.setHeader("X-Frame-Options", "SAMEORIGIN");
  res.setHeader("Content-Security-Policy", "frame-ancestors 'self'");
  next();
});
app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ extended: true, limit: "50mb" }));
app.use(express.static(path.join(__dirname, "pwa")));

// Web Share Target API Endpoint (Android Native Intent Receiver)
app.post("/share-target", upload.array("media", 10), (req, res) => {
  const shareId = crypto.randomUUID();
  const shareData = {
    title: req.body.title || "",
    text: req.body.text || "",
    url: req.body.url || "",
    files: (req.files || []).map(f => ({
      name: f.originalname,
      filename: f.filename,
      size: f.size,
      type: f.mimetype,
      path: f.path
    }))
  };

  shareCache.set(shareId, shareData);
  // Auto-clean cache after 15 minutes
  setTimeout(() => shareCache.delete(shareId), 15 * 60 * 1000);

  res.redirect(`/?shared=1&shareId=${shareId}`);
});

// API: Retrieve Shared Data
app.get("/api/shared/:shareId", (req, res) => {
  const shareId = req.params.shareId;
  const data = shareCache.get(shareId);
  if (data) {
    shareCache.delete(shareId);
    res.json({ success: true, ...data });
  } else {
    res.status(404).json({ success: false, error: "Share data expired or not found" });
  }
});

// API: Status & Diagnostics (returns real-time syncing progress & contact count)

// Cache resolved GitHub release for 15 seconds to be ultra fast and bypass rate limits
let cachedRelease = { version: null, checkedAt: 0 };

// API: App Version & Direct APK Download Info
app.get("/api/version", async (req, res) => {
  const now = Date.now();
  if (cachedRelease.version && (now - cachedRelease.checkedAt < 15000)) {
    return res.json({
      success: true,
      version: cachedRelease.version,
      name: "WhatsApp Scheduler",
      downloadUrl: `https://github.com/PannagaJA/Whatsapp-Scheduler/releases/download/${cachedRelease.version}/WhatsApp-Scheduler.apk`
    });
  }

  try {
    const ghRes = await fetch("https://github.com/PannagaJA/Whatsapp-Scheduler/releases/latest", {
      redirect: "manual",
      headers: { "User-Agent": "Mozilla/5.0 WhatsAppScheduler" }
    });
    const location = ghRes.headers.get("location");
    if (location) {
      const match = location.match(/releases\/tag\/(v?[0-9.]+)/i);
      if (match && match[1]) {
        const ver = match[1];
        cachedRelease = { version: ver, checkedAt: now };
        return res.json({
          success: true,
          version: ver,
          name: "WhatsApp Scheduler",
          downloadUrl: `https://github.com/PannagaJA/Whatsapp-Scheduler/releases/download/${ver}/WhatsApp-Scheduler.apk`
        });
      }
    }
  } catch (err) {
    console.error("Failed to check latest release tag:", err.message);
  }

  res.json({
    success: true,
    version: cachedRelease.version || "1.0.0",
    name: "WhatsApp Scheduler",
    downloadUrl: "https://github.com/PannagaJA/Whatsapp-Scheduler/releases/latest/download/WhatsApp-Scheduler.apk"
  });
});

app.get("/api/status", async (req, res) => {
  try {
    const status = await getStatus();
    res.json({ success: true, ...status });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// API: Dedicated QR Code Endpoint
app.get("/api/qr", async (req, res) => {
  try {
    const status = await getStatus();
    res.json({ 
      success: true, 
      qr: status.qr || null, 
      status: status.status, 
      connected: status.status === "connected" 
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// API: Request 8-digit Pairing Code (accepts phoneNumber or phone)
app.post("/api/pair-code", async (req, res) => {
  try {
    const phoneNumber = req.body.phoneNumber || req.body.phone;
    if (!phoneNumber) {
      return res.status(400).json({ success: false, error: "Phone number is required (e.g. 919876543210)" });
    }
    const code = await requestPairingCode(phoneNumber);
    res.json({ success: true, code });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// API: Logout
app.post("/api/logout", async (req, res) => {
  try {
    await logoutSession();
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// API: List Contacts (Only returns contacts if phonebook is imported or groups)
app.get("/api/contacts", async (req, res) => {
  try {
    const setting = await get("SELECT value FROM settings WHERE key = 'phonebook_imported'");
    const phonebookImported = setting ? setting.value === "1" : false;

    if (!phonebookImported) {
      return res.json({ success: true, contacts: [], count: 0, phonebookImported: false });
    }

    const contacts = await all(`
      SELECT jid, 
             coalesce(nullif(name, ''), '') as name, 
             phone, 
             is_group 
      FROM contacts 
      WHERE jid NOT LIKE '%@lid' AND (jid LIKE '%@s.whatsapp.net' OR jid LIKE '%@g.us')
        AND (source = 'phonebook' OR is_group = 1 OR (nullif(name, '') IS NOT NULL AND name != 'WhatsApp' AND name != 'Contact'))
      ORDER BY is_group ASC, (CASE WHEN nullif(name, '') IS NOT NULL THEN 0 ELSE 1 END), updated_at DESC
      LIMIT 5000
    `);
    res.json({ success: true, contacts, count: contacts.length, phonebookImported: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// API: Bulk Import Contacts (from Phonebook sync)
app.post("/api/contacts/import", async (req, res) => {
  try {
    const { contacts } = req.body;
    if (!Array.isArray(contacts) || contacts.length === 0) {
      return res.status(400).json({ success: false, error: "No contacts provided" });
    }

    const { batchUpsertContacts } = require("./db");
    const batch = [];

    for (const c of contacts) {
      const name = (c.name || "").trim();
      let rawPhone = String(c.phone || c.tel || "").replace(/\D/g, "");
      if (!rawPhone || rawPhone.length < 7) continue;

      let normalizedPhone = rawPhone;
      if (rawPhone.length === 10) {
        normalizedPhone = "91" + rawPhone;
      } else if (rawPhone.length === 11 && rawPhone.startsWith("0")) {
        normalizedPhone = "91" + rawPhone.slice(1);
      }

      const jid = `${normalizedPhone}@s.whatsapp.net`;
      batch.push({
        jid,
        name,
        phone: normalizedPhone,
        is_group: 0
      });
    }

    const inserted = await batchUpsertContacts(batch, "phonebook");
    await run("INSERT INTO settings (key, value) VALUES ('phonebook_imported', '1') ON CONFLICT(key) DO UPDATE SET value = '1'");
    res.json({ success: true, count: inserted });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// API: Contact / Group Profile Picture
app.get("/api/profile-pic", async (req, res) => {
  try {
    const { jid } = req.query;
    if (!jid) return res.status(400).json({ success: false, url: null });
    const url = await getProfilePicture(jid);
    res.json({ success: true, url });
  } catch (err) {
    res.json({ success: false, url: null });
  }
});

// API: List Scheduled Messages
app.get("/api/schedules", async (req, res) => {
  res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
  try {
    const schedules = await all(`
      SELECT s.*,
             (
               SELECT coalesce(nullif(c.name, ''), '')
               FROM contacts c
               WHERE (c.jid IS NOT NULL AND c.jid != '' AND (c.jid = s.jid OR c.jid = s.recipient))
                  OR (c.phone IS NOT NULL AND c.phone != '' AND (c.phone = s.recipient OR s.recipient LIKE '%' || c.phone || '%'))
               ORDER BY (CASE WHEN nullif(c.name, '') IS NOT NULL AND c.name != 'WhatsApp' THEN 0 ELSE 1 END), c.updated_at DESC
               LIMIT 1
             ) as contact_name
      FROM schedules s
      ORDER BY s.scheduled_at ASC
    `);
    const formatted = schedules.map(s => {
      let attachments = [];
      try { attachments = JSON.parse(s.attachments); } catch (_) {}
      return { ...s, attachments };
    });
    res.json({ success: true, schedules: formatted });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// API: Create Schedule (Supports direct JSON or Multipart file uploads)
app.post("/api/schedules", upload.array("attachments", 10), async (req, res) => {
  try {
    const id = crypto.randomUUID();
    const rawRecipient = (req.body.recipient || "").trim();
    const text = (req.body.text || "").trim();
    const scheduledAt = parseInt(req.body.scheduledAt, 10);

    if (!rawRecipient) return res.status(400).json({ success: false, error: "Recipient is required" });
    if (!scheduledAt || scheduledAt <= Date.now()) {
      return res.status(400).json({ success: false, error: "Scheduled time must be in the future" });
    }

    // Process attached files
    const attachments = [];
    if (req.files && req.files.length > 0) {
      for (const f of req.files) {
        attachments.push({
          name: f.originalname,
          filename: f.filename,
          size: f.size,
          type: f.mimetype,
          path: f.path
        });
      }
    }

    // If existing staged files were referenced from shareCache
    if (req.body.existingFiles) {
      try {
        const parsed = JSON.parse(req.body.existingFiles);
        if (Array.isArray(parsed)) {
          attachments.push(...parsed);
        }
      } catch (_) {}
    }

    if (!text && attachments.length === 0) {
      return res.status(400).json({ success: false, error: "Please enter a message or attach a file" });
    }

    let resolvedJid = null;
    try {
      resolvedJid = await formatRecipientJid(rawRecipient);
    } catch (_) {}

    await run(`
      INSERT INTO schedules (id, recipient, jid, text, attachments, scheduled_at, status, created_at)
      VALUES (?, ?, ?, ?, ?, ?, 'scheduled', ?)
    `, [id, rawRecipient, resolvedJid, text, JSON.stringify(attachments), scheduledAt, Date.now()]);

    res.json({
      success: true,
      schedule: { id, recipient: rawRecipient, jid: resolvedJid, text, attachments, scheduledAt, status: "scheduled" }
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// API: Delete / Cancel Schedule
app.delete("/api/schedules/:id", async (req, res) => {
  try {
    const schedule = await get("SELECT * FROM schedules WHERE id = ?", [req.params.id]);
    if (!schedule) return res.status(404).json({ success: false, error: "Schedule not found" });

    // Remove files
    if (schedule.attachments) {
      try {
        const files = JSON.parse(schedule.attachments);
        for (const f of files) {
          if (f.path && fs.existsSync(f.path)) fs.unlinkSync(f.path);
        }
      } catch (_) {}
    }

    await run("DELETE FROM schedules WHERE id = ?", [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Fallback to PWA index
app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "pwa", "index.html"));
});

// Start Server & Engines
app.listen(PORT, async () => {
  console.log(`\n======================================================`);
  console.log(`📱 WhatsApp Scheduler Mobile PWA & Server running!`);
  console.log(`🚀 Access Dashboard: http://localhost:${PORT}`);
  console.log(`======================================================\n`);

  try {
    await initWhatsAppEngine();
    startScheduler(5000);
  } catch (err) {
    console.error("Failed to initialize WhatsApp engine on boot:", err);
  }
});
