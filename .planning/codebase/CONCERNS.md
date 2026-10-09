# Known Technical Concerns & Security Weaknesses

**Target Repository:** `PannagaJA/Whatsapp-Scheduler`  
**Generated:** October 10, 2026

---

## 1. Critical Vulnerabilities (Release Blockers)
1. **Unauthenticated REST API (`SEC-001`):** No authentication middleware exists on any API route in `server.js`.
2. **Insecure APK Updater / RCE Vector (`SEC-002`):** `AndroidNative.downloadAndInstallUpdate` downloads arbitrary URLs without package or signature verification.

---

## 2. High Severity Architectural Issues
1. **Committed Release Keystore (`SEC-003`):** `app-release.jks` and cleartext passwords committed in Git.
2. **Arbitrary File Deletion (`SEC-004`):** Unsanitized `existingFiles` paths in schedule deletion can delete arbitrary server files (`fs.unlinkSync`).
3. **Single-Tenant Architecture (`SEC-005`):** Single global Baileys socket (`let sock = null`) and unscoped SQLite tables cause cross-user collisions on public cloud instances.

---

## 3. Medium & Low Weaknesses
1. **Permissive Android WebView Settings (`SEC-006`):** `allowBackup=true`, `usesCleartextTraffic=true`, `setAllowFileAccess(true)`, and mixed content enabled.
2. **File Upload Exhaustion (`SEC-007`):** No MIME validation; up to 500MB payload allowed vs 1GB Render disk quota.
3. **Missing `.dockerignore` (`SEC-008`):** Local `data/` directory and session keys risk being copied into Docker build layers.
4. **Wildcard CORS (`SEC-009`):** `Access-Control-Allow-Origin: *` allows any website to invoke API endpoints.
5. **Missing Rate Limiting (`SEC-010`):** Unthrottled pairing code generation risks WhatsApp phone number bans.
6. **Vulnerable Transitive Dependencies (`SEC-011`):** Vulnerabilities in `tar` / `node-gyp` through `sqlite3`.
7. **Clipboard Leakage (`SEC-012`):** 8-digit WhatsApp pairing codes automatically copied to system clipboard without masking.
8. **WhatsApp Reverse-Engineered Socket Compliance (`SEC-013`):** Unofficial Baileys library carries inherent ToS compliance and account suspension risks.
