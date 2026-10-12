# Security Remediation Checklist & Production Action Plan

**Target Application:** WhatsApp Scheduler (Android APK, Node.js Backend & PWA Ecosystem)  
**Target Release:** Pre-Production Hardening & Secure Release  
**Audit Reference:** [`SECURITY_AUDIT_REPORT.md`](file:///Users/pannagaja/Desktop/Projects/Whatsapp-Scheduler/SECURITY_AUDIT_REPORT.md)  
**Tracking Document:** `SECURITY_REMEDIATION_CHECKLIST.md`

---

## Remediation Workflow & Acceptance Summary

| Phase | Finding ID | Issue Title | Severity | Priority | Target Component | Acceptance Verified |
| :---: | :---: | :--- | :---: | :---: | :--- | :---: |
| **Phase 1** | **SEC-001** | Compromised Release Keystore in Git | 🔴 Critical | **P0** | `android/app/app-release.jks` | [x] Untracked from index |
| **Phase 1** | **SEC-002** | Insecure Android Application Backup | 🟠 High | **P0** | `AndroidManifest.xml` | [x] allowBackup="false" |
| **Phase 1** | **SEC-003** | Overly Permissive FileProvider Paths | 🟠 High | **P0** | `file_paths.xml` | [x] Scoped to Download/ & cache |
| **Phase 2** | **SEC-008** | Scheduler Queue Starvation (Head-of-Line Blocking) | 🟡 Medium | **P1** | `scheduler.js` | [x] Partitioned window query verified |
| **Phase 2** | **SEC-007** | Production Container Executes as Root | 🟡 Medium | **P1** | `Dockerfile` | [x] USER node & persistent perms set |
| **Phase 2** | **SEC-006** | Critical Supply-Chain Vulnerabilities (`tar`) | 🟡 Medium | **P1** | `package.json` | [x] 0 audit vulnerabilities |
| **Phase 3** | **SEC-004** | Plaintext WhatsApp Session Keys at Rest | 🟠 High | **P2** | `engine.js` / `sessionCrypto.js` | [x] AES-256-GCM authenticated encryption verified |
| **Phase 3** | **SEC-009** | Session Tokens in Client `localStorage` | 🟡 Medium | **P2** | `server.js` / `auth.js` / `app.js` | [x] HttpOnly cookies & CSRF verified |
| **Phase 3** | **SEC-010** | Unmasked Pairing Code in Clipboard | 🟡 Medium | **P2** | `MainActivity.java` | [x] EXTRA_IS_SENSITIVE set |
| **Phase 4** | **SEC-012** | ProGuard / R8 Obfuscation Disabled | 🔵 Low | **P3** | `android/app/build.gradle` | [x] minifyEnabled & shrinkResources enabled, targeted keep rules |
| **Phase 4** | **SEC-011** | In-Memory Staged Share Files Cache | 🔵 Low | **P3** | `server.js` | [x] BoundedShareCache with TTL, capacity limit & disk cleanup |
| **Phase 4** | **SEC-013** | DPDP Act Privacy Notice & Erasure Option | 🟡 Medium | **P3** | `MainActivity.java` / PWA | [x] DPDP consent flow & DELETE /api/contacts user erasure |
| **Phase 4** | **SEC-005** | Baileys WhatsApp ToS Disclaimer & Jitter | 🟠 High | **P3** | `engine.js` / PWA | [x] Configurable rate pacing jitter & PWA ToS advisory |

---

## Phase 1: Critical Blockers (P0 — Immediate Remediation)

### 🔴 Task SEC-001: Untrack Compromised Keystore and Rotate Signing Key
- **Priority:** P0 (Release Blocker)
- **Target Files:**
  - [`android/app/app-release.jks`](file:///Users/pannagaja/Desktop/Projects/Whatsapp-Scheduler/android/app/app-release.jks)
  - [`android/app/build.gradle`](file:///Users/pannagaja/Desktop/Projects/Whatsapp-Scheduler/android/app/build.gradle)
  - [`.github/workflows/build-apk.yml`](file:///Users/pannagaja/Desktop/Projects/Whatsapp-Scheduler/.github/workflows/build-apk.yml)
- **Detailed Action Plan:**
  1. Remove `android/app/app-release.jks` from Git index:
     ```bash
     git rm --cached android/app/app-release.jks
     ```
  2. Verify that `.gitignore` strictly covers all keystore patterns:
     ```gitignore
     *.jks
     *.keystore
     signing.properties
     keystore-base64.txt
     ```
  3. Generate a brand new production keystore offline:
     ```bash
     keytool -genkeypair -v -keystore release-new.jks -alias whatsapp-scheduler-v2 -keyalg RSA -keysize 4096 -validity 10000
     ```
  4. Encode the new keystore to Base64 and populate GitHub Encrypted Secrets:
     - `RELEASE_KEYSTORE_BASE64`
     - `KEYSTORE_PASSWORD`
     - `KEY_ALIAS`
     - `KEY_PASSWORD`
  5. Delete local `android/signing.properties` and `android/keystore-base64.txt` from developer machines once secrets are stored in CI.
- **Acceptance Criteria:**
  - [ ] `git ls-files | grep -i jks` returns empty.
  - [ ] Running `keytool` with `***REDACTED***` cannot decrypt the production signing key.
  - [ ] CI release workflow (`build-apk.yml`) builds and signs the release APK using GitHub Secrets without hardcoded fallbacks.

---

### 🟠 Task SEC-002: Disable Insecure Android Sandbox Backup
- **Priority:** P0 (Release Blocker)
- **Target File:** [`android/app/src/main/AndroidManifest.xml#L10-L19`](file:///Users/pannagaja/Desktop/Projects/Whatsapp-Scheduler/android/app/src/main/AndroidManifest.xml#L10-L19)
- **Detailed Action Plan:**
  Update `application` element in `AndroidManifest.xml` to disallow ADB backups:
  ```xml
  <application
      android:allowBackup="false"
      android:icon="@mipmap/ic_launcher"
      android:label="@string/app_name"
      android:roundIcon="@mipmap/ic_launcher_round"
      android:supportsRtl="true"
      android:theme="@style/Theme.WhatsAppScheduler"
      android:usesCleartextTraffic="false"
      android:networkSecurityConfig="@xml/network_security_config">
  ```
- **Acceptance Criteria:**
  - [ ] `android:allowBackup="false"` is verified in `AndroidManifest.xml`.
  - [ ] Running `adb backup -f backup.ab -noapk com.whatsapp.scheduler` produces a backup with 0 application bytes.

---

### 🟠 Task SEC-003: Restrict Android FileProvider Path Scope
- **Priority:** P0 (Release Blocker)
- **Target File:** [`android/app/src/main/res/xml/file_paths.xml`](file:///Users/pannagaja/Desktop/Projects/Whatsapp-Scheduler/android/app/src/main/res/xml/file_paths.xml)
- **Detailed Action Plan:**
  Replace wildcard root `.` with dedicated subdirectories:
  ```xml
  <?xml version="1.0" encoding="utf-8"?>
  <paths>
      <!-- Dedicated directory for downloaded in-app APK update packages -->
      <external-files-path name="downloaded_updates" path="Download/" />
      <cache-path name="update_cache" path="updates/" />
  </paths>
  ```
- **Acceptance Criteria:**
  - [ ] Root `path="."` is completely removed from all elements in `file_paths.xml`.
  - [ ] In-app updater successfully downloads and launches APK installation from `Environment.DIRECTORY_DOWNLOADS`.

---

## Phase 2: Core Backend & Stability Hardening (P1 — Pre-Launch)

### 🟡 Task SEC-008: Eliminate Scheduler Queue Starvation
- **Priority:** P1 (High)
- **Target File:** [`mobile-server/scheduler.js#L39-L45`](file:///Users/pannagaja/Desktop/Projects/Whatsapp-Scheduler/mobile-server/scheduler.js#L39-L45)
- **Detailed Action Plan:**
  1. Replace the static `LIMIT 10` query with fair user partitioning so that retrying jobs from one user do not block other users:
     ```javascript
     const pendingJobs = await all(`
       SELECT * FROM (
         SELECT *, ROW_NUMBER() OVER (PARTITION BY user_id ORDER BY scheduled_at ASC) as user_job_idx
         FROM schedules
         WHERE status IN ('scheduled', 'retrying')
           AND scheduled_at <= ?
       )
       WHERE user_job_idx <= 3
       ORDER BY scheduled_at ASC
       LIMIT 30
     `, [now]);
     ```
  2. Re-run `node mobile-server/test/audit-verification.test.js` to verify test C.5 passes cleanly.
- **Acceptance Criteria:**
  - [x] Test C.5 in `audit-verification.test.js` passes.
  - [x] Stalled or unlinked WhatsApp accounts do not prevent other accounts from dispatching queued messages.

---

### 🟡 Task SEC-007: Enforce Non-Root Execution in Production Dockerfile
- **Priority:** P1 (High)
- **Target File:** [`mobile-server/Dockerfile`](file:///Users/pannagaja/Desktop/Projects/Whatsapp-Scheduler/mobile-server/Dockerfile)
- **Detailed Action Plan:**
  Update `Dockerfile` to drop privileges before executing `server.js`:
  ```dockerfile
  FROM node:20-slim

  WORKDIR /app

  RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 \
      make \
      g++ \
      && rm -rf /var/lib/apt/lists/*

  COPY package*.json ./
  RUN npm ci --omit=dev

  COPY . .

  # Ensure non-root node user owns persistent data directories
  RUN mkdir -p /var/data/uploads /var/data/sessions /app/data && \
      chown -R node:node /app /var/data && \
      chmod 750 /var/data /app/data

  USER node

  EXPOSE 3000
  ENV PORT=3000
  ENV NODE_ENV=production

  HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD node -e "require('http').get('http://127.0.0.1:' + (process.env.PORT || 3000) + '/health', (res) => process.exit(res.statusCode === 200 ? 0 : 1)).on('error', () => process.exit(1))"

  CMD ["node", "server.js"]
  ```
- **Acceptance Criteria:**
  - [x] Container configured to run as user `node` (`id -u` is 1000, not 0).
  - [x] Server has proper write permissions to `/var/data` and `/app/data` with healthcheck.

---

### 🟡 Task SEC-006: Remediate Dependency Supply-Chain CVEs
- **Priority:** P1 (High)
- **Target File:** [`mobile-server/package.json`](file:///Users/pannagaja/Desktop/Projects/Whatsapp-Scheduler/mobile-server/package.json)
- **Detailed Action Plan:**
  Add npm package overrides in `mobile-server/package.json`:
  ```json
  "overrides": {
    "tar": "^7.5.22",
    "@tootallnate/once": "^2.0.1"
  }
  ```
  Run:
  ```bash
  cd mobile-server && npm install
  ```
- **Acceptance Criteria:**
  - [x] `npm audit` reports 0 vulnerabilities.
  - [x] All existing test suites continue to pass without regression.

---

## Phase 3: Cryptographic & Client Defense (P2)

### 🟠 Task SEC-004: Encrypt WhatsApp Session Credentials at Rest
- **Priority:** P2 (Medium)
- **Target Files:** [`mobile-server/engine.js`](file:///Users/pannagaja/Desktop/Projects/Whatsapp-Scheduler/mobile-server/engine.js), [`mobile-server/db.js`](file:///Users/pannagaja/Desktop/Projects/Whatsapp-Scheduler/mobile-server/db.js)
- **Detailed Action Plan:**
  1. Wrap Baileys `saveCreds` and `useMultiFileAuthState` to encrypt and decrypt JSON data using AES-256-GCM with a key derived from `process.env.SESSION_ENCRYPTION_KEY`.
  2. Alternatively, encrypt the directory into an encrypted zip archive or SQLite database table on shutdown/sync.
- **Acceptance Criteria:**
  - [x] Files on disk under `/var/data/sessions/<userId>/auth_info_baileys/` contain AES-256-GCM ciphertext without readable JSON keys.
  - [x] Safe migration with backup verification preserves legacy sessions without corruption.
  - [x] Authenticated encryption rejects tampered tags or corrupted keys.

---

### 🟡 Task SEC-009: Migrate Session Tokens from `localStorage` to HttpOnly Cookies
- **Priority:** P2 (Medium)
- **Target Files:**
  - [`mobile-server/server.js`](file:///Users/pannagaja/Desktop/Projects/Whatsapp-Scheduler/mobile-server/server.js)
  - [`mobile-server/auth.js`](file:///Users/pannagaja/Desktop/Projects/Whatsapp-Scheduler/mobile-server/auth.js)
  - [`mobile-server/pwa/app.js`](file:///Users/pannagaja/Desktop/Projects/Whatsapp-Scheduler/mobile-server/pwa/app.js)
- **Detailed Action Plan:**
  1. On `/api/auth/login` and `/api/auth/register`, set HttpOnly, SameSite=Lax cookie (`wa_session`) and client-readable CSRF cookie (`wa_csrf`).
  2. Enforce CSRF token verification on cookie-authenticated state-changing requests (`POST`, `PUT`, `DELETE`, `PATCH`).
  3. Maintain dual-stack Bearer token support for API clients and automated tests.
  4. Automatically transition PWA frontend to HttpOnly cookie on initial auth verification and purge `localStorage` token.
- **Acceptance Criteria:**
  - [x] Session tokens are set in HttpOnly, SameSite=Lax cookies (`wa_session`).
  - [x] Client JavaScript uses credentials: "include" and double-submit `wa_csrf` token.
  - [x] State-changing requests enforce CSRF token validation.
  - [x] Dual-stack support preserves API/WebView Bearer token authentication.

---

### 🟡 Task SEC-010: Obfuscate Clipboard Writes on Android 13+
- **Priority:** P2 (Medium)
- **Target File:** [`android/app/src/main/java/com/whatsapp/scheduler/MainActivity.java#L261-L275`](file:///Users/pannagaja/Desktop/Projects/Whatsapp-Scheduler/android/app/src/main/java/com/whatsapp/scheduler/MainActivity.java#L261-L275)
- **Detailed Action Plan:**
  ```java
  ClipData clip = ClipData.newPlainText("WhatsApp Code", safeText);
  if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
      PersistableBundle extras = new PersistableBundle();
      extras.putBoolean(ClipDescription.EXTRA_IS_SENSITIVE, true);
      clip.getDescription().setExtras(extras);
  }
  clipboard.setPrimaryClip(clip);
  ```
- **Acceptance Criteria:**
  - [x] Android 13+ clipboard manager hides pairing code in UI preview overlay.

---

## Phase 4: Privacy, Obfuscation & Policies (P3)

### 🔵 Task SEC-012: Enable ProGuard / R8 Obfuscation for Android Release
- **Priority:** P3 (Defense-in-Depth)
- **Target Files:**
  - [`android/app/build.gradle#L37`](file:///Users/pannagaja/Desktop/Projects/Whatsapp-Scheduler/android/app/build.gradle#L37)
  - [`android/app/proguard-rules.pro`](file:///Users/pannagaja/Desktop/Projects/Whatsapp-Scheduler/android/app/proguard-rules.pro)
- **Detailed Action Plan:**
  1. Set `minifyEnabled true` and `shrinkResources true` in `buildTypes.release`.
  2. In `proguard-rules.pro`, preserve native JavaScript interfaces and FileProvider:
     ```proguard
     -keepclassmembers class * {
         @android.webkit.JavascriptInterface <methods>;
     }
     -keep class com.whatsapp.scheduler.MainActivity$AndroidBridge { *; }
     -keep class androidx.core.content.FileProvider { *; }
     ```
- **Acceptance Criteria:**
  - [x] Release build configuration enables R8 minification and resource shrinking.
  - [x] JavaScript bridge, native interfaces, and FileProvider preserved via targeted keep rules without broad wildcard keeps.

---

### 🔵 Task SEC-011: Bounded Share-Cache Lifecycle & Eviction
- **Priority:** P3 (Resource Management & Hygiene)
- **Target Files:**
  - [`mobile-server/server.js`](file:///Users/pannagaja/Desktop/Projects/Whatsapp-Scheduler/mobile-server/server.js)
  - [`mobile-server/test/phase4-hardening.test.js`](file:///Users/pannagaja/Desktop/Projects/Whatsapp-Scheduler/mobile-server/test/phase4-hardening.test.js)
- **Detailed Action Plan:**
  1. Replace unbounded in-memory `Map` with `BoundedShareCache` with maximum capacity limit (default 100 entries) and bounded TTL (default 15 minutes).
  2. Implement unreferenced disk cleanup for unconsumed staged share files upon eviction or TTL expiration.
  3. Single-use consumption on `GET /api/share/cached/:id` to prevent memory bloat.
- **Acceptance Criteria:**
  - [x] `BoundedShareCache` enforces maximum capacity limit (evicts oldest entries when exceeded).
  - [x] Entries expire cleanly upon TTL timeout.
  - [x] Staged upload files on disk are safely deleted when evicted from cache.

---

### 🟡 Task SEC-013: Implement DPDP Act Compliance & Contact Deletion
- **Priority:** P3 (Compliance)
- **Target Files:**
  - [`mobile-server/pwa/index.html`](file:///Users/pannagaja/Desktop/Projects/Whatsapp-Scheduler/mobile-server/pwa/index.html)
  - [`mobile-server/pwa/app.js`](file:///Users/pannagaja/Desktop/Projects/Whatsapp-Scheduler/mobile-server/pwa/app.js)
  - [`mobile-server/server.js`](file:///Users/pannagaja/Desktop/Projects/Whatsapp-Scheduler/mobile-server/server.js)
- **Detailed Action Plan:**
  1. Add a preliminary DPDP consent disclosure dialog before triggering native `importAllContacts()`.
  2. Implement `DELETE /api/contacts` endpoint with strict per-user authorization (`WHERE user_id = req.user.id`), preserving message schedules and other users' records.
  3. Include link to a clear Privacy Policy & DPDP notice in the PWA.
- **Acceptance Criteria:**
  - [x] User must confirm consent before device address book is read or synced.
  - [x] "Erase" button calls `DELETE /api/contacts` with strict user isolation and cleans up all contacts for that user in SQLite without modifying schedules.

---

### 🟠 Task SEC-005: Baileys Anti-Ban Protections & User Disclaimer
- **Priority:** P3 (Operational Risk)
- **Target Files:**
  - [`mobile-server/engine.js`](file:///Users/pannagaja/Desktop/Projects/Whatsapp-Scheduler/mobile-server/engine.js)
  - [`mobile-server/pwa/index.html`](file:///Users/pannagaja/Desktop/Projects/Whatsapp-Scheduler/mobile-server/pwa/index.html)
- **Detailed Action Plan:**
  1. Add configurable randomized jitter delay between consecutive outgoing messages in `engine.js` (`MESSAGE_MIN_DELAY_MS` to `MESSAGE_MAX_DELAY_MS`).
  2. Display a clear Responsible Messaging & WhatsApp Terms of Service Advisory in the PWA.
- **Acceptance Criteria:**
  - [x] Dispatch delay jitter is implemented per-session and verified in unit tests.
  - [x] Responsible Messaging Advisory is clearly visible in the PWA UI.

---

## Sign-Off Gate

All items above must be verified and checked off before promoting this application build to public distribution or production hosting.
