# SEC-003: Android Release Signing Key Analysis & Corrected Migration Strategy

**Status:** Open / Documented Strategy & Migration Roadmap  
**Target Components:** [`android/app/build.gradle`](file:///Users/pannagaja/Desktop/Projects/Whatsapp-Scheduler/android/app/build.gradle), [`.github/workflows/build-apk.yml`](file:///Users/pannagaja/Desktop/Projects/Whatsapp-Scheduler/.github/workflows/build-apk.yml), `android/app/app-release.jks`

---

## 1. Codebase & CI Workflow Inspection

### A. Current Build & Signing Task Analysis
Inspection of [`.github/workflows/build-apk.yml`](file:///Users/pannagaja/Desktop/Projects/Whatsapp-Scheduler/.github/workflows/build-apk.yml) and [`android/app/build.gradle`](file:///Users/pannagaja/Desktop/Projects/Whatsapp-Scheduler/android/app/build.gradle) reveals:
1. **Task Used:** The GitHub Actions workflow executes `gradle assembleDebug` ([`.github/workflows/build-apk.yml:41`](file:///Users/pannagaja/Desktop/Projects/Whatsapp-Scheduler/.github/workflows/build-apk.yml#L41)), **not** `assembleRelease`.
2. **Artifact Renaming:** The debug artifact `android/app/build/outputs/apk/debug/app-debug.apk` is copied and renamed to `WhatsApp-Scheduler.apk` ([`.github/workflows/build-apk.yml:46`](file:///Users/pannagaja/Desktop/Projects/Whatsapp-Scheduler/.github/workflows/build-apk.yml#L46)) before being published as an official release.
3. **Signing Configuration Linkage:** In [`android/app/build.gradle:34-38`](file:///Users/pannagaja/Desktop/Projects/Whatsapp-Scheduler/android/app/build.gradle#L34-L38), `buildTypes.debug` explicitly sets `signingConfig signingConfigs.release`, which points to `app-release.jks`.
4. **Conclusion:** Official GitHub Releases are currently built using the `debug` Gradle variant, but signed with the release keystore `app-release.jks`.

---

## 2. Proposed CI & Gradle Configuration Corrections

### A. Fail-Safe CI Release Configuration (No Hardcoded Fallbacks)
1. **Strict Fail-Fast in CI:**
   Update [`android/app/build.gradle`](file:///Users/pannagaja/Desktop/Projects/Whatsapp-Scheduler/android/app/build.gradle) to distinguish between local developer debugging and official release signing. If `assembleRelease` is executed or `CI=true`, Gradle must strictly require environment variables and **fail the build immediately** if any credential is missing:
   ```groovy
   signingConfigs {
       release {
           def ksPath = System.getenv("KEYSTORE_PATH")
           def ksPass = System.getenv("KEYSTORE_PASSWORD")
           def kAlias = System.getenv("KEY_ALIAS")
           def kPass = System.getenv("KEY_PASSWORD")

           if (System.getenv("CI") == "true") {
               if (!ksPath || !ksPass || !kAlias || !kPass) {
                   throw new GradleException("CRITICAL CI ERROR: Missing required release signing secrets in CI environment!")
               }
           }

           if (ksPath) {
               storeFile file(ksPath)
               storePassword ksPass
               keyAlias kAlias
               keyPassword kPass
           }
       }
   }
   ```
2. **Explicit Release Workflow in CI:**
   Update [`.github/workflows/build-apk.yml`](file:///Users/pannagaja/Desktop/Projects/Whatsapp-Scheduler/.github/workflows/build-apk.yml) to execute `gradle assembleRelease` rather than `assembleDebug`, injecting the base64-decoded keystore and environment variables from GitHub Encrypted Secrets:
   ```yaml
   - name: Decode Release Keystore
     run: |
       echo "${{ secrets.RELEASE_KEYSTORE_BASE64 }}" | base64 --decode > android/app/release.jks
     env:
       RELEASE_KEYSTORE_BASE64: ${{ secrets.RELEASE_KEYSTORE_BASE64 }}

   - name: Build Official Release APK
     working-directory: ./android
     run: |
       gradle assembleRelease -PversionCode=${{ github.run_number }} -PversionName="1.0.${{ github.run_number }}" --no-daemon
     env:
       KEYSTORE_PATH: "release.jks"
       KEYSTORE_PASSWORD: ${{ secrets.RELEASE_STORE_PASSWORD }}
       KEY_ALIAS: ${{ secrets.RELEASE_KEY_ALIAS }}
       KEY_PASSWORD: ${{ secrets.RELEASE_KEY_PASSWORD }}
       CI: "true"
   ```

---

## 3. Compatibility Analysis & 3-Step Migration Strategy

### A. Target Android Platform Demographics
- **Application Configuration:** `minSdkVersion = 24` (Android 7.0 Nougat), `targetSdkVersion = 34` (Android 14 UpsideDownCake).
- **Package Installer Enforcement:** Android OS verifies that incoming APK updates match the signing certificate of the currently installed app. A certificate mismatch immediately aborts installation with `INSTALL_FAILED_UPDATE_INCOMPATIBLE`.

### B. Distinct Migration Paths

```
                                  ┌─────────────────────────────────────────┐
                                  │   Step 1: Baseline Preservation (Now)   │
                                  │   Keep existing key in CI via Secrets   │
                                  └────────────────────┬────────────────────┘
                                                       │
                                  ┌────────────────────▼────────────────────┐
                                  │   Step 2: Dual-Key Rotation (M1 Final)  │
                                  │   Generate New Key + Scheme v3 Lineage  │
                                  └────────────────────┬────────────────────┘
                                                       │
                           ┌───────────────────────────┴───────────────────────────┐
                           ▼                                                       ▼
        ┌─────────────────────────────────────┐                 ┌─────────────────────────────────────┐
        │       Android 9+ (API 28+)          │                 │     Android 7.0 - 8.1 (API 24-27)   │
        │    ~90%+ of user installations      │                 │      ~10% of legacy installations   │
        │  Seamless In-App Update Supported   │                 │  Scheme v3 lineage not supported    │
        │  via APK Signature Scheme v3 Proof  │                 │  Clean reinstall needed on Cutover  │
        └─────────────────────────────────────┘                 └─────────────────────────────────────┘
```

1. **Step 1: Temporary Baseline Preservation (Current Intermediate Phase)**
   - Maintain the existing signing key injected via CI secrets to guarantee 100% update continuity for all existing users while backend and frontend security hardening takes place.
2. **Step 2: Cryptographic Scheme v3 Key Rotation (Supported Devices)**
   - Generate a new private release keystore (`release-v2.jks`) stored strictly in GitHub Secrets and offline cold storage.
   - Use Android SDK `apksigner rotate --out-lineage lineage.bin --old-signer ... --new-signer ...` to create a cryptographic proof of succession.
   - Sign the APK with both the old and new certificates using `--lineage lineage.bin`.
   - **Supported Devices:** Android 9.0+ (API 28+) automatically and seamlessly updates.
3. **Step 3: Major Version Cutover (v2.0.0 for Legacy Devices)**
   - For legacy Android 7.0–8.1 devices, publish an in-app notice and release note informing users that v2.0.0 requires an uninstall/reinstall if the old exposed key is permanently retired.

---

## 4. Isolated Upgrade Verification Test Protocol

Before releasing any new APK build, the following test protocol must be executed:

1. **Baseline Setup:**
   Install current production release (`v1.0.23`) on a connected test device or Android emulator:
   ```bash
   adb install WhatsApp-Scheduler-v1.0.23.apk
   ```
2. **State Seeding:**
   Launch the app, complete initial setup, import contacts, pair a test WhatsApp session, and create scheduled messages.
3. **In-Place Upgrade Execution:**
   Attempt in-place package update with the candidate build:
   ```bash
   adb install -r WhatsApp-Scheduler-candidate.apk
   ```
4. **Verification Gates:**
   - Command output must return `Success` (exit code `0`).
   - `apksigner verify --verbose --print-certs WhatsApp-Scheduler-candidate.apk` must confirm valid signature scheme and lineage chain.
   - Reopening the app must confirm that all SQLite tables, user settings, contacts, and active WhatsApp session remain intact without crashing.

---

## 5. Security & Governance Rules

- **Zero Exposure:** Secret passwords and private keys are never printed in logs, test suites, or documentation.
- **No Premature Deletion:** The legacy keystore is retained locally until the user formally approves key rotation.
- **Git Protection:** `.gitignore` includes `*.jks`, `*.keystore`, `keystore.properties`, and `signing.properties`.
- **Status:** Finding `SEC-003` remains **OPEN / DOCUMENTED** and will be formally resolved only after key rotation and CI secret configuration are fully verified.
