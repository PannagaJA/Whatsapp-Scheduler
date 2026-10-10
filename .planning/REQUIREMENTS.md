# Product & Security Requirements

## 1. Authentication & Access Control (AUTH)
- **AUTH-01 (SEC-001):** Implement application user accounts and short-lived session management.
- **AUTH-02 (SEC-001):** Enforce authentication middleware on all `/api/*` endpoints (contacts, schedules, pairing, logout, uploads).
- **AUTH-03 (SEC-001):** Server-side ownership verification for every resource operation (zero reliance on client-supplied user IDs).

## 2. Mobile & Updater Security (MOB)
- **MOB-01 (SEC-002):** Whitelist APK update download sources strictly to verified GitHub release repositories.
- **MOB-02 (SEC-002):** Programmatically inspect package name and certificate signatures prior to invoking `triggerPackageInstaller`.
- **MOB-03 (SEC-003):** Rotate release signing keystore, untrack `app-release.jks` from Git, and migrate signing credentials to CI secrets.
- **MOB-04 (SEC-006):** Disable `allowBackup`, `usesCleartextTraffic`, `setAllowFileAccess`, and insecure mixed content in Android manifest and WebView.
- **MOB-05 (SEC-012):** Restrict clipboard writes to explicit user actions and flag sensitive clip data on Android 13+.

## 3. Data Isolation & WhatsApp Session Management (ISO)
- **ISO-01 (SEC-005):** Add `user_id` foreign keys and indexes to `contacts`, `schedules`, and `settings` tables.
- **ISO-02 (SEC-005):** Multi-tenant WhatsApp session manager supporting isolated auth state directories (`sessions/${userId}/auth_info_baileys`).
- **ISO-03 (SEC-005):** Isolate background scheduler worker dispatches so messages are only transmitted via the owner's active socket.

## 4. File Handling & API Hardening (HARD)
- **HARD-01 (SEC-004):** Sanitize attachment paths and enforce directory boundary validation inside `UPLOADS_DIR` during schedule cancellations.
- **HARD-02 (SEC-007):** Multer MIME validation whitelist (images, videos, audio, PDF) and max 15MB file size limits.
- **HARD-03 (SEC-008):** `.dockerignore` deployment to exclude local `data/` directories and session keys.
- **HARD-04 (SEC-009):** Restrict CORS to authorized production web origins.
- **HARD-05 (SEC-010):** IP and user rate limiting on `/api/pair-code`, `/api/contacts/import`, and `/api/schedules`.
- **HARD-06 (SEC-011):** Upgrade dependencies to eliminate critical/high vulnerabilities in `tar` / `node-gyp`.
