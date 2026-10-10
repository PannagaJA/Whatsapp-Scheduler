# Phase 3 Plan: Defensive Hardening & Runtime Policies (P2)

**Milestone:** M1 — Production Security Remediation  
**Phase ID:** `03-defensive-hardening`  
**Target Findings:**
- `SEC-006` (Android WebView and Manifest Security Hardening)
- `SEC-007` (Upload Size, File Type, and Magic Byte Content Validation)
- `SEC-008` (Docker Build-Context and Secret Exclusion)
- `SEC-009` (Strict CORS Configuration & Method Constraints)
- `SEC-010` (Rate Limiting & Abuse Protection)
- `SEC-012` (Safe, User-Initiated Clipboard Handling)

---

## 1. Task Breakdown & Technical Specifications

### Task 3.1: Android Manifest & WebView Security Hardening (`SEC-006`)
- **Target Files:** [`android/app/src/main/AndroidManifest.xml`](file:///Users/pannagaja/Desktop/Projects/Whatsapp-Scheduler/android/app/src/main/AndroidManifest.xml), `android/app/src/main/res/xml/network_security_config.xml`, [`android/app/src/main/java/com/whatsapp/scheduler/MainActivity.java`](file:///Users/pannagaja/Desktop/Projects/Whatsapp-Scheduler/android/app/src/main/java/com/whatsapp/scheduler/MainActivity.java)
- **Changes:**
  1. Set `android:usesCleartextTraffic="false"` in `AndroidManifest.xml`.
  2. Add `network_security_config.xml` to enforce HTTPS across all domains, with exceptions strictly for local loopback debugging if needed.
  3. In `MainActivity.java`, harden WebSettings:
     - `settings.setAllowFileAccess(false)`
     - `settings.setAllowContentAccess(false)`
     - `settings.setAllowFileAccessFromFileURLs(false)`
     - `settings.setAllowUniversalAccessFromFileURLs(false)`
     - `settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW)`
  4. In `shouldOverrideUrlLoading`, strictly restrict navigation to `APP_URL` domain, WhatsApp intent schemes (`https://wa.me/`, `whatsapp://`), and communication intents (`tel:`, `mailto:`), rejecting arbitrary external origins.

### Task 3.2: Attachment Validation, MIME Whitelist & Magic Byte Verification (`SEC-007`)
- **Target Files:** [`mobile-server/server.js`](file:///Users/pannagaja/Desktop/Projects/Whatsapp-Scheduler/mobile-server/server.js), `mobile-server/fileValidator.js`
- **Changes:**
  1. Enforce strict upload limits in Multer: 25MB max per file, 10 files max per request.
  2. Create a lightweight magic-byte header validator checking binary signatures (magic numbers) for:
     - Images (`image/jpeg`: `FF D8 FF`, `image/png`: `89 50 4E 47`, `image/webp`: `52 49 46 46 ... 57 45 42 50`, `image/gif`: `47 49 46 38`)
     - Documents (`application/pdf`: `25 50 44 46`, `application/zip` / Office: `50 4B 03 04`)
     - Audio/Video (`video/mp4`, `audio/mpeg`, `audio/ogg`)
  3. Reject executable binaries, shell scripts, PHP, HTML, or payload files disguised with fake extensions.
  4. Sanitize original filenames to alphanumeric and safe punctuation.

### Task 3.3: Docker Secret & Build Context Exclusion (`SEC-008`)
- **Target Files:** `.dockerignore`, `mobile-server/.dockerignore`, [`mobile-server/Dockerfile`](file:///Users/pannagaja/Desktop/Projects/Whatsapp-Scheduler/mobile-server/Dockerfile)
- **Changes:**
  1. Create `.dockerignore` files ensuring that:
     - Runtime data directories (`data/`, `sessions/`, `auth_info_baileys/`, `uploads/`)
     - SQLite databases (`*.db`, `*.sqlite`, `*.sqlite3`)
     - Keystore files (`*.jks`, `*.keystore`, `keystore.properties`)
     - Environment files (`.env`, `.env.*`)
     - Logs (`*.log`)
     are strictly excluded from being copied into Docker container images.

### Task 3.4: Strict CORS Configuration (`SEC-009`)
- **Target Files:** [`mobile-server/server.js`](file:///Users/pannagaja/Desktop/Projects/Whatsapp-Scheduler/mobile-server/server.js)
- **Changes:**
  1. Replace wildcard `cors()` with an origin-restricted CORS middleware.
  2. Allow origins specified via `ALLOWED_ORIGINS` environment variable (e.g. `https://my-whatsapp-scheduler.onrender.com`), plus `localhost` / `127.0.0.1` for local development.
  3. Restrict HTTP methods (`GET`, `POST`, `DELETE`, `OPTIONS`) and headers (`Content-Type`, `Authorization`).

### Task 3.5: Rate Limiting & Abuse Protection (`SEC-010`)
- **Target Files:** [`mobile-server/server.js`](file:///Users/pannagaja/Desktop/Projects/Whatsapp-Scheduler/mobile-server/server.js), `mobile-server/rateLimiter.js`
- **Changes:**
  1. Implement sliding window / token bucket rate limiters:
     - **Auth Limiter:** 10 attempts per 15 minutes on `/api/auth/login` and `/api/auth/register` to block brute-force attacks.
     - **Pairing Limiter:** 5 requests per 15 minutes on `/api/pair-code` to prevent WhatsApp verification spam.
     - **Contact Import Limiter:** 20 requests per minute on `/api/contacts/import`.
     - **General API Limiter:** 300 requests per 15 minutes on standard `/api/*` endpoints.
  2. Return standard `429 Too Many Requests` responses with `Retry-After` header.

### Task 3.6: User-Initiated Clipboard Handling Hardening (`SEC-012`)
- **Target Files:** [`android/app/src/main/java/com/whatsapp/scheduler/MainActivity.java`](file:///Users/pannagaja/Desktop/Projects/Whatsapp-Scheduler/android/app/src/main/java/com/whatsapp/scheduler/MainActivity.java), [`mobile-server/pwa/app.js`](file:///Users/pannagaja/Desktop/Projects/Whatsapp-Scheduler/mobile-server/pwa/app.js)
- **Changes:**
  1. In `MainActivity.java`, sanitize text passed into `AndroidBridge.copyToClipboard()`: truncate to 128 characters max and strip control characters to prevent clipboard hijacking or oversized injection.
  2. Ensure clipboard writes in PWA are executed only in direct response to user gesture events (button tap).

---

## 2. Affected Files Inventory

| Component | File Path | Scope of Change |
| :--- | :--- | :--- |
| **Android Manifest** | `android/app/src/main/AndroidManifest.xml` | Disable cleartext traffic, reference network security config |
| **Android Security** | `android/app/src/main/res/xml/network_security_config.xml` | New network security config enforcing TLS |
| **Android WebView** | `android/app/src/main/java/com/whatsapp/scheduler/MainActivity.java` | Harden WebSettings, restrict navigation, sanitize clipboard bridge |
| **Backend Gateway** | `mobile-server/server.js` | Integrate rate limiters, strict CORS, and file validation middleware |
| **Backend Modules** | `mobile-server/fileValidator.js` *(New)* | Magic number byte validation for file uploads |
| **Backend Modules** | `mobile-server/rateLimiter.js` *(New)* | Sliding window IP rate limiter |
| **Docker Exclusions** | `.dockerignore`, `mobile-server/.dockerignore` | Exclude secrets, keys, session tokens, and database files |
| **Frontend PWA** | `mobile-server/pwa/app.js` | User-initiated clipboard event handling |
| **Automated Tests** | `mobile-server/test/security-phase3.test.js` *(New)* | Test suite covering SEC-006 through SEC-012 |

---

## 3. Automated Test Plan (`security-phase3.test.js`)

1. **Magic Byte Validation Tests (`SEC-007`):**
   - Upload genuine PNG/JPEG/PDF -> returns 200 / success.
   - Upload text/executable file renamed to `.png` -> returns 400 Bad Request (invalid file content signature).
   - Upload file exceeding 25MB -> returns 400 Payload Too Large.
2. **Rate Limiting Tests (`SEC-010`):**
   - Perform rapid login requests exceeding 10 attempts -> returns `429 Too Many Requests`.
   - Verify `Retry-After` header is returned.
3. **Strict CORS Tests (`SEC-009`):**
   - Send preflight / request from untrusted origin `https://evil-attacker.com` -> verify CORS headers reject origin.
   - Send request from trusted origin -> verify allowed.
4. **Docker Exclusion Tests (`SEC-008`):**
   - Verify `.dockerignore` patterns match all sensitive database, session, keystore, and log files.
5. **WebView & Manifest Policy Static Verification (`SEC-006` / `SEC-012`):**
   - Static analysis test verifying `AndroidManifest.xml` has `usesCleartextTraffic="false"`.
   - Static analysis test verifying `MainActivity.java` disables file access from URLs.

---

## 4. Unresolved Risks & Compatibility Considerations

- **Render Static Origin Matching:** On Render free/starter tiers, if the backend and PWA share the same origin, CORS operates seamlessly. If custom domains are added later, `ALLOWED_ORIGINS` environment variable must be configured.
- **Reverse Proxy IP Trust:** For rate limiting behind Render's load balancer, Express must configure `app.set('trust proxy', 1)` so client IP is accurately extracted from `X-Forwarded-For` without being spoofed.
- **WhatsApp Web Pairing Rate Limit:** The pairing code rate limit of 5 requests per 15 minutes is designed to protect WhatsApp API health while providing sufficient attempts for legitimate users.
