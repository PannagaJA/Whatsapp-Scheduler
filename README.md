# 📱 WhatsApp 24/7 Cloud & Android Mobile Scheduler

<div align="center">

**A standalone, 24/7 WhatsApp message scheduler powered by Baileys Multi-Device engine with a featherweight native Android App & Automated GitHub Actions APK Builder.**

[![Android APK Build](https://github.com/pannagaja/Whatsapp-Scheduler/actions/workflows/build-apk.yml/badge.svg)](https://github.com/pannagaja/Whatsapp-Scheduler/actions/workflows/build-apk.yml)
[![Node.js Version](https://img.shields.io/badge/node-%3E%3D18.0.0-brightgreen.svg)](https://nodejs.org/)
[![License](https://img.shields.io/badge/license-MIT-informational.svg)](LICENSE)

</div>

---

## 📌 Architecture Overview

This repository contains the complete mobile and cloud ecosystem for scheduling WhatsApp messages 24/7 without needing your laptop or browser to stay open:

```text
Whatsapp-Scheduler/
│
├── 📱 android/              # Native Android App source (Ultra-lightweight ~2MB APK)
│   ├── app/src/main/
│   │   ├── AndroidManifest.xml (READ_CONTACTS permission)
│   │   └── java/.../MainActivity.java (Native contact bridge & WebView)
│   └── build.gradle
│
├── ☁️ mobile-server/        # 24/7 Baileys WhatsApp Cloud Backend & PWA
│   ├── engine.js            # Multi-device WhatsApp engine & socket daemon
│   ├── server.js            # REST API endpoints & contact sync
│   ├── db.js                # Persistent SQLite database
│   ├── scheduler.js         # Cron job message dispatcher
│   └── pwa/                 # Responsive mobile web app interface
│
└── 🤖 .github/workflows/    # 1-Click Cloud APK Builder
    └── build-apk.yml        # Automatically compiles WhatsApp-Scheduler.apk
```

---

## ✨ Features

- **24/7 Cloud Execution**: Schedules execute reliably in the cloud (Render / VPS / Local Server) even when your phone is turned off or has no internet.
- **⚡ 1-Tap Phonebook Sync**: The Native Android APK requests `READ_CONTACTS` permission to instantly import all 1,000+ contacts & exact names in 0.1s.
- **Lightweight APK**: Under **2.5 MB** — zero bloat, pure native Android WebView with hardware acceleration.
- **Automated GitHub Actions Builder**: Every `git push` automatically compiles and outputs `WhatsApp-Scheduler.apk` under the GitHub Actions **Artifacts** tab.
- **Rich Message Support**: Schedule text messages, images, PDFs, spreadsheets, and videos with custom captions.
- **Recurring Schedules**: Daily, Weekly, Monthly, or Custom CRON patterns.

---

## 🚀 Getting Started

### 1. 📲 Download or Build the Android App (APK)

#### Option A: 1-Click Automated Cloud Build (GitHub Actions)
1. Push this repository to GitHub:
   ```bash
   git add .
   git commit -m "feat: Mobile scheduler & native Android app"
   git push origin main
   ```
2. Go to the **Actions** tab on your GitHub repository.
3. Click the latest **"Build Android APK"** workflow run.
4. Under **Artifacts** at the bottom, tap **`WhatsApp-Scheduler-APK`** to download `WhatsApp-Scheduler.apk` directly to your phone.

#### Option B: Run the Cloud Backend Locally
```bash
cd mobile-server
npm install
npm start
```
Then visit `http://localhost:3000` in your browser.

---

## 🔒 Security & Privacy

- Authentication credentials (`auth_info_baileys/`) and SQLite databases (`scheduler.db`) are strictly ignored by `.gitignore` and never committed.
- End-to-end encryption keys are generated locally via Baileys and stored exclusively in your secure environment.

---

## 📄 License

Distributed under the MIT License.
