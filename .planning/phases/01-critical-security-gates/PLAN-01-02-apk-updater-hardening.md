# Plan 01-02: Android APK In-App Updater Hardening

**Phase:** Phase 1 — Critical Security Gates & Core Authentication  
**Finding ID:** `SEC-002`  
**Priority:** P0 (Release Blocker)  
**Target File:**
- [`android/app/src/main/java/com/whatsapp/scheduler/MainActivity.java`](file:///Users/pannagaja/Desktop/Projects/Whatsapp-Scheduler/android/app/src/main/java/com/whatsapp/scheduler/MainActivity.java#L280-L358)

---

## 1. Objective
Harden the native `downloadAndInstallUpdate()` JavaScript bridge in `MainActivity.java` by whitelisting trusted download hosts, enforcing HTTPS, validating downloaded APK package identity, and preventing arbitrary code execution.

---

## 2. Tasks

### Task 1: URL Domain & Protocol Whitelisting
1. In `MainActivity.java` inside `downloadAndInstallUpdate(final String downloadUrl)`:
   - Parse `downloadUrl` into `Uri` / `URL`.
   - Verify protocol is strictly `https`.
   - Verify host is strictly `github.com` or `objects.githubusercontent.com`.
   - Verify path starts with `/PannagaJA/Whatsapp-Scheduler/releases/download/`.
   - Reject any other URL with an error Toast and do not initiate HTTP connection.

### Task 2: Package Archive Inspection before Installer Trigger
1. Before calling `triggerPackageInstaller(apkFile)`:
   - Use Android `PackageManager.getPackageArchiveInfo(apkFile.getAbsolutePath(), PackageManager.GET_ACTIVITIES | PackageManager.GET_SIGNATURES)`.
   - Verify `pInfo != null`.
   - Verify `pInfo.packageName.equals(getPackageName())` (`com.whatsapp.scheduler`).
2. If package validation fails:
   - Delete `apkFile` immediately.
   - Display a warning Toast: `"Update rejected: Untrusted or invalid package."`.
   - Abort execution without launching the package installer Intent.

---

## 3. Verification & Acceptance Criteria
- [ ] Attempting to pass `http://attacker.com/malware.apk` or `https://otherhost.com/app.apk` is rejected immediately.
- [ ] Attempting to download an APK with a different package name (e.g. `com.other.app`) fails package inspection and is deleted.
- [ ] Official release APK from `https://github.com/PannagaJA/Whatsapp-Scheduler/releases/download/...` passes validation and launches installer prompt.
