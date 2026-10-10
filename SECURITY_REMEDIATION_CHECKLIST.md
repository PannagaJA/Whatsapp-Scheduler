# Security Remediation Checklist & Action Plan

**Target Application:** WhatsApp Scheduler  
**Target Release:** Pre-Production Hardening  
**Tracking File:** `SECURITY_REMEDIATION_CHECKLIST.md`

---

## Phase 1: Critical Fixes (Immediate Blockers)

### 🔴 Fix SEC-001: Implement Backend API Authentication Middleware
- **Priority:** P0 (Blocker)
- **Target Files:** [`mobile-server/server.js`](file:///Users/pannagaja/Desktop/Projects/Whatsapp-Scheduler/mobile-server/server.js), [`mobile-server/pwa/app.js`](file:///Users/pannagaja/Desktop/Projects/Whatsapp-Scheduler/mobile-server/pwa/app.js)
- **Implementation Design:**
  1. Add an authentication mechanism (e.g., Bearer API token configured via environment variable `API_SECRET_KEY` or session-based authentication).
  2. Implement an Express authentication guard middleware:
     ```javascript
     function requireAuth(req, res, next) {
       const authHeader = req.headers.authorization;
       const token = authHeader && authHeader.split(" ")[1];
       if (!token || token !== process.env.API_SECRET_KEY) {
         return res.status(401).json({ success: false, error: "Unauthorized" });
       }
       next();
     }
     ```
  3. Apply `requireAuth` to all routes under `/api/*` except public assets and health checks.
  4. Update PWA and Android WebView requests to include the authorization header.
- **Acceptance Criteria:**
  - [ ] Unauthenticated requests to `/api/contacts`, `/api/schedules`, `/api/pair-code`, `/api/logout` return `401 Unauthorized`.
  - [ ] Valid authenticated requests succeed as expected.

---

### 🔴 Fix SEC-002: Secure Android In-App APK Updater & Whitelist Downloads
- **Priority:** P0 (Blocker)
- **Target Files:** [`android/app/src/main/java/com/whatsapp/scheduler/MainActivity.java`](file:///Users/pannagaja/Desktop/Projects/Whatsapp-Scheduler/android/app/src/main/java/com/whatsapp/scheduler/MainActivity.java#L280-L358)
- **Implementation Design:**
  1. Whitelist the download URL in `MainActivity.java` to strictly allow URLs from `https://github.com/PannagaJA/Whatsapp-Scheduler/releases/download/`.
  2. Reject any download request where `url.getHost()` is not `github.com` or `objects.githubusercontent.com`.
  3. Inspect downloaded APK package info before triggering installer:
     ```java
     PackageInfo pInfo = getPackageManager().getPackageArchiveInfo(apkFile.getAbsolutePath(), PackageManager.GET_SIGNATURES);
     if (pInfo == null || !getPackageName().equals(pInfo.packageName)) {
         apkFile.delete();
         throw new SecurityException("Downloaded package does not match application ID");
     }
     ```
- **Acceptance Criteria:**
  - [ ] Non-whitelisted or HTTP download URLs are rejected immediately.
  - [ ] Attempting to pass a malicious APK with a mismatching package name aborts before launch.

---

### 🟠 Fix SEC-003: Rotate Android Keystore and Remove Secrets from Git
- **Priority:** P1 (High)
- **Target Files:** [`android/app/build.gradle`](file:///Users/pannagaja/Desktop/Projects/Whatsapp-Scheduler/android/app/build.gradle), [`android/app/app-release.jks`](file:///Users/pannagaja/Desktop/Projects/Whatsapp-Scheduler/android/app/app-release.jks), `.gitignore`
- **Implementation Design:**
  1. Generate a new release keystore offline.
  2. Add `*.jks`, `*.keystore`, and `keystore.properties` to `.gitignore`.
  3. Update `build.gradle` to read signing credentials from environment variables or a local untracked `keystore.properties` file:
     ```groovy
     signingConfigs {
         release {
             storeFile file(System.getenv("KEYSTORE_PATH") ?: "app-release.jks")
             storePassword System.getenv("KEYSTORE_PASSWORD") ?: ""
             keyAlias System.getenv("KEY_ALIAS") ?: ""
             keyPassword System.getenv("KEY_PASSWORD") ?: ""
         }
     }
     ```
  4. Store the base64-encoded keystore and passwords as repository secrets in GitHub Actions.
- **Acceptance Criteria:**
  - [ ] No `.jks` or `.keystore` binary exists in source control.
  - [ ] No plaintext passwords exist in `build.gradle`.
  - [ ] GitHub Actions CI builds release APKs using secrets.

---

### 🟠 Fix SEC-004: Prevent Arbitrary File Deletion in Schedule Handler
- **Priority:** P1 (High)
- **Target File:** [`mobile-server/server.js`](file:///Users/pannagaja/Desktop/Projects/Whatsapp-Scheduler/mobile-server/server.js#L349-L370)
- **Implementation Design:**
  1. Ensure that during `DELETE /api/schedules/:id`, file deletion strictly enforces path validation within `UPLOADS_DIR`:
     ```javascript
     if (schedule.attachments) {
       try {
         const files = JSON.parse(schedule.attachments);
         for (const f of files) {
           if (f.filename) {
             const safePath = path.join(UPLOADS_DIR, path.basename(f.filename));
             if (safePath.startsWith(UPLOADS_DIR) && fs.existsSync(safePath)) {
               fs.unlinkSync(safePath);
             }
           }
         }
       } catch (_) {}
     }
     ```
  2. Sanitize `existingFiles` inputs to only store base filenames rather than arbitrary paths.
- **Acceptance Criteria:**
  - [ ] Passing absolute system paths (e.g. `/var/data/scheduler.db` or `../../etc/passwd`) does not delete the target file.
  - [ ] Only files residing in `UPLOADS_DIR` are deleted when canceling a schedule.

---

## Phase 2: High & Medium Priority Hardening

### 🟠 Fix SEC-005: Multi-Tenant Scoping (If Serving Multiple Users)
- **Priority:** P1 (High)
- **Target Files:** [`mobile-server/engine.js`](file:///Users/pannagaja/Desktop/Projects/Whatsapp-Scheduler/mobile-server/engine.js), [`mobile-server/db.js`](file:///Users/pannagaja/Desktop/Projects/Whatsapp-Scheduler/mobile-server/db.js)
- **Implementation Design:**
  1. Add `user_id` columns to `contacts`, `schedules`, and `settings` tables.
  2. Scope Baileys multi-file auth state by user: `path.join(DB_DIR, "sessions", userId, "auth_info_baileys")`.
  3. Maintain a session registry `const sessions = new Map<userId, WASocket>()` to support isolated multi-device instances.
- **Acceptance Criteria:**
  - [ ] Connecting WhatsApp on User A's account does not disconnect or overwrite User B's session.
  - [ ] Querying `/api/contacts` and `/api/schedules` returns only records belonging to the authenticated user.

---

### 🟡 Fix SEC-006: Android Security Hardening & WebView Policies
- **Priority:** P2 (Medium)
- **Target Files:** [`android/app/src/main/AndroidManifest.xml`](file:///Users/pannagaja/Desktop/Projects/Whatsapp-Scheduler/android/app/src/main/AndroidManifest.xml), [`android/app/src/main/java/com/whatsapp/scheduler/MainActivity.java`](file:///Users/pannagaja/Desktop/Projects/Whatsapp-Scheduler/android/app/src/main/java/com/whatsapp/scheduler/MainActivity.java)
- **Implementation Design:**
  1. In `AndroidManifest.xml`:
     ```xml
     <application
         android:allowBackup="false"
         android:usesCleartextTraffic="false"
         ... >
     ```
  2. In `MainActivity.java`:
     ```java
     settings.setAllowFileAccess(false);
     settings.setAllowContentAccess(false);
     if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP) {
         settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
     }
     ```
  3. Enable ProGuard / R8 code shrinking in `android/app/build.gradle`: `minifyEnabled true`.
- **Acceptance Criteria:**
  - [ ] Cleartext HTTP connections are blocked by Android OS.
  - [ ] ADB backup extraction is disallowed.
  - [ ] Local file access through WebView is disabled.

---

### 🟡 Fix SEC-007: Multer File Upload Restrictions & MIME Validation
- **Priority:** P2 (Medium)
- **Target File:** [`mobile-server/server.js`](file:///Users/pannagaja/Desktop/Projects/Whatsapp-Scheduler/mobile-server/server.js#L28-L36)
- **Implementation Design:**
  1. Add `fileFilter` to Multer:
     ```javascript
     const ALLOWED_MIME_TYPES = new Set([
       "image/jpeg", "image/png", "image/webp", "image/gif",
       "video/mp4", "video/quicktime", "video/3gpp",
       "audio/mpeg", "audio/ogg", "audio/mp4", "audio/wav",
       "application/pdf", "text/plain", "application/zip"
     ]);
     const upload = multer({
       storage,
       limits: { fileSize: 15 * 1024 * 1024, files: 5 },
       fileFilter: (req, file, cb) => {
         if (ALLOWED_MIME_TYPES.has(file.mimetype)) {
           cb(null, true);
         } else {
           cb(new Error("File type not allowed"), false);
         }
       }
     });
     ```
- **Acceptance Criteria:**
  - [ ] Uploads exceeding 15MB or unsupported file types (e.g. `.exe`, `.sh`, `.apk`) are rejected.

---

### 🟡 Fix SEC-008: Add `.dockerignore` to Prevent Data & Key Leaks
- **Priority:** P2 (Medium)
- **Target Files:** `mobile-server/.dockerignore`, `.dockerignore`
- **Implementation Design:**
  Create `.dockerignore` containing:
  ```
  data/
  node_modules/
  .git/
  .github/
  *.log
  .DS_Store
  ```
- **Acceptance Criteria:**
  - [ ] Building the Docker container does not include local `data/` directories or session keys.

---

### 🟡 Fix SEC-009: Restrict CORS to Production Origin
- **Priority:** P2 (Medium)
- **Target File:** [`mobile-server/server.js`](file:///Users/pannagaja/Desktop/Projects/Whatsapp-Scheduler/mobile-server/server.js#L41)
- **Implementation Design:**
  ```javascript
  const allowedOrigins = [
    process.env.ALLOWED_ORIGIN || "https://my-whatsapp-scheduler.onrender.com"
  ];
  app.use(cors({
    origin: (origin, callback) => {
      if (!origin || allowedOrigins.includes(origin)) return callback(null, true);
      callback(new Error("CORS origin not allowed"));
    }
  }));
  ```
- **Acceptance Criteria:**
  - [ ] Requests from untrusted third-party browser origins are rejected with a CORS error.

---

## Phase 3: Defense-in-Depth & Operational Hardening

### 🔵 Fix SEC-010: Rate Limiting on Pairing and Sync Endpoints
- **Priority:** P3 (Low)
- **Target File:** [`mobile-server/server.js`](file:///Users/pannagaja/Desktop/Projects/Whatsapp-Scheduler/mobile-server/server.js)
- **Implementation Design:**
  ```javascript
  const rateLimit = require("express-rate-limit");
  const pairLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 5 });
  app.use("/api/pair-code", pairLimiter);
  ```
- **Acceptance Criteria:**
  - [ ] More than 5 pairing code requests within 15 minutes receive HTTP 429 Too Many Requests.

---

### 🔵 Fix SEC-011: Upgrade Vulnerable Transitive Dependencies
- **Priority:** P3 (Low)
- **Target File:** [`mobile-server/package.json`](file:///Users/pannagaja/Desktop/Projects/Whatsapp-Scheduler/mobile-server/package.json)
- **Action:**
  - Upgrade `sqlite3` to `^6.0.1` or migrate to `better-sqlite3`.
  - Run `npm audit fix`.
- **Acceptance Criteria:**
  - [ ] `npm audit` returns 0 critical or high vulnerabilities.

---

### 🔵 Fix SEC-012: Mask Sensitive Clipboard Operations
- **Priority:** P3 (Low)
- **Target Files:** [`android/app/src/main/java/com/whatsapp/scheduler/MainActivity.java`](file:///Users/pannagaja/Desktop/Projects/Whatsapp-Scheduler/android/app/src/main/java/com/whatsapp/scheduler/MainActivity.java#L253-L261), [`mobile-server/pwa/app.js`](file:///Users/pannagaja/Desktop/Projects/Whatsapp-Scheduler/mobile-server/pwa/app.js#L86-L121)
- **Implementation Design:**
  - Set `ClipDescription.EXTRA_IS_SENSITIVE` on Android 13+ to prevent pairing code preview on screen.
  - Require user interaction before writing pairing code to clipboard.
- **Acceptance Criteria:**
  - [ ] Clipboard write only occurs on user tap.

---

## Verification & Sign-Off Matrix

| Finding | Remediation Owner | Status | Verified In Environment | Date Verified |
| :--- | :--- | :---: | :---: | :---: |
| **SEC-001** (API Auth) | Backend Team | ⏳ Pending | | |
| **SEC-002** (APK Updater) | Mobile Team | ⏳ Pending | | |
| **SEC-003** (Keystore Leak) | DevSecOps / Mobile | ⏳ Pending | | |
| **SEC-004** (Arbitrary Delete) | Backend Team | ⏳ Pending | | |
| **SEC-005** (Multi-Tenant) | Architecture Team | ⏳ Pending | | |
| **SEC-006** (WebView Hardening) | Mobile Team | ⏳ Pending | | |
| **SEC-007** (Upload Limits) | Backend Team | ⏳ Pending | | |
| **SEC-008** (Dockerignore) | DevSecOps | ⏳ Pending | | |
| **SEC-009** (CORS Policy) | Backend Team | ⏳ Pending | | |
| **SEC-010** (Rate Limiting) | Backend Team | ⏳ Pending | | |
| **SEC-011** (Dependencies) | DevSecOps | ⏳ Pending | | |
| **SEC-012** (Clipboard Masking) | Mobile Team | ⏳ Pending | | |
