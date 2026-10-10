# Phase 2 Plan: High-Priority Isolation & Integrity Hardening (P1)

**Milestone:** M1 — Production Security Remediation  
**Phase ID:** 02-isolation-and-integrity  
**Target Findings:**
- `SEC-005` (Complete Multi-Tenant Isolation: User-scoped WhatsApp Sockets, Contacts, Schedules, and Settings)
- `SEC-004` (Path-traversal proof attachment deletion & storage boundary containment)
- `SEC-003` (Safe parameterization of Android release keystore credentials)

---

## 1. Implementation Steps

1. **Database Schema & Data Migration (`mobile-server/db.js`):**
   - Add `user_id` to `contacts`, `schedules`, and `settings` tables.
   - Add composite indexes on `(user_id, phone)`, `(user_id, jid)`, `(user_id, status, scheduled_at)`.
   - Implement `migrateLegacyData(adminUserId)` to associate any unassigned legacy records with the primary administrator.

2. **Multi-Tenant WhatsApp Session Manager (`mobile-server/engine.js`):**
   - Refactor single global socket (`let sock = null`) to a user-scoped session registry (`userSessions = new Map<userId, UserWhatsAppSession>()`).
   - Store auth credentials per user in `data/sessions/${userId}/auth_info_baileys/`.
   - Update `getStatus(userId)`, `requestPairingCode(userId, phone)`, `sendWhatsAppMessage(userId, recipient, text, attachments)`, `logoutSession(userId)`, `getProfilePicture(userId, jid)`.
   - Safely migrate legacy `data/auth_info_baileys` credentials to `data/sessions/${adminId}/auth_info_baileys` on boot.

3. **Background Scheduler Isolation & Concurrency Safety (`mobile-server/scheduler.js`):**
   - Atomic job claiming with `UPDATE schedules SET status = 'processing', attempts = attempts + 1 WHERE id = ? AND status IN ('scheduled', 'retrying')` to prevent double execution.
   - Dispatch messages strictly through the owning user's WhatsApp socket (`job.user_id`).
   - Safe path containment attachment deletion (`safeDeleteAttachment`).

4. **API Gateway & Route Scoping (`mobile-server/server.js`):**
   - Scope all database queries, contact syncs, schedule creation, schedule deletion, and session actions strictly to `req.user.id`.
   - Enforce path-containment verification on attachment deletions.

5. **Android Build Configuration (`android/app/build.gradle`):**
   - Parameterize release signing credentials to read from environment variables with fallback defaults.

6. **Automated Test Suite (`mobile-server/test/security-phase2.test.js`):**
   - Cross-user IDOR rejection tests on contacts, schedules, and WhatsApp sockets.
   - Arbitrary path traversal & file deletion tests.
   - Concurrency & double-dispatch prevention tests.
   - Database migration verification tests.
