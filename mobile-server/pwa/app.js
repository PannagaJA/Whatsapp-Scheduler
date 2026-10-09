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

  // State
  let selectedFiles = [];
  let stagedFiles = [];
  let allContacts = [];
  const avatarCache = new Map();
  let qrPollInterval = null;
  let statusPollInterval = null;

  // Helper: Escape HTML
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

  // Helper: Check Phonebook Sync State
  function isPhonebookImported() {
    return localStorage.getItem("wa_phonebook_synced") === "true" || 
           (allContacts.length > 0 && allContacts.some(c => c.name && !c.is_group));
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

  // Restore active tab immediately on load/refresh
  const savedTab = localStorage.getItem("wa_active_tab") || "paneSchedule";
  switchTab(savedTab);

  // 4. Default Date & Time
  function initDateTime() {
    const now = new Date();
    if (dateInput) dateInput.value = now.toISOString().split("T")[0];
    
    const future = new Date(now.getTime() + 15 * 60000);
    const hours = String(future.getHours()).padStart(2, "0");
    const minutes = String(future.getMinutes()).padStart(2, "0");
    if (timeInput) timeInput.value = `${hours}:${minutes}`;

    document.querySelectorAll(".preset-btn").forEach(btn => {
      btn.addEventListener("click", () => {
        document.querySelectorAll(".preset-btn").forEach(b => b.classList.remove("active"));
        btn.classList.add("active");
        const mins = parseInt(btn.getAttribute("data-mins"), 10);
        const targetDate = new Date(Date.now() + mins * 60000);
        if (dateInput) dateInput.value = targetDate.toISOString().split("T")[0];
        if (timeInput) timeInput.value = `${String(targetDate.getHours()).padStart(2, "0")}:${String(targetDate.getMinutes()).padStart(2, "0")}`;
      });
    });
  }
  initDateTime();

  // 5. Attachments Handling
  if (addFileBtn && filePicker) {
    addFileBtn.onclick = () => filePicker.click();
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
        <span>📎 ${escapeHtml(f.name || "Attachment")} (${f.size ? (f.size / 1024).toFixed(0) + "KB" : "File"})</span>
        <button type="button" class="btn-remove-file" data-type="staged" data-idx="${idx}">×</button>
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
        const res = await fetch("/api/contacts/import", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ contacts: list })
        });
        const data = await res.json();
        localStorage.setItem("wa_phonebook_synced", "true");
        await loadContacts();
        const count = data.count || list.length;
        updateSyncProgress(100, `✓ Synced all ${count} contacts!`, true);
        showToast(`✓ Imported ${count} contacts with exact phonebook names!`, 4000);
        checkStatus();
        if (recipientInput) renderContactSuggestions(recipientInput.value);
      } else {
        showToast("No phonebook contacts found on device.");
      }
    } catch (err) {
      showToast(`Contact sync error: ${err.message}`);
    }
  };

  if (pickNativeContactBtn) {
    pickNativeContactBtn.onclick = async () => {
      if (headerStatus && !headerStatus.classList.contains("connected")) {
        showToast("Please connect WhatsApp first before syncing contacts.");
        return;
      }

      if (window.AndroidNative && typeof window.AndroidNative.importAllContacts === "function") {
        updateSyncProgress(10, "Requesting Android phonebook permission…");
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
              const res = await fetch("/api/contacts/import", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ contacts: formatted })
              });
              const data = await res.json();
              localStorage.setItem("wa_phonebook_synced", "true");
              await loadContacts();
              updateSyncProgress(100, `✓ Synced ${data.count || formatted.length} contacts!`, true);
              showToast(`✓ Imported ${data.count || formatted.length} contacts with names!`);
              checkStatus();
              if (recipientInput) renderContactSuggestions(recipientInput.value);
            }
          }
        } catch (err) {
          console.log("Contact picker cancelled/error:", err);
        }
      } else {
        showToast("Tip: Install the Android APK for 1-tap full phonebook sync.");
      }
    };
  }

  // 8. Contact Autocomplete Engine
  async function loadContacts() {
    try {
      const res = await fetch("/api/contacts");
      const data = await res.json();
      if (data?.contacts) allContacts = data.contacts;
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
      const res = await fetch(`/api/profile-pic?jid=${encodeURIComponent(jid)}`);
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
      avatar.textContent = c.is_group ? "👥" : "👤";
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
      if (headerStatus?.classList.contains("connected") && !isPhonebookImported()) {
        showToast("🔒 Action Required: Tap \x27📇 Phonebook\x27 above to sync contacts first!");
      }
    });

    recipientInput.addEventListener("focus", () => {
      if (!isPhonebookImported()) {
        if (contactsDropdown) contactsDropdown.style.display = "none";
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

      const targetTime = new Date(`${dateVal}T${timeVal}`).getTime();
      if (isNaN(targetTime) || targetTime <= Date.now()) {
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

        const res = await fetch("/api/schedules", {
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
  async function loadSchedules() {
    if (!queueList) return;
    try {
      const res = await fetch("/api/schedules");
      const data = await res.json();
      renderSchedules(data.schedules || []);
    } catch (_) {
      queueList.innerHTML = `<div class="empty-state">Failed to load queue. Pull to refresh.</div>`;
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
          <div class="empty-icon">📅</div>
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
      let statusLabel = "Scheduled";
      if (s.status === "sent") {
        badgeClass = "badge-sent";
        statusLabel = "Sent ✓";
      } else if (s.status === "failed") {
        badgeClass = "badge-failed";
        statusLabel = "Failed ✕";
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
            <div class="queue-recipient">👤 ${escapeHtml(displayName)}</div>
            ${phoneStr && s.contact_name ? `<div class="queue-phone-sub">📞 ${formatPhone(phoneStr)}</div>` : ""}
          </div>
          <div class="queue-status-badge ${badgeClass}">${statusLabel}</div>
        </div>
        <div class="queue-message-preview">${escapeHtml(s.text || (attachmentsCount > 0 ? "📎 " + attachmentsCount + " Attachment(s)" : "No Text"))}</div>
        ${attachmentsCount > 0 && s.text ? `<div style="font-size: 11px; color: var(--accent); margin-top: 4px;">📎 ${attachmentsCount} file(s) attached</div>` : ""}
        <div class="queue-footer">
          <div class="queue-time">🕒 ${dateStr}, ${timeStr}</div>
          ${s.status === "scheduled" || s.status === "retrying" || s.status === "failed" ? `<button class="btn-cancel-schedule" data-id="${s.id}">Cancel</button>` : ""}
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
      const res = await fetch(`/api/schedules/${id}`, { method: "DELETE" });
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
    refreshQueueBtn.onclick = () => loadSchedules();
  }

  // 11. Real-Time Status & Diagnostics Engine
  function updateInputAvailability(status, isSyncing, count) {
    const isConn = status === "connected";
    const phonebookDone = isPhonebookImported() || count > 0;
    const enableInputs = isConn && phonebookDone;

    if (pickNativeContactBtn) {
      pickNativeContactBtn.disabled = !isConn;
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
        messageInput.placeholder = !isConn ? "Connect WhatsApp to compose messages…" : "Sync phonebook contacts first…";
      } else {
        messageInput.classList.remove("input-disabled");
        messageInput.placeholder = "Type your scheduled message…";
      }
    }

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
      const res = await fetch("/api/status");
      const data = await res.json();
      
      const isConn = data.status === "connected";
      try { localStorage.setItem("wa_status", data.status); } catch (_) {}
      const isConnecting = data.status === "connecting";
      const isSyncing = Boolean(data.syncing);
      const contactCount = data.contactCount || 0;

      if (headerStatus) {
        headerStatus.className = `status-indicator ${data.status}`;
      }

      updateInputAvailability(data.status, isSyncing, contactCount);

      if (devicePill) {
        if (isConn) {
          devicePill.textContent = "Status: Connected ✓";
          devicePill.style.background = "rgba(37, 211, 102, 0.15)";
          devicePill.style.color = "#25D366";
        } else if (isConnecting) {
          devicePill.textContent = "Status: Connecting…";
          devicePill.style.background = "rgba(255, 193, 7, 0.15)";
          devicePill.style.color = "#ffc107";
        } else {
          devicePill.textContent = "Status: Disconnected";
          devicePill.style.background = "rgba(234, 67, 53, 0.15)";
          devicePill.style.color = "#ff6b6b";
        }
      }

      const effectiveCount = Math.max(contactCount, allContacts.length);
      if (deviceUserInfo) {
        if ((isConn || isConnecting) && data.user) {
          deviceUserInfo.innerHTML = `<strong>Linked Account:</strong> ${escapeHtml(data.user.name || "")} (${data.user.id ? data.user.id.split(":")[0] : ""})<br><small style="color: #25D366; font-weight: 600;">✓ ${effectiveCount} Contacts Synced & Available</small>`;
          deviceUserInfo.style.display = "block";
        } else {
          deviceUserInfo.style.display = "none";
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
      const res = await fetch("/api/qr");
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
      }
    };
  }

  if (pairModalClose) {
    pairModalClose.onclick = () => {
      if (pairModal) pairModal.classList.remove("active");
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
        const res = await fetch("/api/pair-code", {
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
        await fetch("/api/logout", { method: "POST" });
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

    // 1. Check server-side /api/version first
    try {
      const vRes = await fetch("/api/version");
      const vData = await vRes.json();
      if (vData?.success && vData.version) {
        latestTag = vData.version;
        if (vData.downloadUrl) apkUrl = vData.downloadUrl;
      }
    } catch (_) {}

    // 2. Check GitHub Releases if accessible
    try {
      const ghRes = await fetch("https://api.github.com/repos/PannagaJA/Whatsapp-Scheduler/releases/latest", {
        headers: { "Accept": "application/vnd.github.v3+json" }
      });
      if (ghRes.ok) {
        const release = await ghRes.json();
        if (release && release.tag_name) {
          latestTag = release.tag_name;
          if (release.name) releaseName = release.name;
          if (release.assets && release.assets.length > 0) {
            const apkAsset = release.assets.find(a => a.name && a.name.toLowerCase().endsWith(".apk"));
            if (apkAsset && apkAsset.browser_download_url) {
              apkUrl = apkAsset.browser_download_url;
            }
          }
        }
      }
    } catch (_) {}

    const hasNewRelease = latestTag && isNewerVersion(latestTag, currentVersion);

    // Update Device Link "App Updates & APK" Card
    if (deviceAppVersion) {
      if (hasNewRelease) {
        deviceAppVersion.innerHTML = "Current: <strong>v" + currentVersion + "</strong> · <span style='color: #25D366; font-weight: 700;'>Update Available: v" + latestTag + "</span>";
      } else {
        deviceAppVersion.innerHTML = "Current: <strong>v" + currentVersion + "</strong> · <span style='color: #25D366; font-weight: 600;'>✓ Up to Date</span>";
      }
    }

    if (btnDownloadApkDirect) {
      if (hasNewRelease) {
        btnDownloadApkDirect.disabled = false;
        btnDownloadApkDirect.classList.remove("btn-disabled");
        btnDownloadApkDirect.innerHTML = "<span>Download Update</span>";
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
        btnDownloadApkDirect.innerHTML = "<span>Latest Version ✓</span>";
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
