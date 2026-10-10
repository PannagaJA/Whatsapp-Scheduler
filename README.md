# 📱 WhatsApp 24/7 Cloud & Android Mobile Scheduler

<div align="center">

**A high-performance, enterprise-grade 24/7 WhatsApp message scheduler powered by Baileys Multi-Device engine with strict multi-user tenant isolation, a responsive PWA, and a featherweight native Android companion app with real-time OTA updates.**

[![Android APK Build](https://github.com/pannagaja/Whatsapp-Scheduler/actions/workflows/build-apk.yml/badge.svg)](https://github.com/pannagaja/Whatsapp-Scheduler/actions/workflows/build-apk.yml)
[![Node.js Version](https://img.shields.io/badge/Node.js-%3E%3D18.0.0-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
[![Engine](https://img.shields.io/badge/Engine-Baileys%20Multi--Device-25D366?logo=whatsapp&logoColor=white)](https://github.com/WhiskeySockets/Baileys)
[![Multi-Tenant Architecture](https://img.shields.io/badge/Architecture-Multi--User%20Isolated-blueviolet)](#-multi-tenant-architecture--security)
[![Tests Passing](https://img.shields.io/badge/Tests-103%2F103%20Passing-brightgreen)](#-test-suite--quality-assurance)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

[Features](#-key-features) • [Architecture](#-architecture-overview) • [Deployment](#-production-deployment) • [Admin Setup](#-administrator-provisioning) • [Android Companion](#-native-android-companion-app) • [Configuration](#-environment-variables)

</div>

---

## 🌟 Key Features

- **🕒 24/7 Autonomous Cloud Execution**: Schedules dispatch reliably in the cloud (Render, Docker, VPS, or self-hosted) even if your personal phone is powered off, in airplane mode, or has no internet connection.
- **🛡️ Multi-Tenant User Isolation**: Every user account operates in complete isolation:
  - Dedicated, isolated WhatsApp Baileys session credentials (`data/sessions/<userId>/`).
  - Scoped database queries preventing any cross-user data leakage (schedules, contacts, and logs).
  - Isolated file attachment directories (`data/uploads/<userId>/`) with strict path traversal defenses.
- **📱 Featherweight Native Android Companion (~2.3 MB)**:
  - Native phonebook sync via `READ_CONTACTS` bridge importing 1,000+ contacts with exact names in milliseconds.
  - Built-in In-App OTA Updater with real-time download progress bar, byte counters, and native package installer launch (with automatic browser fallback).
  - Zero bloat, hardware-accelerated WebView container with strict origin allowlisting.
- **⚡ Progressive Web App (PWA) with Share Target**:
  - Installable directly to home screens on iOS and Android.
  - Native Share Target integration: select images, PDFs, CSVs, or text in WhatsApp/Gallery and share directly into the Scheduler.
- **👑 Administrative Governance & Management**:
  - Dedicated web administration panel with live metrics, user auditing, session revocation, and role management.
  - Safe bootstrapping via environment variables or standalone CLI tool (`node create-admin.js`).
  - Self-deletion and last-admin deletion safeguards.
- **🔒 Defensive Security Hardening**:
  - Argon2id password hashing with brute-force rate limiters.
  - Strict CORS origin whitelisting (fail-closed in production).
  - CSRF protection, secure HTTP-only cookie sessions, and sanitized error responses.
  - MIME-type sniffing validation and magic number verification for uploaded media attachments.
- **📊 Health Checks & Monitoring**:
  - Dedicated `/health` and `/api/health` endpoints designed for 24/7 uptime monitoring (e.g., UptimeRobot, Render health checks).

---

## 🏛️ Architecture Overview

```text
┌────────────────────────────────────────────────────────────────────────┐
│                          CLIENT INTERFACES                             │
├───────────────────────────────────┬────────────────────────────────────┤
│   Native Android Companion App   │    Progressive Web App (PWA)       │
│  - Hardware Accelerated WebView   │  - Service Worker Caching          │
│  - In-App OTA Updater Engine      │  - Native Web Share Target         │
│  - Contacts Provider Bridge       │  - Responsive Mobile / Desktop UI  │
└─────────────────┬─────────────────┴──────────────────┬─────────────────┘
                  │                                    │
                  ▼                                    ▼
┌────────────────────────────────────────────────────────────────────────┐
│                     BACKEND & SECURITY GATEWAY                         │
│                    (Express / Node.js 18+ / PM2)                       │
├────────────────────────────────────────────────────────────────────────┤
│  • CORS Origin Allowlist           • Rate Limiters & Brute Force Defense│
│  • Argon2id Multi-Tenant Auth      • Secure Cookie / Session Tokens    │
│  • File Type & MIME Magic Sniffer  • Administrative Control Plane      │
└─────────────────┬────────────────────────────────────┬─────────────────┘
                  │                                    │
                  ▼                                    ▼
┌───────────────────────────────────┐┌───────────────────────────────────┐
│     MULTI-TENANT WA ENGINE        ││       PERSISTENT DATA STORE       │
├───────────────────────────────────┤├───────────────────────────────────┤
│  • Baileys Multi-Device Sockets   ││  • SQLite3 (WAL Mode Enabled)     │
│  • Isolated per-user Auth State   ││  • User-Scoped Task Records       │
│  • QR Code & Phone Pairing Flows  ││  • Isolated Contact Storage       │
│  • Safe Auto-Reconnect & Backoff  ││  • Sandboxed Attachment Vault     │
└───────────────────────────────────┘└───────────────────────────────────┘
```

---

## 📁 Repository Directory Structure

```text
Whatsapp-Scheduler/
│
├── 📱 android/                       # Native Android Application Source
│   ├── app/src/main/
│   │   ├── AndroidManifest.xml       # Permissions, FileProvider & Network Config
│   │   ├── java/.../MainActivity.java# Native contact bridge, OTA updater & WebView
│   │   └── res/                      # Icons, layouts, network security XML
│   ├── build.gradle                  # Root Gradle build script
│   └── settings.gradle
│
├── ☁️ mobile-server/                 # 24/7 Autonomous Backend & PWA
│   ├── auth.js                       # Argon2id auth, role middleware & admin bootstrap
│   ├── create-admin.js               # Standalone Admin provisioning CLI tool
│   ├── db.js                         # SQLite initialization & scoped query helpers
│   ├── engine.js                     # Multi-tenant Baileys WhatsApp connection manager
│   ├── fileValidator.js              # Media upload sanitization & magic number checks
│   ├── rateLimiter.js                # Distributed endpoint rate limiters
│   ├── scheduler.js                  # Persistent Cron job dispatcher & retry queues
│   ├── server.js                     # REST API gateway & static PWA server
│   ├── Dockerfile                    # Production container specification
│   ├── render.yaml                   # 1-Click Render Cloud blueprint
│   ├── .env.example                  # Environment configuration template
│   │
│   ├── pwa/                          # Progressive Web App frontend
│   │   ├── index.html                # Responsive mobile-first interface
│   │   ├── app.js                    # SPA state machine, pairing & progress UI
│   │   ├── style.css                 # Modern CSS design system & dark mode
│   │   ├── sw.js                     # Offline cache & push service worker
│   │   └── manifest.json             # Web App Manifest & Web Share Target
│   │
│   └── test/                         # Comprehensive automated test suite
│       ├── run-all-tests.js          # Master test orchestrator (103/103 tests)
│       ├── multi-user-isolation.test.js
│       ├── audit-verification.test.js
│       ├── audit-fixes.test.js
│       └── security-phase[1-4].test.js
│
├── 🤖 .github/workflows/             # Continuous Integration & Delivery
│   └── build-apk.yml                 # Automated Cloud APK Compiler
│
├── .dockerignore                     # Production Docker build exclusions
├── .gitignore                        # Strict production file & secret exclusions
└── render.yaml                       # Root Render infrastructure deployment spec
```

---

## 🚀 Production Deployment

### Option 1: Render.com 1-Click Cloud Deployment (Recommended)

Render provides an easy, automated environment with free persistent disk support for preserving user sessions across redeployments:

1. Fork or push this repository to your GitHub account.
2. In the [Render Dashboard](https://dashboard.render.com/), click **New +** ➔ **Blueprint** (or **Web Service**).
3. Connect your repository. Render will automatically detect [`render.yaml`](file:///Users/pannagaja/Desktop/Projects/Whatsapp-Scheduler/render.yaml).
4. Configure your environment variables in the Render settings:
   - `NODE_ENV`: `production`
   - `ALLOWED_ORIGINS`: `https://your-scheduler.onrender.com` *(Must match your public URL)*
   - `ADMIN_USERNAME`: `admin` *(Optional: bootstrap initial administrator)*
   - `ADMIN_PASSWORD`: `YourSecurePassword123!` *(Optional: bootstrap initial administrator)*
5. **Attach a Persistent Disk**: Mount `/var/data` (size: 1 GB minimum) to retain database records, session keys, and attachments permanently.
6. **24/7 Keep-Alive**: Add your URL (`https://your-scheduler.onrender.com/health`) to a free uptime monitor such as [UptimeRobot](https://uptimerobot.com/) (ping every 5 minutes) to ensure the service remains active around the clock.

---

### Option 2: Docker Container Deployment

Run the complete platform inside a secure, containerized environment:

```bash
# 1. Clone the repository
git clone https://github.com/PannagaJA/Whatsapp-Scheduler.git
cd Whatsapp-Scheduler/mobile-server

# 2. Build the Docker container image
docker build -t whatsapp-scheduler .

# 3. Run the container with persistent storage mount
docker run -d \
  --name whatsapp-scheduler \
  --restart unless-stopped \
  -p 3000:3000 \
  -v $(pwd)/data:/app/data \
  -e NODE_ENV=production \
  -e ALLOWED_ORIGINS="https://scheduler.yourdomain.com,http://localhost:3000" \
  -e ADMIN_USERNAME="admin" \
  -e ADMIN_PASSWORD="ChangeThisPassword123!" \
  whatsapp-scheduler
```

---

### Option 3: Self-Hosted Linux VPS (Ubuntu / Debian + PM2 + Nginx)

For maximum control and zero hosting costs on cloud VPS providers (e.g., Oracle Cloud Always Free, DigitalOcean, Hetzner, AWS EC2):

```bash
# 1. Update system and install Node.js 20 LTS & build dependencies
sudo apt-get update && sudo apt-get install -y curl git build-essential
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs

# 2. Clone repository & install server dependencies
git clone https://github.com/PannagaJA/Whatsapp-Scheduler.git
cd Whatsapp-Scheduler/mobile-server
npm install --production

# 3. Create production environment file
cp .env.example .env
nano .env # Set your ALLOWED_ORIGINS, ADMIN_USERNAME, and ADMIN_PASSWORD

# 4. Start and daemonize with PM2
sudo npm install -g pm2
pm2 start server.js --name "whatsapp-scheduler"
pm2 startup
pm2 save

# 5. (Optional) Configure Nginx reverse proxy with SSL
# Proxy pass port 3000 with WebSocket headers:
#   proxy_set_header Upgrade $http_upgrade;
#   proxy_set_header Connection "upgrade";
```

---

### Option 4: Local Development

```bash
cd mobile-server
npm install
npm start
```

Visit `http://localhost:3000` in your browser.

---

## 👑 Administrator Provisioning

The application features full administrative governance. You can provision an administrator through two straightforward methods:

### Method A: Environment Bootstrap (Automatic on Startup)
Specify the administrator credentials in your environment variables:
```bash
ADMIN_USERNAME=admin
ADMIN_PASSWORD=MyStrongAdminPassword123!
```
Upon startup, the server automatically checks if an admin account exists. If not, it creates the specified administrator securely using Argon2id.

### Method B: Standalone CLI Tool (Anytime)
Create or promote an administrator directly from the command line without restarting the server:
```bash
cd mobile-server
node create-admin.js <username> <password>
```
*Example:*
```bash
node create-admin.js root SuperSecretPass2026!
```

---

## 📱 Native Android Companion App

The native Android app (`android/`) provides a lightweight native wrapper (~2.3 MB) that connects directly to your backend while adding native device capabilities:

### 1. Automated Cloud Builds (GitHub Actions)
Every push or tag automatically compiles the release APK via GitHub Actions.
1. Navigate to the **Actions** tab in your GitHub repository.
2. Select the latest **"Build Android APK"** workflow.
3. Download the compiled `WhatsApp-Scheduler-APK` from the **Artifacts** section.

### 2. Native Capabilities
- **1-Tap Contact Book Sync**: Directly accesses native Android contacts through the `READ_CONTACTS` permission and transmits names/phone numbers to the Scheduler in under 0.2 seconds.
- **In-App OTA Updates**:
  - Automatically queries GitHub Releases or your server for updates.
  - Features an in-app download progress bar showing the exact percentage and byte count in real time.
  - Automatically triggers the native Android package installer when complete, with an automatic browser download fallback if direct install is restricted.

### 3. Local APK Compilation
To compile the APK locally using the Gradle wrapper:
```bash
cd android
./gradlew assembleRelease
```
The output APK will be generated at `android/app/build/outputs/apk/release/app-release.apk`.

---

## ⚙️ Environment Variables

| Variable | Description | Required in Production | Default Value | Example |
| :--- | :--- | :---: | :---: | :--- |
| `NODE_ENV` | Application environment mode (`production` / `development`) | Yes | `development` | `production` |
| `PORT` | Network port for the HTTP/WebSocket server | No | `3000` | `3000` |
| `ALLOWED_ORIGINS` | Comma-separated list of whitelisted origins for CORS/CSRF | **Yes** | Fallback / Localhost | `https://scheduler.example.com` |
| `ADMIN_USERNAME` | Username for the initial bootstrap administrator account | No | None | `admin` |
| `ADMIN_PASSWORD` | Password for the initial bootstrap administrator account | No | None | `MySecureAdminKey99!` |
| `ALLOW_PUBLIC_REGISTRATION` | Whether non-admin users can sign up freely (`true`/`false`) | No | `true` | `false` (Private instance) |
| `DATA_DIR` | Directory path where SQLite database, sessions, and files live | No | `./data` | `/var/data` |
| `WA_SYNC_FULL_HISTORY` | Sync complete historical chats upon pairing (`true`/`false`) | No | `false` | `false` |

---

## 🔒 Multi-Tenant Architecture & Security

Data confidentiality and operational isolation are core design requirements:

1. **User Isolation Boundary**:
   - Each user authenticates with an Argon2id-hashed credential and receives a cryptographically secure session token.
   - WhatsApp sessions are segregated on the filesystem: `data/sessions/<userId>/`. A logout or disconnection for User A has zero effect on User B.
   - Database operations enforce user boundaries on all queries (`WHERE user_id = ?`). IDOR attacks targeting other users' tasks or contacts are blocked.
2. **File Upload Hardening**:
   - Files are validated against allowable MIME types and verified using magic byte sniffing.
   - File storage paths are sandboxed: `data/uploads/<userId>/`. Path traversal payloads (`../`) are rejected with `HTTP 400`.
3. **Resilient Job Scheduling**:
   - Scheduler jobs are claimed using atomic SQL transactions, preventing race conditions even when running concurrent workers.
   - Orphaned jobs from unexpected server crashes are detected and safely recovered on boot.

---

## 🧪 Test Suite & Quality Assurance

The codebase includes an automated test harness covering security, multi-tenancy, rate limiting, and administrative lifecycle flows:

```bash
cd mobile-server
node test/run-all-tests.js
```

**Results:**
```text
=================================================================
Phase 1 Security Suite:      17 Passed, 0 Failed
Phase 2 Isolation Suite:     11 Passed, 0 Failed
Phase 3 Defense Suite:       23 Passed, 0 Failed
Phase 4 Integration Suite:    5 Passed, 0 Failed
Multi-User Regression Suite: 13 Passed, 0 Failed
Audit Verification Suite:     7 Passed, 0 Failed
Audit Fixes & Admin Suite:    9 Passed, 0 Failed
=================================================================
🎉 ALL 103 TEST CASES COMPLETED WITH 100% SUCCESS!
=================================================================
```

---

## 📡 REST API & Health Endpoints

| Endpoint | Method | Access | Description |
| :--- | :---: | :---: | :--- |
| `/health` | `GET` | Public | System uptime & health check for monitors |
| `/api/health` | `GET` | Public | JSON health metrics & database readiness |
| `/api/auth/register` | `POST` | Public | Register new user account |
| `/api/auth/login` | `POST` | Public | Authenticate user & issue session cookie |
| `/api/auth/logout` | `POST` | User | Terminate current user session |
| `/api/auth/me` | `GET` | User | Retrieve current user profile and role |
| `/api/tasks` | `GET` | User | List all scheduled tasks for authenticated user |
| `/api/tasks` | `POST` | User | Schedule a new message (text, media, recurring) |
| `/api/tasks/:id` | `DELETE` | User | Cancel and delete scheduled task |
| `/api/contacts` | `GET` | User | Search and list user's synchronized contacts |
| `/api/contacts/bulk` | `POST` | User | Batch sync contacts from Android companion |
| `/api/status` | `GET` | User | Get current user's WhatsApp pairing state |
| `/api/pair` | `POST` | User | Request 8-digit phone pairing code |
| `/api/admin/users` | `GET` | Admin | List all registered accounts |
| `/api/admin/users` | `POST` | Admin | Create user account directly |
| `/api/admin/users/:id` | `DELETE` | Admin | Delete user account and wipe session state |
| `/api/admin/security/metrics`| `GET` | Admin | Retrieve security & audit metrics |

---

## 📄 License

This project is licensed under the terms of the **MIT License**. See the [LICENSE](LICENSE) file for full details.

---

<div align="center">
<sub>Built with ❤️ for reliable, autonomous, and private WhatsApp scheduling.</sub>
</div>
