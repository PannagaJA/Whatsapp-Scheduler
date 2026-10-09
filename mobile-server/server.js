const express = require('express');
const cors = require('cors');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { run, get, all, DB_DIR } = require('./db');
const { initWhatsAppEngine, getStatus, requestPairingCode, getProfilePicture, logoutSession } = require('./engine');
const { startScheduler } = require('./scheduler');

const app = express();
const PORT = process.env.PORT || 3000;

// Setup upload storage for shared & scheduled attachments
const UPLOAD_DIR = path.join(DB_DIR, 'uploads');
if (!fs.existsSync(UPLOAD_DIR)) {
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + crypto.randomUUID().slice(0, 8);
    const ext = path.extname(file.originalname);
    cb(null, `${uniqueSuffix}${ext}`);
  }
});
const upload = multer({ storage, limits: { fileSize: 50 * 1024 * 1024 } }); // 50MB limit

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Serve Static PWA
app.use(express.static(path.join(__dirname, 'pwa')));

// Web Share Target Endpoint (Standard W3C PWA Share Sheet Handler)
// When user shares text/file from official WhatsApp or Gallery, the OS opens this POST route
app.post('/share', upload.array('files', 10), (req, res) => {
  const title = req.body.title || '';
  const text = req.body.text || '';
  const url = req.body.url || '';
  const files = (req.files || []).map(f => ({
    name: f.originalname,
    filename: f.filename,
    size: f.size,
    type: f.mimetype,
    path: f.path
  }));

  const sharePayload = {
    title,
    text: [text, url].filter(Boolean).join('\n'),
    files
  };

  // Temporarily store in session/memory or pass via query token for PWA to read
  const shareId = crypto.randomUUID();
  shareCache.set(shareId, sharePayload);

  // Redirect mobile browser to PWA homepage with shareId
  res.redirect(`/?shareId=${shareId}`);
});

const shareCache = new Map();
// Clear shareCache entries older than 10 minutes
setInterval(() => {
  if (shareCache.size > 100) shareCache.clear();
}, 10 * 60 * 1000);

// API: Get Shared Data for PWA
app.get('/api/shared/:shareId', (req, res) => {
  const shareId = req.params.shareId;
  const data = shareCache.get(shareId);
  if (data) {
    shareCache.delete(shareId);
    res.json({ success: true, ...data });
  } else {
    res.status(404).json({ success: false, error: 'Share data expired or not found' });
  }
});

