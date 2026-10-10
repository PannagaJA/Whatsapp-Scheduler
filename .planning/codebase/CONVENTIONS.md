# Code Conventions & Style

**Target Repository:** `PannagaJA/Whatsapp-Scheduler`  
**Generated:** October 10, 2026

---

## 1. Backend Javascript Patterns
- **Module System:** CommonJS (`require` / `module.exports`).
- **Async Pattern:** Async/Await with Promises. Direct SQLite callbacks wrapped into `run()`, `get()`, `all()` helpers in `db.js`.
- **Error Handling:** Try/catch blocks in Express route handlers returning standard JSON envelopes:
  - Success: `{ success: true, ...data }`
  - Error: `{ success: false, error: "Human-readable message" }`
- **Database Migrations:** Idempotent `CREATE TABLE IF NOT EXISTS` and `CREATE INDEX IF NOT EXISTS` executed during initialization in `db.serialize()`.

---

## 2. Frontend / PWA Patterns
- **Framework:** Vanilla JavaScript with DOM query caching.
- **State Management:** In-memory state with persistence in `localStorage` for tab selection (`wa_active_tab`) and connection indicators (`wa_status`).
- **Security Sanitization:** Explicit `escapeHtml()` helper utilized when rendering dynamic contact names or message previews.
- **UI Feedback:** Centralized non-blocking toast notifications (`showToast()`).

---

## 3. Android Java Patterns
- **Architecture:** Single-Activity (`MainActivity`) containing WebView and SwipeRefreshLayout.
- **Background Execution:** `Executors.newSingleThreadExecutor()` for asynchronous background tasks (contact syncing, APK downloading) with `runOnUiThread()` for UI callbacks.
- **Native-Web Communication:** `@JavascriptInterface` on `AndroidBridge` and `evaluateJavascript` for pushing native contacts to web window.
