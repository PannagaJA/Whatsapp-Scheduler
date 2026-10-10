document.addEventListener("DOMContentLoaded", () => {
  // DOM Elements - Navigation & Views
  const navItems = document.querySelectorAll(".nav-item");
  const paneSchedule = document.getElementById("paneSchedule");
  const paneQueue = document.getElementById("paneQueue");
  const paneDevice = document.getElementById("paneDevice");
  const headerStatus = document.getElementById("headerStatus");
  const linkDeviceBtn = document.getElementById("linkDeviceBtn");

  // DOM Elements - Schedule Form
  const scheduleForm = document.getElementById("scheduleForm");
  const recipientInput = document.getElementById("recipientInput");
  const contactsDropdown = document.getElementById("contactsDropdown");
  const messageInput = document.getElementById("messageInput");
  const dateInput = document.getElementById("dateInput");
  const timeInput = document.getElementById("timeInput");
  const addFileBtn = document.getElementById("addFileBtn");
  const filePicker = document.getElementById("filePicker");
  const filesList = document.getElementById("filesList");
  const submitScheduleBtn = document.getElementById("submitScheduleBtn");
  const pickNativeContactBtn = document.getElementById("pickNativeContactBtn");
  const phonebookGateCard = document.getElementById("phonebookGateCard");
  const btnGateSyncPhonebook = document.getElementById("btnGateSyncPhonebook");
  const waNotConnectedCard = document.getElementById("waNotConnectedCard");
  const scheduleStatusPill = document.getElementById("scheduleStatusPill");
  const btnGoToPair = document.getElementById("btnGoToPair");

  if (btnGateSyncPhonebook && pickNativeContactBtn) {
    btnGateSyncPhonebook.onclick = () => pickNativeContactBtn.click();
  }

  if (btnGoToPair) {
    btnGoToPair.onclick = () => {
      const devNav = document.querySelector('.nav-item[data-tab="paneDevice"]');
      if (devNav) devNav.click();
    };
  }

  // DOM Elements - Sync Banner
  const syncBanner = document.getElementById("syncBanner");
  const syncBannerText = document.getElementById("syncBannerText");
  const syncProgressBar = document.getElementById("syncProgressBar");
  const syncPercentBadge = document.getElementById("syncPercentBadge");

  // DOM Elements - Queue
  const queueList = document.getElementById("queueList");
  const refreshQueueBtn = document.getElementById("refreshQueueBtn");

  // DOM Elements - Device Link
  const devicePill = document.getElementById("devicePill");
  const deviceUserInfo = document.getElementById("deviceUserInfo");
  const showQrBtn = document.getElementById("showQrBtn");
  const showPairCodeBtn = document.getElementById("showPairCodeBtn");
  const logoutBox = document.getElementById("logoutBox");
  const logoutBtn = document.getElementById("logoutBtn");
  const deviceAppVersion = document.getElementById("deviceAppVersion");
  const btnDownloadApkDirect = document.getElementById("btnDownloadApkDirect");

  // DOM Elements - QR Modal
  const qrModal = document.getElementById("qrModal");
  const qrModalClose = document.getElementById("qrModalClose");
  const qrImg = document.getElementById("qrImg");
  const qrSpinner = document.getElementById("qrSpinner");
  const qrStatusText = document.getElementById("qrStatusText");

  // DOM Elements - Pair Code Modal
  const pairModal = document.getElementById("pairModal");
  const pairModalClose = document.getElementById("pairModalClose");
  const pairPhoneInput = document.getElementById("pairPhoneInput");
  const requestPairCodeBtn = document.getElementById("requestPairCodeBtn");
  const pairCodeDisplay = document.getElementById("pairCodeDisplay");
  const pairCodeResult = document.getElementById("pairCodeResult");

  // DOM Elements - Auth Modal (SEC-001)
  const authModal = document.getElementById("authModal");
  const authModalTitle = document.getElementById("authModalTitle");
  const authModalDesc = document.getElementById("authModalDesc");
  const authForm = document.getElementById("authForm");
  const authUsernameInput = document.getElementById("authUsernameInput");
  const authPasswordInput = document.getElementById("authPasswordInput");
  const authErrorMsg = document.getElementById("authErrorMsg");
  const authSubmitBtn = document.getElementById("authSubmitBtn");
  const authSubmitText = document.getElementById("authSubmitText");

  // State
  let authToken = localStorage.getItem("wa_auth_token") || "";
  let isSetupMode = false;
  let selectedFiles = [];
  let stagedFiles = [];
  let allContacts = [];
  const avatarCache = new Map();
  let qrPollInterval = null;
  let pairPollInterval = null;
  let statusPollInterval = null;

  async function authFetch(url, options = {}) {
    options.headers = options.headers || {};
    if (authToken) {
      if (options.headers instanceof Headers) {
        options.headers.set("Authorization", `Bearer ${authToken}`);
      } else {
        options.headers["Authorization"] = `Bearer ${authToken}`;
      }
    }

    try {
      const res = await fetch(url, options);
      if (res.status === 401 && !url.includes("/api/auth/")) {
        showAuthModal();
      }
      return res;
    } catch (err) {
      throw err;
    }
  }

  function showAuthModal() {
    if (!authModal) return;
    authModal.style.display = "flex";
    checkAuthSetup();
  }

  function hideAuthModal() {
    if (authModal) authModal.style.display = "none";
    if (authErrorMsg) authErrorMsg.style.display = "none";
  }

  async function checkAuthSetup() {
    try {
      const res = await fetch("/api/auth/setup-status");
      const data = await res.json();
      if (data?.setupRequired) {
        isSetupMode = true;
        if (authModalTitle) authModalTitle.textContent = "Initial Setup — Create Account";
        if (authModalDesc) authModalDesc.textContent = "Welcome! Create your administrator username and password to secure your scheduler:";
        if (authSubmitText) authSubmitText.textContent = "Create Account & Sign In";
      } else {
        isSetupMode = false;
        if (authModalTitle) authModalTitle.textContent = "Sign In";
        if (authModalDesc) authModalDesc.textContent = "Please sign in with your application credentials to continue:";
        if (authSubmitText) authSubmitText.textContent = "Sign In";
      }
    } catch (_) {}
  }

  if (authForm) {
    authForm.onsubmit = async (e) => {
      e.preventDefault();
      const username = (authUsernameInput?.value || "").trim();
      const password = authPasswordInput?.value || "";
      if (!username || !password) return;

      if (authSubmitBtn) authSubmitBtn.disabled = true;
      if (authErrorMsg) authErrorMsg.style.display = "none";

      const endpoint = isSetupMode ? "/api/auth/register" : "/api/auth/login";
      try {
        const res = await fetch(endpoint, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ username, password })
        });
        const data = await res.json();
        if (data.success && data.token) {
          authToken = data.token;
          localStorage.setItem("wa_auth_token", authToken);
          hideAuthModal();
          showToast("✓ Signed in successfully!");
          checkStatus();
          loadContacts();
          loadSchedules();
        } else {
          if (authErrorMsg) {
            authErrorMsg.textContent = data.error || "Authentication failed. Please check credentials.";
            authErrorMsg.style.display = "block";
          }
        }
      } catch (err) {
        if (authErrorMsg) {
          authErrorMsg.textContent = "Network error connecting to server.";
          authErrorMsg.style.display = "block";
        }
      } finally {
        if (authSubmitBtn) authSubmitBtn.disabled = false;
      }
    };
  }

  // Initial Auth Verification
  async function verifyInitialAuth() {
    if (!authToken) {
      showAuthModal();
      return;
    }
    try {
      const res = await fetch("/api/auth/me", {
        headers: { "Authorization": `Bearer ${authToken}` }
      });
      if (!res.ok) {
        showAuthModal();
      }
    } catch (_) {}
  }
  verifyInitialAuth();

  // Helper: Escape HTML
  
  // Universal Clipboard Copy Helper
  async function copyTextToClipboard(text, btnElement) {
    let copied = false;

    if (window.AndroidNative && typeof window.AndroidNative.copyToClipboard === "function") {
      try {
        window.AndroidNative.copyToClipboard(text);
        copied = true;
      } catch (_) {}
    }

    if (!copied && navigator.clipboard && window.isSecureContext) {
      try {
        await navigator.clipboard.writeText(text);
        copied = true;
      } catch (_) {
        copied = fallbackCopy(text);
      }
    }

    if (!copied) {
      copied = fallbackCopy(text);
    }

    if (copied) {
      showToast("✓ Pairing Code Copied!");

      if (btnElement) {
        btnElement.innerHTML = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg><span>Copied</span>`;
        setTimeout(() => {
          btnElement.innerHTML = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/></svg><span>Copy</span>`;
        }, 2500);
      }
    } else {
      showToast("Unable to copy code automatically.");
    }
  }

  function fallbackCopy(text) {
    try {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.left = "-9999px";
      ta.style.top = "-9999px";
      document.body.appendChild(ta);
      ta.focus();
      ta.select();
      const success = document.execCommand("copy");
      document.body.removeChild(ta);
      return Boolean(success);
    } catch (_) {
      return false;
    }
  }

  function escapeHtml(text) {
    if (!text) return "";
    return String(text)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }

  // Helper: Format Phone Number
  function formatPhone(phoneStr) {
    if (!phoneStr) return "";
    const digits = String(phoneStr).replace(/\D/g, "");
    if (digits.length === 10) {
      return `+91 ${digits.slice(0, 5)} ${digits.slice(5)}`;
    } else if (digits.length === 12 && digits.startsWith("91")) {
      return `+91 ${digits.slice(2, 7)} ${digits.slice(7)}`;
    }
    return digits ? `+${digits}` : "";
  }

  let isPhonebookImportedState = false;

  // Helper: Check Phonebook Sync State STRICTLY based on verified import
  function isPhonebookImported() {
    return Boolean(isPhonebookImportedState);
  }

  // 1. Toast Notification
  function showToast(msg, duration = 3000) {
    const toast = document.getElementById("toast");
    if (!toast) return;
    toast.textContent = msg;
    toast.classList.add("show");
    setTimeout(() => toast.classList.remove("show"), duration);
  }

  // 2. Register Service Worker
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("/sw.js").catch(() => {});
  }

  // 3. Tab Switching with Persistent State across Refreshes
  function switchTab(targetId) {
    if (!targetId) targetId = "paneSchedule";
    try { localStorage.setItem("wa_active_tab", targetId); } catch (_) {}

    navItems.forEach(n => {
      if (n.getAttribute("data-tab") === targetId) {
        n.classList.add("active");
      } else {
        n.classList.remove("active");
      }
    });

    [paneSchedule, paneQueue, paneDevice].forEach(p => {
      if (p) {
        if (p.id === targetId) {
          p.classList.add("active");
        } else {
          p.classList.remove("active");
        }
      }
    });

    if (targetId === "paneQueue") {
      loadSchedules();
    } else if (targetId === "paneSchedule") {
      loadContacts();
    } else if (targetId === "paneDevice") {
      checkStatus();
    }
  }

  navItems.forEach(item => {
    item.addEventListener("click", () => {
      const target = item.getAttribute("data-tab");
      if (target) switchTab(target);
    });
  });

  if (linkDeviceBtn) {
    linkDeviceBtn.addEventListener("click", () => switchTab("paneDevice"));
  }

  if (headerStatus) {
    headerStatus.style.cursor = "pointer";
    headerStatus.addEventListener("click", () => switchTab("paneDevice"));
  }

  if (btnGoToPair) {
    btnGoToPair.onclick = (e) => {
      e.preventDefault();
      e.stopPropagation();
      switchTab("paneDevice");
    };
  }

  if (waNotConnectedCard) {
    waNotConnectedCard.style.cursor = "pointer";
    waNotConnectedCard.onclick = () => switchTab("paneDevice");
  }

  // Restore active tab immediately on load/refresh
  const savedTab = localStorage.getItem("wa_active_tab") || "paneSchedule";
  switchTab(savedTab);

  // 4. Default Date & Time (Local Timezone Aware)
  function formatLocalDate(d = new Date()) {
    const year = d.getFullYear();
    const month = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    return year + "-" + month + "-" + day;
  }

  function formatLocalTime(d = new Date()) {
    const hours = String(d.getHours()).padStart(2, "0");
    const minutes = String(d.getMinutes()).padStart(2, "0");
    return hours + ":" + minutes;
  }

  function initDateTime() {
    const now = new Date();
    const future = new Date(now.getTime() + 15 * 60000);

    if (dateInput) dateInput.value = formatLocalDate(future);
    if (timeInput) timeInput.value = formatLocalTime(future);
  }
  initDateTime();

  // Preset Chips Event Handlers (+15 min, +1 hr, +3 hrs, Tomorrow 9 AM, Tomorrow 6 PM)
  document.querySelectorAll(".preset-chips .chip").forEach(chip => {
    chip.addEventListener("click", (e) => {
      e.preventDefault();
      if (!isPhonebookImported()) {
        showToast("🔒 Action Required: Tap 'Sync Phonebook' above to import contacts first!");
        const gateCard = document.getElementById("phonebookGateCard");
        if (gateCard) gateCard.scrollIntoView({ behavior: "smooth", block: "center" });
        return;
      }
      document.querySelectorAll(".preset-chips .chip").forEach(b => b.classList.remove("active"));
      chip.classList.add("active");

      const preset = chip.getAttribute("data-preset");
      const now = new Date();

      if (preset === "15m") {
        const target = new Date(now.getTime() + 15 * 60000);
        if (dateInput) dateInput.value = formatLocalDate(target);
        if (timeInput) timeInput.value = formatLocalTime(target);
      } else if (preset === "1h") {
        const target = new Date(now.getTime() + 60 * 60000);
        if (dateInput) dateInput.value = formatLocalDate(target);
        if (timeInput) timeInput.value = formatLocalTime(target);
      } else if (preset === "3h") {
        const target = new Date(now.getTime() + 180 * 60000);
        if (dateInput) dateInput.value = formatLocalDate(target);
        if (timeInput) timeInput.value = formatLocalTime(target);
      } else if (preset === "tomorrow9") {
        const tomorrow = new Date(now);
        tomorrow.setDate(tomorrow.getDate() + 1);
        if (dateInput) dateInput.value = formatLocalDate(tomorrow);
        if (timeInput) timeInput.value = "09:00";
      } else if (preset === "tomorrow18") {
        const tomorrow = new Date(now);
        tomorrow.setDate(tomorrow.getDate() + 1);
        if (dateInput) dateInput.value = formatLocalDate(tomorrow);
        if (timeInput) timeInput.value = "18:00";
      }
    });
  });

  if (dateInput) {
    dateInput.addEventListener("click", (e) => {
      if (!isPhonebookImported()) {
        e.preventDefault();
        dateInput.blur();
        showToast("🔒 Action Required: Tap 'Sync Phonebook' above to import contacts first!");
      }
    });
  }
  if (timeInput) {
    timeInput.addEventListener("click", (e) => {
      if (!isPhonebookImported()) {
        e.preventDefault();
        timeInput.blur();
        showToast("🔒 Action Required: Tap 'Sync Phonebook' above to import contacts first!");
      }
    });
  }

  // 5. Attachments Handling
  if (addFileBtn && filePicker) {
    addFileBtn.onclick = () => {
      if (!isPhonebookImported()) {
        showToast("🔒 Action Required: Tap 'Sync Phonebook' above to import contacts first!");
        const gateCard = document.getElementById("phonebookGateCard");
        if (gateCard) gateCard.scrollIntoView({ behavior: "smooth", block: "center" });
        return;
      }
      filePicker.click();
    };
    filePicker.onchange = () => {
      if (filePicker.files) {
        for (const f of filePicker.files) {
          selectedFiles.push(f);
        }
      }
      renderFiles();
      filePicker.value = "";
    };
  }

  function renderFiles() {
    if (!filesList) return;
    filesList.textContent = "";

    stagedFiles.forEach((f, idx) => {
      const item = document.createElement("div");
      item.className = "file-preview-item";
      item.innerHTML = `
        <span style="display: inline-flex; align-items: center; gap: 6px;"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l8.57-8.57A4 4 0 1 1 18 8.84l-8.59 8.57a2 2 0 0 1-2.83-2.83l8.49-8.48"/></svg>${escapeHtml(f.name || "Attachment")} (${f.size ? (f.size / 1024).toFixed(0) + "KB" : "File"})</span>
        <button type="button" class="btn-remove-file" data-type="staged" data-idx="${idx}" aria-label="Remove"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg></button>
      `;
      filesList.appendChild(item);
    });

    selectedFiles.forEach((f, idx) => {
      const item = document.createElement("div");
      item.className = "file-preview-item";
      item.innerHTML = `
        <span>📎 ${escapeHtml(f.name)} (${(f.size / 1024).toFixed(0)}KB)</span>
        <button type="button" class="btn-remove-file" data-type="local" data-idx="${idx}">×</button>
      `;
      filesList.appendChild(item);
    });

    filesList.querySelectorAll(".btn-remove-file").forEach(btn => {
      btn.onclick = () => {
        const type = btn.getAttribute("data-type");
        const idx = parseInt(btn.getAttribute("data-idx"), 10);
        if (type === "staged") {
          stagedFiles.splice(idx, 1);
        } else {
          selectedFiles.splice(idx, 1);
        }
        renderFiles();
      };
    });
  }

  // 6. Native Share Target API
  async function checkSharedData() {
    const params = new URLSearchParams(window.location.search);
    const shareText = [params.get("title"), params.get("text")].filter(Boolean).join(" ");
    if (shareText && messageInput) {
      messageInput.value = shareText;
      window.history.replaceState({}, document.title, window.location.pathname);
    }
    try {
      const res = await fetch("/api/staged-files");
      const data = await res.json();
      if (data?.files && data.files.length > 0) {
        stagedFiles = data.files;
        renderFiles();
      }
    } catch (_) {}
  }
  checkSharedData();

  // 7. Sync Progress Bar & Native Contact Sync Bridge
  function updateSyncProgress(percent, message, autoHide = false) {
    if (!syncBanner) return;
    syncBanner.style.display = "flex";
    if (syncProgressBar) syncProgressBar.style.width = `${Math.min(100, Math.max(0, percent))}%`;
    if (syncPercentBadge) syncPercentBadge.textContent = `${Math.round(percent)}%`;
    if (syncBannerText) syncBannerText.textContent = message;

    if (autoHide && percent >= 100) {
      setTimeout(() => {
        syncBanner.style.display = "none";
        if (syncProgressBar) syncProgressBar.style.width = "0%";
      }, 3500);
    }
  }

  window.onNativeContactsImported = async (contacts) => {
    try {
      const list = typeof contacts === "string" ? JSON.parse(contacts) : contacts;
      if (Array.isArray(list) && list.length > 0) {
        updateSyncProgress(30, `Reading ${list.length} contacts from phonebook…`);
        const res = await authFetch("/api/contacts/import", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ contacts: list })
        });
        const data = await res.json();
        await checkStatus();
        await loadContacts();
        const count = data.count || list.length;
        updateSyncProgress(100, `✓ Synced all ${count} contacts!`, true);
        showToast(`✓ Imported ${count} contacts with exact phonebook names!`, 4000);
        if (recipientInput) renderContactSuggestions(recipientInput.value);
      } else {
        showToast("No phonebook contacts found on device.");
      }
    } catch (err) {
      showToast(`Contact sync error: ${err.message}`);
    }
  };

  async function triggerPhonebookSync() {
    const isConn = headerStatus && headerStatus.classList.contains("connected");
    if (!isConn) {
      showToast("⚠️ Please connect WhatsApp first in Device Link tab.");
      switchTab("paneDevice");
      return;
    }

    if (window.AndroidNative && typeof window.AndroidNative.importAllContacts === "function") {
      updateSyncProgress(10, "Reading Android phonebook contacts…");
      window.AndroidNative.importAllContacts();
      return;
    }

    if (navigator.contacts && typeof navigator.contacts.select === "function") {
      try {
        const contacts = await navigator.contacts.select(["name", "tel"], { multiple: true });
        if (contacts && contacts.length > 0) {
          const formatted = [];
          for (const c of contacts) {
            const name = c.name && c.name[0] ? c.name[0].trim() : "";
            const telList = c.tel || [];
            for (const t of telList) {
              const digits = String(t).replace(/\D/g, "");
              if (digits.length >= 7) {
                formatted.push({ name, phone: digits });
              }
            }
          }

          if (formatted.length > 0) {
            updateSyncProgress(40, `Importing ${formatted.length} contacts…`);
            const res = await authFetch("/api/contacts/import", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ contacts: formatted })
            });
            const data = await res.json();
            await checkStatus();
            await loadContacts();
            const count = data.count || formatted.length;
            updateSyncProgress(100, `✓ Synced ${count} contacts!`, true);
            showToast(`✓ Imported ${count} contacts with names!`);
            if (recipientInput) renderContactSuggestions(recipientInput.value);
          }
        }
      } catch (err) {
        console.log("Contact picker cancelled/error:", err);
      }
    } else {
      showToast("Tip: Please use the Android APK for 1-tap full phonebook sync.");
    }
  }

  if (pickNativeContactBtn) {
    pickNativeContactBtn.onclick = triggerPhonebookSync;
  }
  if (btnGateSyncPhonebook) {
    btnGateSyncPhonebook.onclick = triggerPhonebookSync;
  }

  // 8. Contact Autocomplete Engine
  async function loadContacts() {
    if (!isPhonebookImported()) {
      allContacts = [];
      return;
    }
    try {
      const res = await authFetch("/api/contacts");
      const data = await res.json();
      if (data?.contacts && Array.isArray(data.contacts)) {
        allContacts = data.contacts;
      }
    } catch (_) {}
  }
  loadContacts();

  async function loadAvatar(jid, el) {
    if (!jid || jid.includes("@broadcast")) return;
    if (avatarCache.has(jid)) {
      const cached = avatarCache.get(jid);
      if (cached && el) {
        el.textContent = "";
        const img = document.createElement("img");
        img.src = cached;
        img.alt = "";
        el.appendChild(img);
      }
      return;
    }
    try {
      const res = await authFetch(`/api/profile-pic?jid=${encodeURIComponent(jid)}`);
      const data = await res.json();
      if (data?.url) {
        avatarCache.set(jid, data.url);
        if (el) {
          el.textContent = "";
          const img = document.createElement("img");
          img.src = data.url;
          img.alt = "";
          el.appendChild(img);
        }
      }
    } catch (_) {}
  }

  function renderContactSuggestions(filter = "") {
    if (!contactsDropdown) return;

    if (!isPhonebookImported()) {
      contactsDropdown.style.display = "none";
      return;
    }

    const q = filter.trim().toLowerCase();
    const qDigits = q.replace(/\D/g, "");
    let matches = [];

    if (!q) {
      const people = allContacts.filter(c => !c.is_group);
      const groups = allContacts.filter(c => c.is_group);
      matches = [...people, ...groups].slice(0, 20);
    } else {
      const filtered = allContacts.filter(c => {
        const cName = (c.name || "").toLowerCase();
        const cPhone = (c.phone || "").replace(/\D/g, "");
        if (cName && cName.includes(q)) return true;
        if (qDigits) {
          if (cPhone.includes(qDigits)) return true;
          if (qDigits.length === 10 && cPhone === "91" + qDigits) return true;
          if (cPhone.startsWith("91") && cPhone.slice(2).includes(qDigits)) return true;
        }
        return false;
      });
      const people = filtered.filter(c => !c.is_group);
      const groups = filtered.filter(c => c.is_group);
      matches = [...people, ...groups].slice(0, 20);
    }

    contactsDropdown.textContent = "";

    if (matches.length === 0) {
      if (allContacts.length === 0) {
        const tipBox = document.createElement("div");
        tipBox.style.cssText = "padding: 12px 14px; font-size: 12px; color: var(--text-muted); line-height: 1.5;";
        tipBox.innerHTML = `🔒 Tap <strong>📇 Phonebook</strong> above to sync contacts from your device.`;
        contactsDropdown.appendChild(tipBox);
        contactsDropdown.style.display = "block";
        return;
      }
      contactsDropdown.style.display = "none";
      return;
    }

    const headEl = document.createElement("div");
    headEl.style.cssText = "padding: 6px 12px; font-size: 11px; font-weight: 600; color: var(--text-muted); border-bottom: 1px solid var(--border-subtle); display: flex; justify-content: space-between;";
    const headTitle = document.createElement("span");
    headTitle.textContent = q ? "MATCHING CONTACTS" : "PHONEBOOK CONTACTS";
    const headCount = document.createElement("span");
    headCount.textContent = `${allContacts.length} Synced`;
    headEl.appendChild(headTitle);
    headEl.appendChild(headCount);
    contactsDropdown.appendChild(headEl);

    matches.forEach(c => {
      const item = document.createElement("div");
      item.className = "suggestion-item";

      const avatar = document.createElement("div");
      avatar.className = "suggestion-avatar";
      avatar.innerHTML = c.is_group 
        ? `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>`
        : `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>`;
      if (c.jid) loadAvatar(c.jid, avatar);

      const info = document.createElement("div");
      info.className = "suggestion-info";

      const nameEl = document.createElement("div");
      nameEl.className = "suggestion-name";
      nameEl.textContent = c.name || (c.is_group ? "WhatsApp Group" : "Contact");

      const phoneEl = document.createElement("div");
      phoneEl.className = "suggestion-phone";
      phoneEl.textContent = c.is_group ? "Group Chat" : formatPhone(c.phone);

      info.appendChild(nameEl);
      info.appendChild(phoneEl);
      item.appendChild(avatar);
      item.appendChild(info);

      // SHOW ONLY CONTACT NAME IN INPUT FIELD (e.g. "Raghu Amc")
      item.onclick = () => {
        const cleanName = c.name ? c.name.trim() : (c.is_group ? "WhatsApp Group" : formatPhone(c.phone));
        recipientInput.value = cleanName;
        recipientInput.dataset.jid = c.jid || "";
        recipientInput.dataset.phone = c.phone || "";
        recipientInput.dataset.name = c.name || "";
        contactsDropdown.style.display = "none";
      };

      contactsDropdown.appendChild(item);
    });

    contactsDropdown.style.display = "block";
  }

  if (recipientInput) {
    recipientInput.addEventListener("click", () => {
      if (!isPhonebookImported()) {
        showToast("🔒 Action Required: Tap \x27📇 Phonebook\x27 above to sync contacts first!");
        const gateCard = document.getElementById("phonebookGateCard");
        if (gateCard) {
          gateCard.scrollIntoView({ behavior: "smooth", block: "center" });
        }
      }
    });

    recipientInput.addEventListener("focus", (e) => {
      if (!isPhonebookImported()) {
        if (contactsDropdown) contactsDropdown.style.display = "none";
        recipientInput.blur();
        showToast("🔒 Action Required: Tap \x27📇 Phonebook\x27 above to sync contacts first!");
        return;
      }
      renderContactSuggestions(recipientInput.value);
    });

    recipientInput.addEventListener("input", () => {
      const val = recipientInput.value.trim().toLowerCase();
      const match = allContacts.find(c => (c.name && c.name.toLowerCase() === val));
      if (match) {
        recipientInput.dataset.jid = match.jid || "";
        recipientInput.dataset.phone = match.phone || "";
        recipientInput.dataset.name = match.name || "";
      } else {
        delete recipientInput.dataset.jid;
        delete recipientInput.dataset.phone;
        delete recipientInput.dataset.name;
      }
      renderContactSuggestions(recipientInput.value);
    });
  }

  document.addEventListener("click", (e) => {
    if (recipientInput && contactsDropdown && !recipientInput.contains(e.target) && !contactsDropdown.contains(e.target)) {
      contactsDropdown.style.display = "none";
    }
  });

  // 9. Submit Schedule Form
  if (scheduleForm) {
    scheduleForm.onsubmit = async (e) => {
      e.preventDefault();
      const rawRecipient = (recipientInput.value || "").trim();
      const boundJid = recipientInput.dataset.jid;
      const boundPhone = recipientInput.dataset.phone;

      let recipient = rawRecipient;
      if (boundJid && boundJid.length > 0) {
        recipient = boundJid;
      } else if (boundPhone && boundPhone.length > 0) {
        recipient = boundPhone;
      } else {
        const match = allContacts.find(c => 
          (c.name && c.name.toLowerCase() === rawRecipient.toLowerCase()) || 
          (c.phone && c.phone === rawRecipient.replace(/\D/g, ""))
        );
        if (match) {
          recipient = match.jid || match.phone || match.name;
        }
      }

      const text = messageInput.value.trim();
      const dateVal = dateInput.value;
      const timeVal = timeInput.value;

      if (!recipient) {
        showToast("Please enter a recipient or phone number.");
        return;
      }

      if (!text && selectedFiles.length === 0 && stagedFiles.length === 0) {
        showToast("Please enter a message or attach a file.");
        return;
      }

      if (!dateVal || !timeVal) {
        showToast("Please pick a scheduled date and time.");
        return;
      }

      const [yr, mo, dy] = dateVal.split("-").map(Number);
      const [hr, mn] = timeVal.split(":").map(Number);
      const targetDate = new Date(yr, mo - 1, dy, hr || 0, mn || 0, 0, 0);
      const targetTime = targetDate.getTime();

      if (isNaN(targetTime)) {
        showToast("Please enter a valid scheduled date & time.");
        return;
      }
      if (targetTime <= Date.now()) {
        showToast("Scheduled time must be in the future!");
        return;
      }

      submitScheduleBtn.disabled = true;
      submitScheduleBtn.innerHTML = "<span>Scheduling…</span>";

      try {
        const formData = new FormData();
        formData.append("recipient", recipient);
        formData.append("text", text);
        formData.append("scheduledAt", targetTime);

        if (stagedFiles.length > 0) {
          formData.append("existingFiles", JSON.stringify(stagedFiles));
        }

        selectedFiles.forEach(f => formData.append("attachments", f));

        const res = await authFetch("/api/schedules", {
          method: "POST",
          body: formData
        });

        const data = await res.json();
        if (data.success) {
          showToast("✓ Message Scheduled Successfully!");
          messageInput.value = "";
          selectedFiles = [];
          stagedFiles = [];
          delete recipientInput.dataset.jid;
          delete recipientInput.dataset.phone;
          delete recipientInput.dataset.name;
          renderFiles();
          initDateTime();
          switchTab("paneQueue");
        } else {
          showToast(data.error || "Failed to schedule message");
        }
      } catch (err) {
        showToast(`Error: ${err.message}`);
      } finally {
        submitScheduleBtn.disabled = false;
        submitScheduleBtn.innerHTML = "<span>Schedule WhatsApp Message</span>";
      }
    };
  }

  // 10. Schedules Queue Manager
  async function loadSchedules(showFeedback = false) {
    if (!queueList) return;
    if (refreshQueueBtn) {
      refreshQueueBtn.classList.add("refreshing");
      const icon = refreshQueueBtn.querySelector("svg");
      if (icon) icon.style.animation = "spinRefresh 0.6s linear infinite";
    }

    try {
      const res = await authFetch(`/api/schedules?_t=${Date.now()}`, { cache: "no-store" });
      const data = await res.json();
      renderSchedules(data.schedules || []);
      if (showFeedback) {
        showToast("✓ Queue Refreshed!");
      }
    } catch (_) {
      queueList.innerHTML = `<div class="empty-state">Failed to load queue. Tap refresh to retry.</div>`;
      if (showFeedback) {
        showToast("Failed to refresh queue");
      }
    } finally {
      if (refreshQueueBtn) {
        setTimeout(() => {
          refreshQueueBtn.classList.remove("refreshing");
          const icon = refreshQueueBtn.querySelector("svg");
          if (icon) icon.style.animation = "";
        }, 400);
      }
    }
  }

  function renderSchedules(schedules) {
    if (!queueList) return;
    queueList.textContent = "";

    // Deduplicate schedules by ID
    const seenIds = new Set();
    const uniqueSchedules = (schedules || []).filter(s => {
      if (!s.id || seenIds.has(s.id)) return false;
      seenIds.add(s.id);
      return true;
    });

    if (uniqueSchedules.length === 0) {
      queueList.innerHTML = `
        <div class="empty-state">
          <div class="empty-icon" style="display: flex; align-items: center; justify-content: center; margin-bottom: 8px;">
            <svg width="44" height="44" viewBox="0 0 24 24" fill="none" stroke="var(--text-muted)" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect width="18" height="18" x="3" y="4" rx="2" ry="2"/><line x1="16" x2="16" y1="2" y2="6"/><line x1="8" x2="8" y1="2" y2="6"/><line x1="3" x2="21" y1="10" y2="10"/><path d="m9 16 2 2 4-4"/></svg>
          </div>
          <div class="empty-text">No Scheduled Messages</div>
          <p style="color: var(--text-muted); font-size: 13px; margin-top: 4px;">Schedule your first message using the Schedule tab.</p>
        </div>
      `;
      return;
    }

    uniqueSchedules.forEach(s => {
      const card = document.createElement("div");
      card.className = "queue-card";

      const dt = new Date(s.scheduled_at);
      const timeStr = dt.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
      const dateStr = dt.toLocaleDateString([], { month: "short", day: "numeric" });

      let badgeClass = "badge-scheduled";
      let statusLabel = `<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="display: inline-block; vertical-align: -1px; margin-right: 3px;"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>Scheduled`;
      if (s.status === "sent") {
        badgeClass = "badge-sent";
        statusLabel = `<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="display: inline-block; vertical-align: -1px; margin-right: 3px;"><polyline points="20 6 9 17 4 12"/></svg>Sent`;
      } else if (s.status === "failed") {
        badgeClass = "badge-failed";
        statusLabel = `<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="display: inline-block; vertical-align: -1px; margin-right: 3px;"><circle cx="12" cy="12" r="10"/><line x1="15" x2="9" y1="9" y2="15"/><line x1="9" x2="15" y1="9" y2="15"/></svg>Failed`;
      } else if (s.status === "processing") {
        badgeClass = "badge-processing";
        statusLabel = "Sending…";
      }

      let displayName = s.contact_name || "";
      let phoneStr = "";
      if (s.recipient && s.recipient.endsWith("@s.whatsapp.net")) {
        phoneStr = s.recipient.split("@")[0];
      } else if (s.recipient && /^[0-9+]+$/.test(s.recipient)) {
        phoneStr = s.recipient;
      }

      if (!displayName && phoneStr) {
        displayName = formatPhone(phoneStr);
      } else if (!displayName) {
        displayName = s.recipient || "WhatsApp Recipient";
      }

      const attachmentsCount = (s.attachments && s.attachments.length) ? s.attachments.length : 0;

      card.innerHTML = `
        <div class="queue-card-header">
          <div class="queue-recipient-box">
            <div class="queue-recipient" style="display: inline-flex; align-items: center; gap: 6px;">
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="flex-shrink: 0;"><path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>
              <span>${escapeHtml(displayName)}</span>
            </div>
            ${phoneStr && s.contact_name ? `<div class="queue-phone-sub" style="display: inline-flex; align-items: center; gap: 4px; margin-top: 2px;"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z"/></svg><span>${formatPhone(phoneStr)}</span></div>` : ""}
          </div>
          <div class="queue-status-badge ${badgeClass}">${statusLabel}</div>
        </div>
        <div class="queue-message-preview">${escapeHtml(s.text || (attachmentsCount > 0 ? attachmentsCount + " Attachment(s)" : "No Text"))}</div>
        ${attachmentsCount > 0 && s.text ? `<div style="font-size: 11.5px; color: var(--accent); margin-top: 4px; display: inline-flex; align-items: center; gap: 4px;"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l8.57-8.57A4 4 0 1 1 18 8.84l-8.59 8.57a2 2 0 0 1-2.83-2.83l8.49-8.48"/></svg><span>${attachmentsCount} file(s) attached</span></div>` : ""}
        <div class="queue-footer">
          <div class="queue-time" style="display: inline-flex; align-items: center; gap: 5px;">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
            <span>${dateStr}, ${timeStr}</span>
          </div>
          ${s.status === "scheduled" || s.status === "retrying" || s.status === "failed" ? `<button class="btn-cancel-schedule" data-id="${s.id}" style="display: inline-flex; align-items: center; gap: 4px;"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/></svg><span>Cancel</span></button>` : ""}
        </div>
      `;

      const cancelBtn = card.querySelector(".btn-cancel-schedule");
      if (cancelBtn) {
        cancelBtn.onclick = () => deleteSchedule(s.id);
      }

      queueList.appendChild(card);
    });
  }

  async function deleteSchedule(id) {
    if (!confirm("Are you sure you want to delete this scheduled message?")) return;
    try {
      const res = await authFetch(`/api/schedules/${id}`, { method: "DELETE" });
      const data = await res.json();
      if (data.success) {
        showToast("✓ Scheduled message removed");
        loadSchedules();
      } else {
        showToast(data.error || "Failed to delete schedule");
      }
    } catch (err) {
      showToast(`Error: ${err.message}`);
    }
  }

  if (refreshQueueBtn) {
    refreshQueueBtn.onclick = () => loadSchedules(true);
  }

  // 11. Real-Time Status & Diagnostics Engine
  function updateInputAvailability(status, isSyncing, count) {
    const isConn = status === "connected";
    const isConnecting = status === "connecting";
    const phonebookDone = isPhonebookImported();
    const enableInputs = isConn && phonebookDone;

    // Update WhatsApp Not Connected vs Phonebook Gate Cards
    if (waNotConnectedCard) {
      if (!isConn) {
        waNotConnectedCard.style.display = "flex";
        if (scheduleStatusPill) {
          if (isConnecting) {
            scheduleStatusPill.className = "status-pill-badge connecting";
            scheduleStatusPill.innerHTML = '<span class="dot-indicator"></span><span class="status-text-label">Status: Connecting…</span>';
          } else {
            scheduleStatusPill.className = "status-pill-badge disconnected";
            scheduleStatusPill.innerHTML = '<span class="dot-indicator"></span><span class="status-text-label">Status: Disconnected</span>';
          }
        }
      } else {
        waNotConnectedCard.style.display = "none";
      }
    }

    if (phonebookGateCard) {
      phonebookGateCard.style.display = (isConn && !phonebookDone) ? "flex" : "none";
    }

    if (pickNativeContactBtn) {
      // Allow button to be clicked so it can inform user or trigger sync
      pickNativeContactBtn.disabled = false;
      if (!isConn) {
        pickNativeContactBtn.classList.add("btn-disabled");
        pickNativeContactBtn.classList.remove("btn-phonebook-mandatory");
        pickNativeContactBtn.title = "Connect WhatsApp first to sync phonebook";
      } else if (!phonebookDone) {
        pickNativeContactBtn.classList.remove("btn-disabled");
        pickNativeContactBtn.classList.add("btn-phonebook-mandatory");
        pickNativeContactBtn.title = "Action Required: Tap to import phonebook contacts";
      } else {
        pickNativeContactBtn.classList.remove("btn-disabled");
        pickNativeContactBtn.classList.remove("btn-phonebook-mandatory");
        pickNativeContactBtn.title = "Phonebook contacts synced ✓";
      }
    }

    if (recipientInput) {
      recipientInput.disabled = !enableInputs;
      if (!isConn) {
        recipientInput.classList.add("input-disabled");
        recipientInput.placeholder = "⚠️ Link WhatsApp in Device Link to schedule messages";
      } else if (!phonebookDone) {
        recipientInput.classList.add("input-disabled");
        recipientInput.placeholder = "🔒 Tap \x27📇 Phonebook\x27 button above to sync contacts first";
      } else {
        recipientInput.classList.remove("input-disabled");
        recipientInput.placeholder = "Type contact name or +919876543210…";
      }
    }

    if (messageInput) {
      messageInput.disabled = !enableInputs;
      if (!enableInputs) {
        messageInput.classList.add("input-disabled");
        messageInput.placeholder = !isConn ? "Connect WhatsApp to compose messages…" : "Sync phonebook contacts first to compose messages…";
      } else {
        messageInput.classList.remove("input-disabled");
        messageInput.placeholder = "Type your scheduled message…";
      }
    }

    // 5. Attachments Button State
    if (addFileBtn) {
      addFileBtn.disabled = !enableInputs;
      if (!enableInputs) {
        addFileBtn.classList.add("btn-disabled");
      } else {
        addFileBtn.classList.remove("btn-disabled");
      }
    }

    // 6. Date & Time Inputs State
    if (dateInput) {
      dateInput.disabled = !enableInputs;
      if (!enableInputs) {
        dateInput.classList.add("input-disabled");
      } else {
        dateInput.classList.remove("input-disabled");
      }
    }
    if (timeInput) {
      timeInput.disabled = !enableInputs;
      if (!enableInputs) {
        timeInput.classList.add("input-disabled");
      } else {
        timeInput.classList.remove("input-disabled");
      }
    }

    // 7. Preset Chips State
    document.querySelectorAll(".preset-chips .chip").forEach(chip => {
      chip.disabled = !enableInputs;
      if (!enableInputs) {
        chip.classList.add("chip-disabled");
      } else {
        chip.classList.remove("chip-disabled");
      }
    });

    // 8. Submit Schedule Button State
    if (submitScheduleBtn) {
      submitScheduleBtn.disabled = !enableInputs;
      if (!enableInputs) {
        submitScheduleBtn.classList.add("btn-disabled");
      } else {
        submitScheduleBtn.classList.remove("btn-disabled");
      }
    }
  }

  async function checkStatus() {
    try {
      const res = await authFetch("/api/status");
      const data = await res.json();
      
      const isConn = data.status === "connected";
      const isConnecting = data.status === "connecting";
      const isSyncing = Boolean(data.syncing);
      const contactCount = data.contactCount || 0;
      const phonebookCount = data.phonebookContactCount || 0;
      const phonebookImported = Boolean(data.phonebookImported);

      isPhonebookImportedState = isConn && phonebookImported;

      try { 
        localStorage.setItem("wa_status", data.status); 
        if (isPhonebookImportedState) {
          localStorage.setItem("wa_phonebook_synced", "true");
        } else {
          localStorage.removeItem("wa_phonebook_synced");
        }
      } catch (_) {}

      if (headerStatus) {
        headerStatus.className = `status-indicator ${data.status}`;
      }

      updateInputAvailability(data.status, isSyncing, contactCount, isPhonebookImportedState);

      if (isPhonebookImportedState && allContacts.length === 0) {
        loadContacts();
      } else if (!isPhonebookImportedState && allContacts.length > 0) {
        allContacts = [];
      }

      if (devicePill) {
        if (isConn) {
          devicePill.innerHTML = `<span class="dot" style="width:7px;height:7px;border-radius:50%;background:#25D366;display:inline-block;"></span><span>Status: Connected ✓</span>`;
          devicePill.style.background = "rgba(37, 211, 102, 0.15)";
          devicePill.style.color = "#25D366";
        } else if (isConnecting) {
          devicePill.innerHTML = `<span class="dot" style="width:7px;height:7px;border-radius:50%;background:#ffc107;display:inline-block;"></span><span>Status: Connecting…</span>`;
          devicePill.style.background = "rgba(255, 193, 7, 0.15)";
          devicePill.style.color = "#ffc107";
        } else {
          devicePill.innerHTML = `<span class="dot" style="width:7px;height:7px;border-radius:50%;background:#ff6b6b;display:inline-block;"></span><span>Status: Disconnected</span>`;
          devicePill.style.background = "rgba(234, 67, 53, 0.15)";
          devicePill.style.color = "#ff6b6b";
        }
      }

      if (deviceUserInfo) {
        if (isConn && data.user) {
          const syncLabel = isPhonebookImportedState
            ? `<small style="color: #25D366; font-weight: 600;">✓ ${phonebookCount || allContacts.length} Phonebook Contacts Synced</small>`
            : `<small style="color: #ffc107; font-weight: 600;">⚠️ Phonebook Not Synced (Required for Scheduling)</small>`;

          deviceUserInfo.innerHTML = `<strong>Linked Account:</strong> ${escapeHtml(data.user.name || "")} (${data.user.id ? data.user.id.split(":")[0] : ""})<br>${syncLabel}`;
          deviceUserInfo.style.display = "block";
        } else {
          deviceUserInfo.innerHTML = `<div class="device-disconnected-guide">
            <div class="guide-title">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/></svg>
              <span>How to connect your WhatsApp:</span>
            </div>
            <ol class="guide-steps">
              <li>Tap <strong>Show QR Code</strong> or <strong>8-Digit Pairing Code</strong> below</li>
              <li>Open WhatsApp on phone &gt; <strong>Linked Devices</strong> &gt; <strong>Link a Device</strong></li>
              <li>Scan QR or enter code to pair autonomously</li>
            </ol>
          </div>`;
          deviceUserInfo.style.display = "block";
        }
      }

      if (logoutBox) {
        logoutBox.style.display = (isConn || isConnecting) ? "block" : "none";
      }

      if (isConn) {
        if (headerStatus) {
          headerStatus.querySelector(".status-text").textContent = "Connected";
        }

        if (isSyncing && contactCount === 0) {
          updateSyncProgress(50, "Syncing WhatsApp contacts & chats in background…");
        }

        if (qrModal && qrModal.classList.contains("active")) {
          qrModal.classList.remove("active");
          if (qrPollInterval) { clearInterval(qrPollInterval); qrPollInterval = null; }
          showToast("✓ WhatsApp Connected Successfully!");
          switchTab("paneSchedule");
        }
        if (pairModal && pairModal.classList.contains("active")) {
          pairModal.classList.remove("active");
          if (pairPollInterval) { clearInterval(pairPollInterval); pairPollInterval = null; }
          showToast("✓ WhatsApp Connected Successfully!");
          switchTab("paneSchedule");
        }
      } else if (isConnecting) {
        if (headerStatus) {
          headerStatus.querySelector(".status-text").textContent = "Connecting…";
        }
      } else {
        if (headerStatus) {
          headerStatus.querySelector(".status-text").textContent = data.status === "qr" ? "Scan QR Code" : "Disconnected";
        }

        if (qrModal && qrModal.classList.contains("active")) {
          if (data.qr) {
            if (qrImg) {
              qrImg.src = data.qr;
              qrImg.style.display = "block";
            }
            if (qrSpinner) qrSpinner.style.display = "none";
          }
        }
      }
    } catch (_) {
      if (headerStatus) {
        headerStatus.className = "status-indicator disconnected";
        headerStatus.querySelector(".status-text").textContent = "Offline";
      }
    }
  }

  // Run status check immediately and every 3 seconds
  checkStatus();
  statusPollInterval = setInterval(checkStatus, 3000);

  // 12. Show QR Code Modal Handler
  async function fetchQrNow() {
    try {
      const res = await authFetch("/api/qr");
      const data = await res.json();
      if (data.qr) {
        if (qrImg) {
          qrImg.src = data.qr;
          qrImg.style.display = "block";
        }
        if (qrSpinner) qrSpinner.style.display = "none";
      } else if (data.connected) {
        if (qrSpinner) {
          qrSpinner.style.display = "flex";
          if (qrStatusText) qrStatusText.textContent = "✓ Already Connected!";
        }
      } else {
        if (qrSpinner) {
          qrSpinner.style.display = "flex";
          if (qrStatusText) qrStatusText.textContent = "Generating QR Code…";
        }
      }
    } catch (_) {
      if (qrSpinner && qrStatusText) qrStatusText.textContent = "Failed to load QR code.";
    }
  }

  if (showQrBtn) {
    showQrBtn.onclick = () => {
      if (qrModal) {
        qrModal.classList.add("active");
        if (qrSpinner) qrSpinner.style.display = "flex";
        if (qrImg) qrImg.style.display = "none";
        if (qrStatusText) qrStatusText.textContent = "Loading QR Code…";
        fetchQrNow();

        if (qrPollInterval) clearInterval(qrPollInterval);
        qrPollInterval = setInterval(fetchQrNow, 2000);
      }
    };
  }

  if (qrModalClose) {
    qrModalClose.onclick = () => {
      if (qrModal) qrModal.classList.remove("active");
      if (qrPollInterval) { clearInterval(qrPollInterval); qrPollInterval = null; }
    };
  }

  // 13. Show 8-Digit Pairing Code Modal Handler
  if (showPairCodeBtn) {
    showPairCodeBtn.onclick = () => {
      if (pairModal) {
        pairModal.classList.add("active");
        if (pairCodeDisplay) pairCodeDisplay.style.display = "none";
        if (pairPhoneInput) {
          pairPhoneInput.value = "";
          setTimeout(() => pairPhoneInput.focus(), 150);
        }
        if (pairPollInterval) clearInterval(pairPollInterval);
        pairPollInterval = setInterval(checkStatus, 1000);
      }
    };
  }

  if (pairModalClose) {
    pairModalClose.onclick = () => {
      if (pairModal) pairModal.classList.remove("active");
      if (pairPollInterval) { clearInterval(pairPollInterval); pairPollInterval = null; }
    };
  }

  // Close modals on clicking overlay backdrop
  window.addEventListener("click", (e) => {
    if (qrModal && e.target === qrModal) {
      qrModal.classList.remove("active");
      if (qrPollInterval) { clearInterval(qrPollInterval); qrPollInterval = null; }
    }
    if (pairModal && e.target === pairModal) {
      pairModal.classList.remove("active");
      if (pairPollInterval) { clearInterval(pairPollInterval); pairPollInterval = null; }
    }
  });

  // Request 8-Digit Pairing Code
  if (requestPairCodeBtn) {
    requestPairCodeBtn.onclick = async () => {
      let phone = (pairPhoneInput ? pairPhoneInput.value : "").trim().replace(/\D/g, "");
      if (phone.startsWith("0")) phone = phone.replace(/^0+/, "");
      if (phone.length === 10) {
        phone = "91" + phone;
      }

      if (!phone || phone.length < 10) {
        showToast("Please enter a valid 10-digit phone number (e.g. 9876543210)");
        return;
      }

      requestPairCodeBtn.disabled = true;
      requestPairCodeBtn.innerHTML = "<span>Requesting Code…</span>";

      try {
        const res = await authFetch("/api/pair-code", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ phoneNumber: phone })
        });
        const data = await res.json();

        if (data.success && data.code) {
          const rawCode = String(data.code);
          const formattedCode = rawCode.length === 8 ? `${rawCode.slice(0, 4)}-${rawCode.slice(4)}` : rawCode;
          if (pairCodeResult) pairCodeResult.textContent = formattedCode;
          if (pairCodeDisplay) pairCodeDisplay.style.display = "block";
          showToast("✓ 8-Digit Pairing Code Generated!");

          const btnCopyPairCode = document.getElementById("btnCopyPairCode");
          if (btnCopyPairCode) {
            btnCopyPairCode.onclick = () => copyTextToClipboard(formattedCode, btnCopyPairCode);
          }
        } else {
          showToast(data.error || "Failed to generate pairing code");
        }
      } catch (err) {
        showToast(`Error: ${err.message}`);
      } finally {
        requestPairCodeBtn.disabled = false;
        requestPairCodeBtn.innerHTML = "<span>Get 8-Digit Pairing Code</span>";
      }
    };
  }

  // 14. Logout Handler
  if (logoutBtn) {
    logoutBtn.onclick = async () => {
      if (!confirm("Are you sure you want to unlink this WhatsApp account?")) return;
      try {
        logoutBtn.disabled = true;
        logoutBtn.textContent = "Unlinking…";
        await authFetch("/api/logout", { method: "POST" });
        localStorage.removeItem("wa_phonebook_synced");
        showToast("✓ WhatsApp Unlinked");
        checkStatus();
      } catch (err) {
        showToast(`Logout error: ${err.message}`);
      } finally {
        logoutBtn.disabled = false;
        logoutBtn.textContent = "Unlink WhatsApp Account";
      }
    };
  }

  // 15. In-App Auto-Update Checker & Dynamic APK Download Card
  const updateBanner = document.getElementById("updateBanner");
  const updateVersionTag = document.getElementById("updateVersionTag");
  const updateNotes = document.getElementById("updateNotes");
  const updateNowBtn = document.getElementById("updateNowBtn");
  const updateDismissBtn = document.getElementById("updateDismissBtn");

  function isNewerVersion(latest, current) {
    if (!latest || !current) return false;
    const lClean = latest.replace(/^[vV]/, "").split(/[.-]/).map(n => parseInt(n, 10) || 0);
    const cClean = current.replace(/^[vV]/, "").split(/[.-]/).map(n => parseInt(n, 10) || 0);
    const maxLen = Math.max(lClean.length, cClean.length);
    for (let i = 0; i < maxLen; i++) {
      const lVal = lClean[i] || 0;
      const cVal = cClean[i] || 0;
      if (lVal > cVal) return true;
      if (lVal < cVal) return false;
    }
    return false;
  }

  async function checkForUpdates() {
    const currentVersion = (window.AndroidNative && typeof window.AndroidNative.getAppVersionName === "function")
      ? window.AndroidNative.getAppVersionName()
      : "1.0.0";

    let latestTag = null;
    let apkUrl = "https://github.com/PannagaJA/Whatsapp-Scheduler/releases/latest/download/WhatsApp-Scheduler.apk";
    let releaseName = "New WhatsApp Scheduler Update";
    let githubApkReady = false;

    // 1. Check server-side /api/version (fetches GitHub latest tag directly with ZERO rate limits)
    try {
      const vRes = await fetch("/api/version?t=" + Date.now(), { cache: "no-store" });
      const vData = await vRes.json();
      if (vData?.success && vData.version) {
        latestTag = vData.version;
        if (vData.downloadUrl) apkUrl = vData.downloadUrl;
      }
    } catch (_) {}

    // 2. Double-check GitHub Releases API directly if accessible
    if (!latestTag) {
      try {
        const ghRes = await fetch("https://api.github.com/repos/PannagaJA/Whatsapp-Scheduler/releases/latest", {
          headers: { "Accept": "application/vnd.github.v3+json" },
          cache: "no-store"
        });
        if (ghRes.ok) {
          const release = await ghRes.json();
          if (release && release.tag_name) {
            const apkAsset = release.assets?.find(a => a.name && a.name.toLowerCase().endsWith(".apk"));
            if (apkAsset && apkAsset.browser_download_url) {
              latestTag = release.tag_name;
              apkUrl = apkAsset.browser_download_url;
            }
          }
        }
      } catch (_) {}
    }

    const hasNewRelease = latestTag && isNewerVersion(latestTag, currentVersion);

    // Update Device Link "App Updates & APK" Card
    const curVerClean = (currentVersion || "1.0.0").replace(/^[vV]+/, "");
    const latestTagClean = latestTag ? latestTag.replace(/^[vV]+/, "") : curVerClean;

    if (deviceAppVersion) {
      if (hasNewRelease) {
        deviceAppVersion.innerHTML = `Current: <strong>v${curVerClean}</strong> · <span style="color: #25D366; font-weight: 700;">Update Available: v${latestTagClean}</span>`;
      } else {
        deviceAppVersion.innerHTML = `Current: <strong>v${curVerClean}</strong> · <span style="color: #25D366; font-weight: 600;">✓ Up to Date</span>`;
      }
    }

    if (btnDownloadApkDirect) {
      if (hasNewRelease) {
        btnDownloadApkDirect.disabled = false;
        btnDownloadApkDirect.classList.remove("btn-disabled");
        btnDownloadApkDirect.innerHTML = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg><span>Download Update</span>';
        btnDownloadApkDirect.onclick = () => {
          if (window.AndroidNative && typeof window.AndroidNative.downloadAndInstallUpdate === "function") {
            showToast("Starting APK download…", 3000);
            window.AndroidNative.downloadAndInstallUpdate(apkUrl);
          } else {
            window.open(apkUrl, "_blank");
          }
        };
      } else {
        btnDownloadApkDirect.disabled = true;
        btnDownloadApkDirect.classList.add("btn-disabled");
        btnDownloadApkDirect.innerHTML = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg><span>Up to Date</span>';
        btnDownloadApkDirect.onclick = null;
      }
    }

    // Show Top Update Banner if newer version is found
    if (hasNewRelease) {
      if (updateBanner && updateVersionTag) {
        updateVersionTag.textContent = latestTag.startsWith("v") ? latestTag : "v" + latestTag;
        if (updateNotes) updateNotes.textContent = releaseName;
        updateBanner.style.display = "flex";

        if (updateNowBtn) {
          updateNowBtn.onclick = () => {
            if (window.AndroidNative && typeof window.AndroidNative.downloadAndInstallUpdate === "function") {
              showToast("Starting in-app download…", 3000);
              window.AndroidNative.downloadAndInstallUpdate(apkUrl);
            } else {
              window.open(apkUrl, "_blank");
            }
          };
        }

        if (updateDismissBtn) {
          updateDismissBtn.onclick = () => {
            updateBanner.style.display = "none";
          };
        }
      }
    } else {
      if (updateBanner) updateBanner.style.display = "none";
    }
  }

  setTimeout(checkForUpdates, 1500);
  setInterval(checkForUpdates, 30000);
});
