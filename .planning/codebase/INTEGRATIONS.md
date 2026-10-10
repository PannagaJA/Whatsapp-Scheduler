# External Integrations & Services

**Target Repository:** `PannagaJA/Whatsapp-Scheduler`  
**Generated:** October 10, 2026

---

## 1. WhatsApp Multi-Device Protocol (`@whiskeysockets/baileys`)
- **Protocol:** Reverse-engineered WhatsApp Web WebSocket protocol.
- **Authentication:** 8-digit Pairing Code (`sock.requestPairingCode(phoneNumber)`) or QR code scanning (`sock.ev.on("connection.update")`).
- **Session Material:** Stored locally in `data/auth_info_baileys/` using `useMultiFileAuthState`.
- **Event Listeners:**
  - `creds.update`: Auto-saves cryptographic session state.
  - `connection.update`: Manages connection lifecycle (`connecting`, `open`, `close`), reconnect loops, and logout cleanup.
  - `messaging-history.set`, `contacts.set`, `contacts.upsert`, `chats.set`, `messages.upsert`: Real-time contact and chat synchronization.
- **Outbound Dispatch:** `sock.sendMessage(jid, { text, image, video, audio, document })`.

---

## 2. GitHub Releases API (APK Auto-Updater)
- **Endpoint:** `https://api.github.com/repos/PannagaJA/Whatsapp-Scheduler/releases/latest` or backend proxy `GET /api/version`.
- **Functionality:** Checks latest release tag vs installed version (`getAppVersionName()`), downloads APK asset (`WhatsApp-Scheduler.apk`), and initiates Android `FileProvider` package installation.

---

## 3. Android System Bridges & Contracts
- **Address Book:** `android.provider.ContactsContract.CommonDataKinds.Phone` query via ContentResolver in `MainActivity.java`.
- **Clipboard Manager:** `android.content.ClipboardManager` for pairing code copying.
- **Web Share Target API:** Android shares routed via PWA manifest `share_target` into `POST /share-target` endpoint.
- **File Provider:** `androidx.core.content.FileProvider` for APK installation intents.
