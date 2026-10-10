# Technology Stack & Environment

**Target Repository:** `PannagaJA/Whatsapp-Scheduler`  
**Generated:** October 10, 2026

---

## 1. Core Languages & Runtime
- **Node.js (Backend):** JavaScript / Node.js 20 (`node:20-slim` in Docker). Runs Express REST API, SQLite driver, and Baileys multi-device engine.
- **Java (Android Client):** Java 17, Android SDK (compileSdk 34, minSdk 24, targetSdk 34) wrapping a full-screen WebView with a JavaScript native interface.
- **Frontend / PWA:** HTML5, Vanilla JavaScript (ES6+), CSS3 (Modern dark-mode design system with Plus Jakarta Sans typography), Service Worker (PWA cache & Web Share Target API).

---

## 2. Dependencies & Frameworks

### Backend (`mobile-server/package.json`)
| Package | Version | Purpose |
| :--- | :---: | :--- |
| `express` | `^4.19.2` | Core HTTP/REST API server & static asset hosting |
| `@whiskeysockets/baileys` | `^6.7.8` | WhatsApp multi-device WebSocket client integration |
| `sqlite3` | `^5.1.7` | Embedded relational database driver with WAL mode |
| `multer` | `^1.4.5-lts.1` | Multipart file upload middleware for attachments |
| `cors` | `^2.8.5` | Cross-Origin Resource Sharing handling |
| `qrcode` | `^1.5.3` | QR code generation for WhatsApp linking |
| `pino` | `^8.21.0` | High-performance logger used by Baileys |

### Android Client (`android/app/build.gradle`)
| Library | Version | Purpose |
| :--- | :---: | :--- |
| `androidx.appcompat:appcompat` | `1.6.1` | Modern Android backward-compatible base activities |
| `com.google.android.material:material` | `1.11.0` | Material design widgets |
| `androidx.swiperefreshlayout:swiperefreshlayout` | `1.1.0` | Pull-to-refresh container for WebView |

---

## 3. Infrastructure & Deployment
- **Cloud Platform:** Render Web Service (`render.yaml`).
- **Disk Persistence:** 1GB Render persistent disk mounted at `/var/data` for `scheduler.db`, `uploads/`, and `auth_info_baileys/`.
- **CI/CD:** GitHub Actions (`.github/workflows/build-apk.yml`) compiling debug APKs and publishing releases on Git tag pushes.
- **Containerization:** `mobile-server/Dockerfile` based on `node:20-slim` with Python/make/g++ build dependencies for SQLite native compilation.