// API: Status & Diagnostics (returns real-time syncing progress & contact count)
app.get('/api/status', async (req, res) => {
  try {
    const status = await getStatus();
    res.json({ success: true, ...status });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// API: Dedicated QR Code Endpoint
app.get('/api/qr', async (req, res) => {
  try {
    const status = await getStatus();
    res.json({ 
      success: true, 
      qr: status.qr || null, 
      status: status.status, 
      connected: status.status === 'connected' 
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// API: Request 8-digit Pairing Code (accepts phoneNumber or phone)
app.post('/api/pair-code', async (req, res) => {
  try {
    const phoneNumber = req.body.phoneNumber || req.body.phone;
    if (!phoneNumber) {
      return res.status(400).json({ success: false, error: 'Phone number is required (e.g. 919876543210)' });
    }
    const code = await requestPairingCode(phoneNumber);
    res.json({ success: true, code });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// API: Logout
app.post('/api/logout', async (req, res) => {
  try {
    await logoutSession();
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// API: List Contacts
app.get('/api/contacts', async (req, res) => {
  try {
    const contacts = await all(`
      SELECT jid, 
             coalesce(nullif(name, ''), '') as name, 
             phone, 
             is_group 
      FROM contacts 
      WHERE jid NOT LIKE '%@lid' AND (jid LIKE '%@s.whatsapp.net' OR jid LIKE '%@g.us')
      ORDER BY is_group ASC, (CASE WHEN nullif(name, '') IS NOT NULL THEN 0 ELSE 1 END), updated_at DESC
      LIMIT 1000
    `);
    res.json({ success: true, contacts, count: contacts.length });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// API: Bulk Import Contacts (from Phonebook sync)
app.post('/api/contacts/import', async (req, res) => {
  try {
    const { contacts } = req.body;
    if (!Array.isArray(contacts) || contacts.length === 0) {
      return res.status(400).json({ success: false, error: 'No contacts provided' });
    }

    let inserted = 0;
    for (const c of contacts) {
      const name = (c.name || '').trim();
      let rawPhone = String(c.phone || c.tel || '').replace(/\D/g, '');
      if (!rawPhone || rawPhone.length < 7) continue;

      let normalizedPhone = rawPhone;
      if (rawPhone.length === 10) {
        normalizedPhone = '91' + rawPhone;
      } else if (rawPhone.length === 11 && rawPhone.startsWith('0')) {
        normalizedPhone = '91' + rawPhone.slice(1);
      }

      const jid = `${normalizedPhone}@s.whatsapp.net`;

      // 1. Update any existing contacts with matching phone or JID
      if (name) {
        await run(`
          UPDATE contacts 
          SET name = ?, updated_at = ? 
          WHERE jid = ? 
             OR phone = ? 
             OR phone = ? 
             OR phone = ?
        `, [name, Date.now(), jid, rawPhone, normalizedPhone, rawPhone.startsWith('91') ? rawPhone.slice(2) : rawPhone]);
      }

      // 2. Insert or update record
      await run(`
        INSERT INTO contacts (jid, name, phone, is_group, updated_at)
        VALUES (?, ?, ?, 0, ?)
        ON CONFLICT(jid) DO UPDATE SET
          name = coalesce(nullif(excluded.name, ''), contacts.name),
          phone = coalesce(nullif(excluded.phone, ''), contacts.phone),
          updated_at = excluded.updated_at
      `, [jid, name, normalizedPhone, Date.now()]);

      inserted++;
    }

    res.json({ success: true, count: inserted });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// API: Contact / Group Profile Picture
app.get('/api/profile-pic', async (req, res) => {
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
app.get('/api/schedules', async (req, res) => {
  try {
    const schedules = await all(`
      SELECT s.*, 
             COALESCE(c.name, '') as contact_name
      FROM schedules s
      LEFT JOIN contacts c ON (
        (c.phone IS NOT NULL AND c.phone != '' AND s.recipient LIKE '%' || c.phone || '%') OR
        (c.jid IS NOT NULL AND c.jid != '' AND s.recipient = c.jid)
      )
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
app.post('/api/schedules', upload.array('attachments', 10), async (req, res) => {
  try {
    const id = crypto.randomUUID();
    const recipient = req.body.recipient?.trim();
    const text = req.body.text?.trim() || '';
    const scheduledAt = parseInt(req.body.scheduledAt, 10);

    if (!recipient) return res.status(400).json({ success: false, error: 'Recipient is required' });
    if (!scheduledAt || scheduledAt <= Date.now()) {
      return res.status(400).json({ success: false, error: 'Scheduled time must be in the future' });
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
      return res.status(400).json({ success: false, error: 'Please enter a message or attach a file' });
    }

    await run(`
      INSERT INTO schedules (id, recipient, text, attachments, scheduled_at, status, created_at)
      VALUES (?, ?, ?, ?, ?, 'scheduled', ?)
    `, [id, recipient, text, JSON.stringify(attachments), scheduledAt, Date.now()]);

    res.json({
      success: true,
      schedule: { id, recipient, text, attachments, scheduledAt, status: 'scheduled' }
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// API: Delete / Cancel Schedule
app.delete('/api/schedules/:id', async (req, res) => {
  try {
    const schedule = await get(`SELECT * FROM schedules WHERE id = ?`, [req.params.id]);
    if (!schedule) return res.status(404).json({ success: false, error: 'Schedule not found' });

    // Remove files
    if (schedule.attachments) {
      try {
        const files = JSON.parse(schedule.attachments);
        for (const f of files) {
          if (f.path && fs.existsSync(f.path)) fs.unlinkSync(f.path);
        }
      } catch (_) {}
    }

    await run(`DELETE FROM schedules WHERE id = ?`, [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Fallback to PWA index
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'pwa', 'index.html'));
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
    console.error('Failed to initialize WhatsApp engine on boot:', err);
  }
});
