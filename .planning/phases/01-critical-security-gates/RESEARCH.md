# Phase 1: Research Analysis — Critical Security Gates (P0)

**Phase:** Phase 1 — Critical Security Gates & Core Authentication  
**Target Findings:** `SEC-001` (Unauthenticated REST API) & `SEC-002` (Insecure APK Updater / RCE Vector)

---

## 1. Authentication Architecture for Hybrid PWA + Android WebView

### Analysis & Constraints
1. **Application Context:** The system serves both a browser/PWA frontend and an Android Native WebView wrapper (`MainActivity.java`).
2. **Current State:** Zero authentication. All endpoints are open to anyone who can connect to the port/URL.
3. **Requirement:**
   - Authenticate all `/api/*` endpoints: `/api/status`, `/api/qr`, `/api/pair-code`, `/api/logout`, `/api/contacts`, `/api/contacts/import`, `/api/profile-pic`, `/api/schedules` (GET/POST/DELETE), `/api/shared/:shareId`.
   - Allow public access only to static assets (`/`, `/index.html`, `/style.css`, `/app.js`, `/sw.js`, `/manifest.json`, icons) and `/api/version` (for app version checks).
4. **Auth Mechanism Selection:**
   - For a single-tenant or initial self-hosted / cloud deployment with PWA + Android WebView: An `API_SECRET_KEY` / Bearer token configured on the server (and entered on first app setup or stored securely in browser `localStorage` / WebView bridge) provides immediate protection against unauthorized internet-wide scraping and hijacking.
   - For long-term multi-user architecture: Token/Session cookie with CSRF protection and account login.
   - Initial Phase 1 Tracer Implementation: Implement an extensible auth middleware `requireAuth` that validates Bearer tokens or configured application keys, protecting 100% of sensitive API surfaces with `401 Unauthorized` on failure.

---

## 2. Android APK In-App Updater Security (`SEC-002`)

### Analysis & Vulnerability Vector
In `MainActivity.java`:
```java
@JavascriptInterface
public void downloadAndInstallUpdate(final String downloadUrl) {
    // Downloads from any arbitrary URL without validation
    ...
    runOnUiThread(() -> triggerPackageInstaller(apkFile));
}
```

### Required Hardening Controls:
1. **Domain Whitelisting:**
   `downloadUrl` must strictly validate that the host is `github.com` or `objects.githubusercontent.com` and matches the repository releases path `https://github.com/PannagaJA/Whatsapp-Scheduler/releases/download/...`.
2. **Package Archive Inspection before Install:**
   Before invoking `FileProvider` and the Android package installer Intent:
   ```java
   PackageManager pm = getPackageManager();
   PackageInfo pInfo = pm.getPackageArchiveInfo(apkFile.getAbsolutePath(), PackageManager.GET_SIGNATURES);
   if (pInfo == null || !getPackageName().equals(pInfo.packageName)) {
       apkFile.delete();
       throw new SecurityException("Security error: Downloaded APK does not match application package ID.");
   }
   ```
3. **Safe Error Handling:**
   If validation fails, the downloaded temporary APK is deleted immediately, and an error Toast is displayed. No installation Intent is triggered.
