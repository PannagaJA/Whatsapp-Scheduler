# Codebase Directory Structure

**Target Repository:** `PannagaJA/Whatsapp-Scheduler`  
**Generated:** October 10, 2026

```
.
├── .github/
│   └── workflows/
│       └── build-apk.yml               # GitHub Actions CI for compiling & releasing Android APK
├── android/
│   ├── app/
│   │   ├── app-release.jks             # [EXPOSED KEYSTORE - TO BE REMOVED/ROTATED]
│   │   ├── build.gradle                # App module build config & dependencies
│   │   ├── proguard-rules.pro          # ProGuard obfuscation rules
│   │   └── src/main/
│   │       ├── AndroidManifest.xml     # App permissions, activities, file provider
│   │       ├── java/com/whatsapp/scheduler/
│   │       │   └── MainActivity.java   # WebView setup & AndroidNative JavaScript bridge
│   │       └── res/                    # Icons, layouts, styles, file paths
│   ├── build.gradle                    # Root Android build script
│   ├── gradle.properties               # Gradle JVM options
│   └── settings.gradle                 # Android project module inclusion
├── mobile-server/
│   ├── data/                           # Runtime persistent storage (ignored in git)
│   │   ├── auth_info_baileys/          # WhatsApp session auth credentials
│   │   ├── scheduler.db                # SQLite database (schedules, contacts, settings)
│   │   └── uploads/                    # Temporary staging directory for attachments
│   ├── pwa/
│   │   ├── app.js                      # Client PWA JavaScript (UI logic, scheduling, modals)
│   │   ├── icons/                      # App icon assets (64px, 192px, 512px, favicon)
│   │   ├── index.html                  # Single-page PWA layout (Schedule, Queue, Device tabs)
│   │   ├── manifest.json               # Web App Manifest & Web Share Target configuration
│   │   ├── style.css                   # Custom responsive CSS design system
│   │   └── sw.js                       # Service worker with Network-First caching strategy
│   ├── db.js                           # SQLite database connection & schema initialization
│   ├── Dockerfile                      # Production Docker container build definition
│   ├── engine.js                       # Baileys WhatsApp engine & socket event handling
│   ├── package.json                    # Backend Node.js dependencies & scripts
│   ├── package-lock.json               # Dependency version lockfile
│   ├── render.yaml                     # Render deployment manifest for mobile-server
│   ├── scheduler.js                    # 5-second polling background message dispatcher
│   └── server.js                       # Main Express application & REST API router
├── .gitignore                          # Git ignore definitions
├── README.md                           # Project overview and documentation
├── SECURITY_AUDIT_REPORT.md            # Comprehensive pre-production security audit
└── SECURITY_REMEDIATION_CHECKLIST.md   # Prioritized security remediation checklist
```
