const express = require("express");
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const { db, initDb, run, get, all, batchUpsertContacts, DB_DIR } = require("./db");
const {
  requireAuth,
  requireAdmin,
  isSetupRequired,
  isPublicRegistrationAllowed,
  registerUser,
  createUserByAdmin,
  listUsers,
  deleteUserAccount,
  authenticateUser,
  deleteSession,
  bootstrapAdminFromEnv
} = require("./auth");
const {
  initAllActiveSessions,
  getOrCreateUserSession,
  getStatus,
  requestPairingCode,
  getProfilePicture,
  formatRecipientJid,
  sendWhatsAppMessage,
  logoutSession
} = require("./engine");
const { startScheduler, safeDeleteAttachment, isPathContained } = require("./scheduler");
const { validateUploadedFile, sanitizeFilename } = require("./fileValidator");
const {
  loginLimiter,
  registerLimiter,
  pairingLimiter,
  contactImportLimiter,
  generalApiLimiter
} = require("./rateLimiter");

const app = express();
const PORT = process.env.PORT || 3000;

// Trust reverse proxy (Render load balancer) for accurate client IP resolution
app.set("trust proxy", 1);

// Setup Storage for Attachments
const UPLOADS_DIR = path.join(DB_DIR, "uploads");
if (!fs.existsSync(UPLOADS_DIR)) {
  fs.mkdirSync(UPLOADS_DIR, { recursive: true });
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const userFolder = (req.user && req.user.id) ? path.join(UPLOADS_DIR, req.user.id) : UPLOADS_DIR;
    if (!fs.existsSync(userFolder)) {
      fs.mkdirSync(userFolder, { recursive: true });
    }
    cb(null, userFolder);
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase().replace(/[^a-zA-Z0-9.]/g, "");
    cb(null, `${Date.now()}-${crypto.randomBytes(8).toString("hex")}${ext}`);
  }
});
const upload = multer({
  storage,
  limits: {
    fileSize: 25 * 1024 * 1024, // 25MB max limit per file (SEC-007)
    files: 10
  }
});

// Middleware for File Validation and Sanitization (SEC-007)
function validateAndProcessUploads(req, res, next) {
  if (req.files && req.files.length > 0) {
    for (const f of req.files) {
      try {
        validateUploadedFile(f);
      } catch (err) {
        // Cleanup all uploaded files in this request on validation error
        for (const file of req.files) {
          if (file.path && fs.existsSync(file.path)) {
            try { fs.unlinkSync(file.path); } catch (_) {}
          }
        }
        return res.status(400).json({ success: false, error: `Invalid attachment: ${err.message}` });
      }
    }
  }
  next();
}

// In-Memory Staged Files Cache (For Share Target API)
const shareCache = new Map();

// Strict CORS Middleware (SEC-009)
const rawAllowedOrigins = process.env.ALLOWED_ORIGINS || process.env.RENDER_EXTERNAL_URL || "https://my-whatsapp-scheduler.onrender.com,http://localhost:3000,http://127.0.0.1:3000";
const allowedOriginsSet = new Set(rawAllowedOrigins.split(",").map(o => o.trim().toLowerCase()).filter(Boolean));

app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin) {
    const normalizedOrigin = origin.trim().toLowerCase();
    if (allowedOriginsSet.has(normalizedOrigin)) {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Access-Control-Allow-Credentials", "true");
      res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
    } else {
      if (req.method === "OPTIONS") {
        return res.status(403).json({ success: false, error: "CORS: Origin not permitted" });
      }
    }
  }
  if (req.method === "OPTIONS") {
    return res.status(204).end();
  }
  next();
});

// Security Headers
app.use((req, res, next) => {
  res.setHeader("X-Frame-Options", "SAMEORIGIN");
  res.setHeader("Content-Security-Policy", "frame-ancestors 'self'");
  res.setHeader("X-Content-Type-Options", "nosniff");
  next();
});

// Justified body limits: file attachments stream via Multer to disk; JSON API payloads are capped at 2MB (SEC-007)
app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: true, limit: "2mb" }));
app.use(express.static(path.join(__dirname, "pwa")));

