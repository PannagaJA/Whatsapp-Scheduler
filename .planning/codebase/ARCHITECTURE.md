# System Architecture

**Target Repository:** `PannagaJA/Whatsapp-Scheduler`  
**Generated:** October 10, 2026

---

## 1. Architectural Overview

The system consists of a hybrid mobile/cloud architecture:

```
[Android APK / PWA Client]
       │ (REST / Web Share / JS Bridge)
       ▼
[Express Server (server.js)]
   ├── [Multer Uploads] ──► [Disk Storage: uploads/]
   ├── [SQLite Engine (db.js)] ──► [scheduler.db (WAL Mode)]
   ├── [WhatsApp Engine (engine.js)] ──► [Baileys Multi-Device Socket] ──► WhatsApp Network
   └── [Scheduler Daemon (scheduler.js)] ──► 5s Polling Loop ──► Outbound Message Dispatch
```

---

## 2. Core Modules & Responsibilities

1. **`server.js` (API Gateway & Asset Host):**
   - Serves the PWA static assets from `/pwa/`.
   - Handles REST routes: `/api/status`, `/api/qr`, `/api/pair-code`, `/api/logout`, `/api/contacts`, `/api/contacts/import`, `/api/schedules` (CRUD), `/api/version`.
   - Manages multipart upload parsing and Web Share Target temporary caching.

2. **`engine.js` (WhatsApp Lifecycle & Transport):**
   - Manages Baileys socket initialization, reconnect loops, QR generation, pairing code requests, and contact history syncing.
   - Translates recipient identifiers (names, raw numbers, formatted international phone numbers) into WhatsApp JIDs (`formatRecipientJid`).
   - Executes multi-part attachment and text dispatches with 1s delays.

3. **`db.js` (Data Access Layer):**
   - Configures SQLite in WAL mode with indexes on phone, name, updated_at, and schedule status.
   - Tables: `schedules`, `contacts`, `settings`.
   - Exposes transactional batch upsert helper `batchUpsertContacts()` for high-throughput contact book ingestion.

4. **`scheduler.js` (Background Execution Worker):**
   - Runs on a 5-second interval timer.
   - Queries `schedules` table for `status IN ('scheduled', 'retrying') AND scheduled_at <= now LIMIT 10`.
   - Claims jobs atomically by updating status to `processing`, attempts message dispatch, updates status to `sent` or `failed`/`retrying` (with 2-minute backoff), and deletes temporary attachment files upon completion.

5. **`MainActivity.java` (Android Native Wrapper):**
   - Host Activity with full-screen WebView, swipe-to-refresh, file chooser, and permission requests (`READ_CONTACTS`, `REQUEST_INSTALL_PACKAGES`).
   - `AndroidBridge` Javascript interface exposing version metadata, clipboard access, contact book extraction, and APK updater.
