# 📱 WhatsApp Scheduler Mobile PWA & Autonomous Cloud Server

<div align="center">

**A standalone, 100% Free 24/7 Mobile Progressive Web App (PWA) with native Web Share Target integration & Baileys Multi-Device WhatsApp Engine.**

</div>

---

## 🌟 How It Works on Your Mobile Phone

1. **Native Share Integration**:
   - Open your official **WhatsApp app** (or Gallery, Files, Sheets).
   - Select any message, photo, CSV, PDF, or video.
   - Tap **Share / Forward** ➔ Tap **"WhatsApp Scheduler"**.
   - The PWA opens instantly with your files and text pre-filled!
2. **Schedule**:
   - Choose your recipient (with instant auto-complete from your WhatsApp contacts).
   - Tap a quick time chip (`+15 min`, `+1 hr`, `Tomorrow 9 AM`) or select exact date/time.
   - Tap **"Schedule Message"**.
3. **Autonomous Delivery**:
   - **Even if your phone is turned off, in airplane mode, or your laptop is closed**, the server will send the message and attachments on time through your linked WhatsApp session.

---

## 🚀 100% Free 24/7 Deployment Options

### Option 1: Oracle Cloud Always-Free Tier (Recommended — Most Powerful, True $0 Forever)

1. Create a free account at [Oracle Cloud Always Free](https://www.oracle.com/cloud/free/).
2. Create an **Ubuntu Compute Instance** (Select the Always-Free eligible shape: AMD or Ampere ARM).
3. Connect via SSH and run:
   ```bash
   # 1. Clone your repo
   git clone https://github.com/PannagaJA/Whatsapp-Scheduler.git
   cd Whatsapp-Scheduler/mobile-server

   # 2. Install Node.js 20 & build tools
   curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
   sudo apt-get install -y nodejs build-essential

   # 3. Install dependencies
   npm install

   # 4. Run persistently with PM2
   sudo npm install -g pm2
   pm2 start server.js --name "wa-scheduler"
   pm2 startup
   pm2 save
   ```
4. Allow port `3000` (or setup Nginx reverse proxy with free Let's Encrypt SSL via `certbot`).
5. Open `https://your-server-domain.com` in mobile Safari or Chrome!

---

### Option 2: Render.com (1-Click Free Hosting)

1. Create a free account on [Render.com](https://render.com/).
2. Click **New +** ➔ **Web Service** ➔ Connect your GitHub repository.
3. Set **Root Directory** to `mobile-server`.
4. **Build Command**: `npm install`
5. **Start Command**: `node server.js`
6. Add a free persistent disk mount (`/app/data`) so your WhatsApp login session stays preserved across deploys.
7. To keep the free tier awake 24/7, add your Render URL to [UptimeRobot.com](https://uptimerobot.com/) (100% free, pings every 5 minutes).

---

### Option 3: Run on Any Old Android Phone (via Termux — 100% Free at Home)

1. Install **Termux** from F-Droid on an old phone.
2. In Termux, run:
   ```bash
   pkg update && pkg install nodejs-lts git python make clang
   git clone https://github.com/PannagaJA/Whatsapp-Scheduler.git
   cd Whatsapp-Scheduler/mobile-server
   npm install
   node server.js
   ```
3. Keep the old phone connected to home Wi-Fi and charger.

---

## 📲 How to Install the PWA on Your Phone

### On Android (Chrome / Brave / Samsung Internet):
1. Open your server URL (e.g. `https://your-domain.com`) in Chrome.
2. Tap the three dots (⋮) in the top-right ➔ tap **"Install App"** (or **"Add to Home screen"**).
3. The app will now appear in your phone's app drawer and automatically register with the **Android Native Share Sheet**!

### On iPhone (Safari):
1. Open your server URL in Safari.
2. Tap the **Share** button (box with arrow) at the bottom.
3. Tap **"Add to Home Screen"**.

---

## 🔗 One-Time Device Pairing

1. Open the app on your phone.
2. Tap the **Device Link** tab at the bottom.
3. Tap **"Show QR Code"** and scan with WhatsApp on your primary phone (WhatsApp > Settings > Linked Devices > Link a Device).
4. *Alternatively*: Tap **"8-Digit Pairing Code"**, enter your phone number, and type the 8-digit code received in WhatsApp notifications!

---

## 🛡️ Security & Privacy

- **Self-Hosted & Private**: Your credentials, messages, and attachments are stored exclusively in your local SQLite database (`data/scheduler.db`) on your private server.
- **No Third-Party Intermediaries**: All communication with WhatsApp servers is encrypted end-to-end using official WhatsApp protocols via the Baileys engine.