// --- Application Authentication Routes (Protected by Auth Limiter) ---
app.get("/api/auth/setup-status", async (req, res) => {
  try {
    const isSetup = await isSetupRequired();
    res.json({
      success: true,
      setupRequired: isSetup,
      allowRegistration: isSetup || isPublicRegistrationAllowed()
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post("/api/auth/register", registerLimiter, async (req, res) => {
  try {
    const { username, password } = req.body;
    const result = await registerUser(username, password);
    // Boot Baileys session asynchronously for new user
    getOrCreateUserSession(result.user.id);
    res.json({ success: true, ...result });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

app.post("/api/auth/login", loginLimiter, async (req, res) => {
  try {
    const { username, password } = req.body;
    const result = await authenticateUser(username, password);
    // Ensure Baileys session is active
    getOrCreateUserSession(result.user.id);
    res.json({ success: true, ...result });
  } catch (err) {
    res.status(401).json({ success: false, error: err.message });
  }
});

app.post("/api/auth/logout", requireAuth, async (req, res) => {
  try {
    if (req.sessionToken) {
      await deleteSession(req.sessionToken);
    }
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get("/api/auth/me", requireAuth, (req, res) => {
  res.json({ success: true, user: req.user });
});

// --- Administrator User Management Routes (SEC-004 / Multi-Tenant Admin) ---
app.get("/api/admin/users", requireAuth, requireAdmin, async (req, res) => {
  try {
    const users = await listUsers();
    const enriched = await Promise.all(users.map(async (u) => {
      const status = await getStatus(u.id);
      return {
        id: u.id,
        username: u.username,
        role: u.role,
        created_at: u.created_at,
        whatsappStatus: status.status
      };
    }));
    res.json({ success: true, users: enriched });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post("/api/admin/users", requireAuth, requireAdmin, async (req, res) => {
  try {
    const { username, password, role } = req.body;
    const user = await createUserByAdmin(username, password, role);
    // Boot Baileys session asynchronously for created user
    getOrCreateUserSession(user.id);
    res.json({ success: true, user });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

app.delete("/api/admin/users/:id", requireAuth, requireAdmin, async (req, res) => {
  try {
    const targetId = req.params.id;
    if (targetId === req.user.id) {
      return res.status(400).json({ success: false, error: "Cannot delete your own administrator account" });
    }
    const targetUser = await get("SELECT id, role FROM users WHERE id = ?", [targetId]);
    if (!targetUser) {
      return res.status(404).json({ success: false, error: "User not found" });
    }
    if (targetUser.role === "admin") {
      const adminCountRow = await get("SELECT COUNT(*) as count FROM users WHERE role = 'admin'");
      if ((adminCountRow?.count || 0) <= 1) {
        return res.status(400).json({ success: false, error: "Cannot delete the last administrator account" });
      }
    }
    await logoutSession(targetId);
    await deleteUserAccount(targetId);
    const userUploadDir = path.join(UPLOADS_DIR, targetId);
    if (fs.existsSync(userUploadDir)) {
      try { fs.rmSync(userUploadDir, { recursive: true, force: true }); } catch (_) {}
    }
    res.json({ success: true });
  } catch (err) {
    const status = err.message.includes("last administrator") ? 400 : 500;
    res.status(status).json({ success: false, error: err.message });
  }
});

// Web Share Target API Endpoint (Android Native Intent Receiver)
app.post("/share-target", requireAuth, upload.array("media", 10), validateAndProcessUploads, (req, res) => {
  const shareId = crypto.randomUUID();
  const shareData = {
    userId: req.user.id,
    title: req.body.title || "",
    text: req.body.text || "",
    url: req.body.url || "",
    files: (req.files || []).map(f => ({
      name: sanitizeFilename(f.originalname),
      filename: f.filename,
      size: f.size,
      type: f.mimetype,
      path: f.path
    }))
  };

  shareCache.set(shareId, shareData);
  // Auto-clean cache and unretrieved staged files after 15 minutes
  setTimeout(() => {
    const expired = shareCache.get(shareId);
    if (expired) {
      shareCache.delete(shareId);
      if (expired.files && expired.userId) {
        const userFolder = path.join(UPLOADS_DIR, expired.userId);
        for (const f of expired.files) {
          if (f.path) safeDeleteAttachment(f.path, userFolder);
        }
      }
    }
  }, 15 * 60 * 1000);

  res.redirect(`/?shared=1&shareId=${shareId}`);
});

// API: Retrieve Shared Data (Strict user ownership check)
app.get("/api/shared/:shareId", requireAuth, (req, res) => {
  const shareId = req.params.shareId;
  const data = shareCache.get(shareId);
  if (data && data.userId === req.user.id) {
    shareCache.delete(shareId);
    const { userId, ...safeData } = data;
    res.json({ success: true, ...safeData });
  } else {
    res.status(404).json({ success: false, error: "Share data expired or not found" });
  }
});

// Cache resolved GitHub release for 15 seconds to be ultra fast and bypass rate limits
let cachedRelease = { version: null, checkedAt: 0 };

// API: App Version & Direct APK Download Info (Public)
app.get("/api/version", async (req, res) => {
  const now = Date.now();
  if (cachedRelease.version && (now - cachedRelease.checkedAt < 15000)) {
    return res.json({
      success: true,
      version: cachedRelease.version,
      name: "WhatsApp Scheduler",
      downloadUrl: `https://github.com/PannagaJA/Whatsapp-Scheduler/releases/download/${cachedRelease.version}/WhatsApp-Scheduler-${cachedRelease.version}.apk`
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
          downloadUrl: `https://github.com/PannagaJA/Whatsapp-Scheduler/releases/download/${ver}/WhatsApp-Scheduler-${ver}.apk`
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
    downloadUrl: "https://github.com/PannagaJA/Whatsapp-Scheduler/releases/download/v1.0.0/WhatsApp-Scheduler-v1.0.0.apk"
  });
});

// --- General API Routes (Protected by General API Limiter & requireAuth) ---
app.use("/api", generalApiLimiter);

app.get("/api/status", requireAuth, async (req, res) => {
  try {
    const status = await getStatus(req.user.id);
    res.json({ success: true, ...status });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// API: Dedicated QR Code Endpoint
app.get("/api/qr", requireAuth, async (req, res) => {
  try {
    const status = await getStatus(req.user.id, { forceInit: true });
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

// API: Request 8-digit Pairing Code (Protected by Pairing Limiter)
app.post("/api/pair-code", requireAuth, pairingLimiter, async (req, res) => {
  try {
    const phoneNumber = req.body.phoneNumber || req.body.phone;
    if (!phoneNumber) {
      return res.status(400).json({ success: false, error: "Phone number is required (e.g. 919876543210)" });
    }
    const code = await requestPairingCode(req.user.id, phoneNumber);
    res.json({ success: true, code });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// API: Logout
app.post("/api/logout", requireAuth, async (req, res) => {
  try {
    await logoutSession(req.user.id);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// API: List Contacts (Only returns contacts if phonebook is imported or groups for this user)
app.get("/api/contacts", requireAuth, async (req, res) => {
  try {
    const setting = await get("SELECT value FROM settings WHERE user_id = ? AND key = 'phonebook_imported'", [req.user.id]);
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
      WHERE user_id = ?
        AND jid NOT LIKE '%@lid' AND (jid LIKE '%@s.whatsapp.net' OR jid LIKE '%@g.us')
        AND (source = 'phonebook' OR is_group = 1 OR (nullif(name, '') IS NOT NULL AND name != 'WhatsApp' AND name != 'Contact'))
      ORDER BY is_group ASC, (CASE WHEN nullif(name, '') IS NOT NULL THEN 0 ELSE 1 END), updated_at DESC
      LIMIT 5000
    `, [req.user.id]);
    res.json({ success: true, contacts, count: contacts.length, phonebookImported: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// API: Bulk Import Contacts (Protected by Contact Import Limiter)
app.post("/api/contacts/import", requireAuth, contactImportLimiter, async (req, res) => {
  try {
    const { contacts } = req.body;
    if (!Array.isArray(contacts) || contacts.length === 0) {
      return res.status(400).json({ success: false, error: "No contacts provided" });
    }

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

    const inserted = await batchUpsertContacts(req.user.id, batch, "phonebook");
    await run(
      "INSERT INTO settings (user_id, key, value) VALUES (?, 'phonebook_imported', '1') ON CONFLICT(user_id, key) DO UPDATE SET value = '1'",
      [req.user.id]
    );
    res.json({ success: true, count: inserted });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// API: Contact / Group Profile Picture
app.get("/api/profile-pic", requireAuth, async (req, res) => {
  try {
    const { jid } = req.query;
    if (!jid) return res.status(400).json({ success: false, url: null });
    const url = await getProfilePicture(req.user.id, jid);
    res.json({ success: true, url });
  } catch (err) {
    res.json({ success: false, url: null });
  }
});

// API: List Scheduled Messages (Scoped to user_id)
app.get("/api/schedules", requireAuth, async (req, res) => {
  res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
  try {
    const schedules = await all(`
      SELECT s.*,
             (
               SELECT coalesce(nullif(c.name, ''), '')
               FROM contacts c
               WHERE c.user_id = s.user_id
                 AND ((c.jid IS NOT NULL AND c.jid != '' AND (c.jid = s.jid OR c.jid = s.recipient))
                      OR (c.phone IS NOT NULL AND c.phone != '' AND (c.phone = s.recipient OR s.recipient LIKE '%' || c.phone || '%')))
               ORDER BY (CASE WHEN nullif(c.name, '') IS NOT NULL AND c.name != 'WhatsApp' THEN 0 ELSE 1 END), c.updated_at DESC
               LIMIT 1
             ) as contact_name
      FROM schedules s
      WHERE s.user_id = ?
      ORDER BY s.scheduled_at ASC
    `, [req.user.id]);
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

// API: Create Schedule (Supports direct JSON or Multipart file uploads with validation)
app.post("/api/schedules", requireAuth, upload.array("attachments", 10), validateAndProcessUploads, async (req, res) => {
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
          name: sanitizeFilename(f.originalname),
          filename: f.filename,
          size: f.size,
          type: f.mimetype,
          path: f.path
        });
      }
    }

    // If existing staged files were referenced from shareCache, validate containment inside user upload directory
    if (req.body.existingFiles) {
      try {
        const parsed = JSON.parse(req.body.existingFiles);
        const userUploadDir = path.join(UPLOADS_DIR, req.user.id);
        if (Array.isArray(parsed)) {
          for (const item of parsed) {
            if (item.path && isPathContained(item.path, userUploadDir)) {
              attachments.push(item);
            }
          }
        }
      } catch (_) {}
    }

    if (!text && attachments.length === 0) {
      return res.status(400).json({ success: false, error: "Please enter a message or attach a file" });
    }

    let resolvedJid = null;
    try {
      resolvedJid = await formatRecipientJid(req.user.id, rawRecipient);
    } catch (_) {}

    await run(`
      INSERT INTO schedules (id, user_id, recipient, jid, text, attachments, scheduled_at, status, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'scheduled', ?)
    `, [id, req.user.id, rawRecipient, resolvedJid, text, JSON.stringify(attachments), scheduledAt, Date.now()]);

    res.json({
      success: true,
      schedule: { id, user_id: req.user.id, recipient: rawRecipient, jid: resolvedJid, text, attachments, scheduledAt, status: "scheduled" }
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// API: Delete / Cancel Schedule (Strict ownership & path containment)
app.delete("/api/schedules/:id", requireAuth, async (req, res) => {
  try {
    const schedule = await get("SELECT * FROM schedules WHERE id = ? AND user_id = ?", [req.params.id, req.user.id]);
    if (!schedule) return res.status(404).json({ success: false, error: "Schedule not found" });

    // Remove files safely with user-scoped path containment
    const userUploadDir = path.join(UPLOADS_DIR, req.user.id);
    if (schedule.attachments) {
      try {
        const files = JSON.parse(schedule.attachments);
        for (const f of files) {
          if (f.path) {
            safeDeleteAttachment(f.path, userUploadDir);
            safeDeleteAttachment(f.path, UPLOADS_DIR);
          }
        }
      } catch (_) {}
    }

    await run("DELETE FROM schedules WHERE id = ? AND user_id = ?", [req.params.id, req.user.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Fallback to PWA index
app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "pwa", "index.html"));
});

// Production Configuration Gate (Requirement C)
function validateProductionConfig() {
  if (process.env.NODE_ENV === "production") {
    const raw = process.env.ALLOWED_ORIGINS || process.env.RENDER_EXTERNAL_URL || "";
    if (!raw.trim()) {
      throw new Error("PRODUCTION CONFIG ERROR: ALLOWED_ORIGINS (or RENDER_EXTERNAL_URL) must be set in production");
    }
    const origins = raw.split(",").map(o => o.trim().toLowerCase());
    const hasLocalhost = origins.some(o => o.includes("localhost") || o.includes("127.0.0.1"));
    if (hasLocalhost) {
      throw new Error("PRODUCTION CONFIG ERROR: ALLOWED_ORIGINS cannot permit localhost/127.0.0.1 in production");
    }
  }
  return true;
}

// Start Server & Engines
if (require.main === module) {
  try {
    validateProductionConfig();
  } catch (err) {
    console.error(`\n❌ [Fatal Startup Error] ${err.message}\n`);
    process.exit(1);
  }

  initDb().then(async () => {
    try {
      await bootstrapAdminFromEnv();
    } catch (err) {
      console.error("[Startup] Admin bootstrap warning:", err.message);
    }

    app.listen(PORT, async () => {
      console.log(`\n======================================================`);
      console.log(`📱 WhatsApp Scheduler Mobile PWA & Server running!`);
      console.log(`🚀 Access Dashboard: http://localhost:${PORT}`);
      console.log(`======================================================\n`);

      try {
        await initAllActiveSessions();
        startScheduler(5000);
      } catch (err) {
        console.error("Failed to initialize active WhatsApp sessions on boot:", err);
      }
    });
  }).catch((err) => {
    console.error("Failed to initialize database on boot:", err);
    process.exit(1);
  });
}

module.exports = app;
module.exports.validateProductionConfig = validateProductionConfig;

