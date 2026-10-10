# Testing Strategy & Verification Guidelines

**Target Repository:** `PannagaJA/Whatsapp-Scheduler`  
**Generated:** October 10, 2026

---

## 1. Current Test Coverage
- **Unit Tests:** None currently present in `mobile-server/` or `android/`.
- **Integration Tests:** None currently implemented.
- **Manual Smoke Testing:** Developer verification against local/mock WhatsApp pairing.

---

## 2. Mandatory Test Suite Requirements for Security Remediation

Before approving production deployment, the following test suites must be built:

### A. Backend Security & Access Control Tests
1. **Unauthenticated Access Tests:**
   - Verify `401 Unauthorized` on `/api/contacts`, `/api/contacts/import`, `/api/schedules` (GET/POST/DELETE), `/api/pair-code`, `/api/logout`.
2. **IDOR & Multi-Tenant Partitioning Tests:**
   - Verify User A cannot access, view, modify, or delete User B's contacts or scheduled messages.
   - Verify User A cannot trigger dispatches through User B's WhatsApp socket.
3. **Path Traversal & Arbitrary Deletion Tests:**
   - Verify that passing absolute paths (`/var/data/scheduler.db` or `../../etc/passwd`) to `POST /api/schedules` or `DELETE /api/schedules/:id` fails safely without deleting files.
4. **Rate Limiting Tests:**
   - Verify HTTP `429 Too Many Requests` when sending >5 pairing code requests within 15 minutes.

### B. Mobile & Updater Tests
1. **APK Updater URL Whitelist Tests:**
   - Verify non-whitelisted domains passed to `downloadAndInstallUpdate()` are rejected.
2. **Package Identity Tests:**
   - Verify mismatching package names or tampered signatures are rejected before invoking `triggerPackageInstaller`.

### C. Scheduler Concurrency Tests
1. **Duplicate Dispatch Prevention:**
   - Verify that multiple worker poll iterations do not dispatch the same message twice.
2. **Cancellation State Tests:**
   - Verify canceled jobs are marked `canceled` and ignored by `scheduler.js`.
