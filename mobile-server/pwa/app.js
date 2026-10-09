document.addEventListener('DOMContentLoaded', () => {
  // DOM Elements
  const paneSchedule = document.getElementById('paneSchedule');
  const paneQueue = document.getElementById('paneQueue');
  const paneSettings = document.getElementById('paneSettings');
  const navItems = document.querySelectorAll('.nav-item');

  const scheduleForm = document.getElementById('scheduleForm');
  const recipientInput = document.getElementById('recipientInput');
  const contactsDropdown = document.getElementById('contactsDropdown');
  const messageInput = document.getElementById('messageInput');
  const dateInput = document.getElementById('dateInput');
  const timeInput = document.getElementById('timeInput');
  const isRecurringCheckbox = document.getElementById('isRecurring');
  const recurrenceGroup = document.getElementById('recurrenceGroup');
  const recurrencePattern = document.getElementById('recurrencePattern');
  const filePicker = document.getElementById('filePicker');
  const addFileBtn = document.getElementById('addFileBtn');
  const filesList = document.getElementById('filesList');
  const submitBtn = document.getElementById('submitBtn');

  const queueList = document.getElementById('queueList');
  const refreshQueueBtn = document.getElementById('refreshQueueBtn');
  const headerStatus = document.getElementById('headerStatus');
  const openQrBtn = document.getElementById('openQrBtn');
  const pairCodeBtn = document.getElementById('pairCodeBtn');

  const qrModal = document.getElementById('qrModal');
  const qrImage = document.getElementById('qrImage');
  const qrLoading = document.getElementById('qrLoading');
  const closeQrModal = document.getElementById('closeQrModal');

  const pairModal = document.getElementById('pairModal');
  const closePairModal = document.getElementById('closePairModal');
  const pairPhoneInput = document.getElementById('pairPhoneInput');
  const requestPairCodeBtn = document.getElementById('requestPairCodeBtn');
  const pairCodeDisplay = document.getElementById('pairCodeDisplay');
  const pairCodeResult = document.getElementById('pairCodeResult');

  const syncBanner = document.getElementById('syncBanner');
  const syncBannerText = document.getElementById('syncBannerText');
  const syncProgressBar = document.getElementById('syncProgressBar');
  const syncPercentBadge = document.getElementById('syncPercentBadge');
  const pickNativeContactBtn = document.getElementById('pickNativeContactBtn');

  let selectedFiles = [];
  let stagedFiles = [];
  let allContacts = [];
  const avatarCache = new Map();

  // Helper: Escape HTML
  function escapeHtml(text) {
    if (!text) return '';
    return String(text)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  // 1. Register PWA Service Worker
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  }

  // 2. Toast Notification
  function showToast(msg, duration = 3000) {
    const toast = document.getElementById('toast');
    if (!toast) return;
    toast.textContent = msg;
    toast.classList.add('show');
    setTimeout(() => toast.classList.remove('show'), duration);
  }

  // 3. Tab Switching
  navItems.forEach(item => {
    item.addEventListener('click', () => {
      const target = item.getAttribute('data-tab');
      navItems.forEach(n => n.classList.remove('active'));
      item.classList.add('active');

      [paneSchedule, paneQueue, paneSettings].forEach(p => p && p.classList.remove('active'));
      const activePane = document.getElementById(target);
      if (activePane) activePane.classList.add('active');

      if (target === 'paneQueue') {
        loadSchedules();
      } else if (target === 'paneSchedule') {
        loadContacts();
      }
    });
  });

  // 4. Time Presets & Date Defaults
  function initDateTimeDefaults() {
    const now = new Date();
    dateInput.value = now.toISOString().split('T')[0];
    
    // Set default time: +15 minutes
    const future = new Date(now.getTime() + 15 * 60000);
    const hours = String(future.getHours()).padStart(2, '0');
    const minutes = String(future.getMinutes()).padStart(2, '0');
    timeInput.value = `${hours}:${minutes}`;

    document.querySelectorAll('.preset-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.preset-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        const mins = parseInt(btn.getAttribute('data-mins'), 10);
        const targetDate = new Date(Date.now() + mins * 60000);
        dateInput.value = targetDate.toISOString().split('T')[0];
        timeInput.value = `${String(targetDate.getHours()).padStart(2, '0')}:${String(targetDate.getMinutes()).padStart(2, '0')}`;
      });
    });

    if (isRecurringCheckbox && recurrenceGroup) {
      isRecurringCheckbox.addEventListener('change', () => {
        recurrenceGroup.style.display = isRecurringCheckbox.checked ? 'block' : 'none';
      });
    }
  }
  initDateTimeDefaults();

  // 5. Attachment Handling
  if (addFileBtn && filePicker) {
    addFileBtn.onclick = () => filePicker.click();
    filePicker.onchange = () => {
      if (filePicker.files) {
        for (const f of filePicker.files) {
          selectedFiles.push(f);
        }
      }
      renderFiles();
      filePicker.value = '';
    };
  }

  function renderFiles() {
    if (!filesList) return;
    filesList.textContent = '';

    stagedFiles.forEach((f, idx) => {
      const item = document.createElement('div');
      item.className = 'file-preview-item';
      item.innerHTML = `
        <span>📎 ${escapeHtml(f.name || 'Shared Attachment')} (${f.size ? (f.size / 1024).toFixed(0) + 'KB' : 'File'})</span>
        <button type="button" class="btn-remove-file" data-type="staged" data-idx="${idx}">×</button>
      `;
      filesList.appendChild(item);
    });

    selectedFiles.forEach((f, idx) => {
      const item = document.createElement('div');
      item.className = 'file-preview-item';
      item.innerHTML = `
        <span>📎 ${escapeHtml(f.name)} (${(f.size / 1024).toFixed(0)}KB)</span>
        <button type="button" class="btn-remove-file" data-type="local" data-idx="${idx}">×</button>
      `;
      filesList.appendChild(item);
    });

    filesList.querySelectorAll('.btn-remove-file').forEach(btn => {
      btn.onclick = () => {
        const type = btn.getAttribute('data-type');
        const idx = parseInt(btn.getAttribute('data-idx'), 10);
        if (type === 'staged') {
          stagedFiles.splice(idx, 1);
        } else {
          selectedFiles.splice(idx, 1);
        }
        renderFiles();
      };
    });
  }

  // 6. Handle Native Web Share Target API Ingestion
  async function checkSharedFiles() {
    const urlParams = new URLSearchParams(window.location.search);
    if (urlParams.has('shared') || urlParams.has('title') || urlParams.has('text')) {
      const title = urlParams.get('title') || '';
      const text = urlParams.get('text') || '';
      const shareText = [title, text].filter(Boolean).join(' ');
      if (shareText && messageInput) {
        messageInput.value = shareText;
      }
      window.history.replaceState({}, document.title, window.location.pathname);
    }
    try {
      const res = await fetch('/api/staged-files');
      const data = await res.json();
      if (data?.files && data.files.length > 0) {
        stagedFiles = data.files;
        renderFiles();
      }
    } catch (_) {}
  }
  checkSharedFiles();

  // 7. Phone & Recipient Formatting
  function formatPhone(phoneStr) {
    if (!phoneStr) return '';
    const digits = String(phoneStr).replace(/\D/g, '');
    if (digits.length === 10) {
      return `+91 ${digits.slice(0, 5)} ${digits.slice(5)}`;
    } else if (digits.length === 12 && digits.startsWith('91')) {
      return `+91 ${digits.slice(2, 7)} ${digits.slice(7)}`;
    }
    return digits ? `+${digits}` : '';
  }

  // 8. Sync Progress Bar & Native Contact Sync Bridge
  function updateSyncProgress(percent, message, autoHide = false) {
    if (!syncBanner) return;
    syncBanner.style.display = 'flex';
    if (syncProgressBar) syncProgressBar.style.width = `${Math.min(100, Math.max(0, percent))}%`;
    if (syncPercentBadge) syncPercentBadge.textContent = `${Math.round(percent)}%`;
    if (syncBannerText) syncBannerText.textContent = message;

    if (autoHide && percent >= 100) {
      setTimeout(() => {
        syncBanner.style.display = 'none';
        if (syncProgressBar) syncProgressBar.style.width = '0%';
      }, 3500);
    }
  }

  window.onNativeContactsImported = async (contacts) => {
    try {
      const list = typeof contacts === 'string' ? JSON.parse(contacts) : contacts;
      if (Array.isArray(list) && list.length > 0) {
        updateSyncProgress(25, `Reading ${list.length} contacts from phonebook…`);
        updateSyncProgress(60, `Uploading ${list.length} contacts to database…`);
        const res = await fetch('/api/contacts/import', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ contacts: list })
        });
        const data = await res.json();
        updateSyncProgress(90, `Refreshing contact lists…`);
        await loadContacts();
        const count = data.count || list.length;
        updateSyncProgress(100, `✓ Synced all ${count} contacts with exact names!`, true);
        showToast(`✓ Imported ${count} contacts with exact phonebook names!`, 4000);
        renderContactSuggestions(recipientInput.value);
      } else {
        showToast('No phonebook contacts found on device.');
      }
    } catch (err) {
      console.error('Error importing native contacts:', err);
      showToast(`Contact sync error: ${err.message}`);
    }
  };

  if (pickNativeContactBtn) {
    pickNativeContactBtn.onclick = async () => {
      if (headerStatus && !headerStatus.classList.contains('connected')) {
        showToast('Please connect WhatsApp first before syncing contacts.');
        return;
      }

      if (window.AndroidNative && typeof window.AndroidNative.importAllContacts === 'function') {
        updateSyncProgress(10, 'Requesting Android phonebook permission…');
        window.AndroidNative.importAllContacts();
        return;
      }

      if (navigator.contacts && typeof navigator.contacts.select === 'function') {
        try {
          const contacts = await navigator.contacts.select(['name', 'tel'], { multiple: true });
          if (contacts && contacts.length > 0) {
            const formatted = [];
            for (const c of contacts) {
              const name = c.name && c.name[0] ? c.name[0].trim() : '';
              const telList = c.tel || [];
              for (const t of telList) {
                const digits = String(t).replace(/\D/g, '');
                if (digits.length >= 7) {
                  formatted.push({ name, phone: digits });
                }
              }
            }

            if (formatted.length > 0) {
              updateSyncProgress(40, `Importing ${formatted.length} contacts…`);
              const res = await fetch('/api/contacts/import', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ contacts: formatted })
              });
              const data = await res.json();
              await loadContacts();
              updateSyncProgress(100, `✓ Synced ${data.count || formatted.length} contacts!`, true);
              showToast(`✓ Imported ${data.count || formatted.length} contacts with names!`);
              renderContactSuggestions(recipientInput.value);
            }
          }
        } catch (err) {
          console.log('Contact picker cancelled/error:', err);
        }
      } else {
        showToast('Tip: Install the Android APK for 1-tap full phonebook sync.');
      }
    };
  }

  // 9. Contact Autocomplete Engine
  async function loadContacts() {
    try {
      const res = await fetch('/api/contacts');
      const data = await res.json();
      if (data?.contacts) allContacts = data.contacts;
    } catch (_) {}
  }
  loadContacts();
  setInterval(loadContacts, 10000);

  async function loadAvatar(jid, el) {
    if (!jid || jid.includes('@broadcast')) return;
    if (avatarCache.has(jid)) {
      const cached = avatarCache.get(jid);
      if (cached && el) {
        el.textContent = '';
        const img = document.createElement('img');
        img.src = cached;
        img.alt = '';
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
          el.textContent = '';
          const img = document.createElement('img');
          img.src = data.url;
          img.alt = '';
          el.appendChild(img);
        }
      }
    } catch (_) {}
  }

  function renderContactSuggestions(filter = '') {
    if (!contactsDropdown) return;
    const q = filter.trim().toLowerCase();
    const qDigits = q.replace(/\D/g, '');
    let matches = [];

    if (!q) {
      const people = allContacts.filter(c => !c.is_group);
      const groups = allContacts.filter(c => c.is_group);
      matches = [...people, ...groups].slice(0, 20);
    } else {
      const filtered = allContacts.filter(c => {
        const cName = (c.name || '').toLowerCase();
        const cPhone = (c.phone || '').replace(/\D/g, '');
        if (cName && cName.includes(q)) return true;
        if (qDigits) {
          if (cPhone.includes(qDigits)) return true;
          if (qDigits.length === 10 && cPhone === '91' + qDigits) return true;
          if (cPhone.startsWith('91') && cPhone.slice(2).includes(qDigits)) return true;
        }
        return false;
      });
      const people = filtered.filter(c => !c.is_group);
      const groups = filtered.filter(c => c.is_group);
      matches = [...people, ...groups].slice(0, 20);
    }

    contactsDropdown.textContent = '';

    if (matches.length === 0) {
      if (allContacts.length === 0) {
        const tipBox = document.createElement('div');
        tipBox.style.cssText = 'padding: 12px 14px; font-size: 12px; color: var(--text-muted); line-height: 1.5;';
        tipBox.innerHTML = `⏳ WhatsApp contacts are syncing in background.<br><strong>Tip:</strong> You can type any 10-digit number directly (e.g. <code>9876543210</code>).`;
        contactsDropdown.appendChild(tipBox);
        contactsDropdown.style.display = 'block';
        return;
      }
      contactsDropdown.style.display = 'none';
      return;
    }

    const headEl = document.createElement('div');
    headEl.style.cssText = 'padding: 6px 12px; font-size: 11px; font-weight: 600; color: var(--text-muted); border-bottom: 1px solid var(--border-subtle); display: flex; justify-content: space-between;';
    const headTitle = document.createElement('span');
    headTitle.textContent = q ? 'MATCHING CONTACTS' : 'RECENT CHATS & CONTACTS';
    const headCount = document.createElement('span');
    headCount.textContent = `${allContacts.length} Synced`;
    headEl.appendChild(headTitle);
    headEl.appendChild(headCount);
    contactsDropdown.appendChild(headEl);

    matches.forEach(c => {
      const item = document.createElement('div');
      item.className = 'suggestion-item';

      const avatar = document.createElement('div');
      avatar.className = 'suggestion-avatar';
      avatar.textContent = c.is_group ? '👥' : '👤';
      if (c.jid) loadAvatar(c.jid, avatar);

      const info = document.createElement('div');
      info.className = 'suggestion-info';

      const nameEl = document.createElement('div');
      nameEl.className = 'suggestion-name';
      nameEl.textContent = c.name || (c.is_group ? 'WhatsApp Group' : 'Contact');

      const phoneEl = document.createElement('div');
      phoneEl.className = 'suggestion-phone';
      phoneEl.textContent = c.is_group ? 'Group Chat' : formatPhone(c.phone);

      info.appendChild(nameEl);
      info.appendChild(phoneEl);
      item.appendChild(avatar);
      item.appendChild(info);

      item.onclick = () => {
        recipientInput.value = c.is_group ? c.name : (c.name ? `${c.name} (${formatPhone(c.phone)})` : formatPhone(c.phone));
        recipientInput.setAttribute('data-jid', c.jid || '');
        recipientInput.setAttribute('data-phone', c.phone || '');
        contactsDropdown.style.display = 'none';
      };

      contactsDropdown.appendChild(item);
    });

    contactsDropdown.style.display = 'block';
  }

  recipientInput.addEventListener('focus', () => renderContactSuggestions(recipientInput.value));
  recipientInput.addEventListener('input', () => {
    recipientInput.removeAttribute('data-jid');
    recipientInput.removeAttribute('data-phone');
    renderContactSuggestions(recipientInput.value);
  });

  document.addEventListener('click', (e) => {
    if (!recipientInput.contains(e.target) && !contactsDropdown.contains(e.target)) {
      contactsDropdown.style.display = 'none';
    }
  });

  // 10. Submit Schedule Form
  scheduleForm.onsubmit = async (e) => {
    e.preventDefault();
    const rawRecipient = recipientInput.value.trim();
    const boundJid = recipientInput.getAttribute('data-jid');
    const boundPhone = recipientInput.getAttribute('data-phone');

    let recipient = rawRecipient;
    if (boundJid) {
      recipient = boundJid;
    } else if (boundPhone) {
      recipient = boundPhone;
    } else {
      const match = allContacts.find(c => (c.name && c.name.toLowerCase() === rawRecipient.toLowerCase()) || c.phone === rawRecipient.replace(/\D/g, ''));
      if (match) {
        recipient = match.jid || match.phone;
      }
    }

    const text = messageInput.value.trim();
    const dateVal = dateInput.value;
    const timeVal = timeInput.value;
    const isRecurring = isRecurringCheckbox?.checked;
    const pattern = isRecurring ? recurrencePattern?.value : null;

    if (!recipient) {
      showToast('Please enter a valid recipient or select from dropdown.');
      return;
    }
    if (!text && selectedFiles.length === 0 && stagedFiles.length === 0) {
      showToast('Please enter a message text or attach at least one file.');
      return;
    }
    if (!dateVal || !timeVal) {
      showToast('Please select scheduled date and time.');
      return;
    }

    const scheduledDate = new Date(`${dateVal}T${timeVal}`);
    const scheduledAt = scheduledDate.getTime();

    if (scheduledAt <= Date.now()) {
      showToast('Scheduled time must be in the future.');
      return;
    }

    submitBtn.disabled = true;
    submitBtn.innerHTML = '<span>Scheduling…</span>';

    try {
      const formData = new FormData();
      formData.append('recipient', recipient);
      formData.append('text', text);
      formData.append('scheduledAt', scheduledAt);
      if (isRecurring && pattern) {
        formData.append('isRecurring', 'true');
        formData.append('recurrencePattern', pattern);
      }

      selectedFiles.forEach(f => formData.append('attachments', f));
      if (stagedFiles.length > 0) {
        formData.append('stagedAttachments', JSON.stringify(stagedFiles));
      }

      const res = await fetch('/api/schedules', {
        method: 'POST',
        body: formData
      });
      const data = await res.json();

      if (data.success) {
        showToast('✓ Message Scheduled Successfully!');
        messageInput.value = '';
        selectedFiles = [];
        stagedFiles = [];
        renderFiles();
        recipientInput.removeAttribute('data-jid');
        recipientInput.removeAttribute('data-phone');

        const queueTab = document.querySelector('.nav-item[data-tab="paneQueue"]');
        if (queueTab) queueTab.click();
      } else {
        showToast(`Schedule Failed: ${data.error}`);
      }
    } catch (err) {
      showToast(`Error: ${err.message}`);
    } finally {
      submitBtn.disabled = false;
      submitBtn.innerHTML = '<span>Schedule Message</span>';
    }
  };

  // 11. Queue Management & Recipient Formatting
  async function loadSchedules() {
    try {
      const res = await fetch('/api/schedules');
      const data = await res.json();
      if (!data?.schedules) return;

      if (data.schedules.length === 0) {
        queueList.innerHTML = `<div class="empty-state">No scheduled messages.<br>Tap "Schedule" to create one.</div>`;
        return;
      }

      queueList.innerHTML = data.schedules.map(job => {
        const timeStr = new Date(job.scheduled_at).toLocaleString([], { 
          month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' 
        });
        const files = job.attachments || [];

        // Match contact name from server response or cached contacts
        let contactName = job.contact_name || '';
        const digits = (job.recipient || '').replace(/\D/g, '');
        if (!contactName && digits && allContacts.length > 0) {
          const match = allContacts.find(c => c.phone && (digits.endsWith(c.phone) || c.phone.endsWith(digits)));
          if (match && match.name && match.name !== match.phone) {
            contactName = match.name;
          }
        }
        const formattedPhone = digits ? formatPhone(digits) : job.recipient;

        return `
          <div class="job-card">
            <div class="job-head">
              <div class="job-recipient-container">
                ${contactName ? `<span class="job-recipient-name">👤 ${escapeHtml(contactName)}</span>` : ''}
                <span class="job-recipient-phone">📞 ${escapeHtml(formattedPhone)}</span>
              </div>
              <span class="job-status-badge ${job.status}">${job.status}</span>
            </div>
            ${job.text ? `<div class="job-text">${escapeHtml(job.text)}</div>` : ''}
            ${files.length > 0 ? `
              <div class="job-files">
                ${files.map(f => `<span class="job-file-pill">📎 ${escapeHtml(f.name || 'File')}</span>`).join('')}
              </div>
            ` : ''}
            <div class="job-foot">
              <span>🕒 ${timeStr}</span>
              ${job.status === 'scheduled' || job.status === 'retrying' ? `
                <button type="button" class="job-cancel-btn" data-id="${job.id}">Cancel</button>
              ` : `
                <span>${job.status === 'sent' ? '✓ Sent' : (job.error || 'Failed')}</span>
              `}
            </div>
          </div>
        `;
      }).join('');

      queueList.querySelectorAll('.job-cancel-btn').forEach(btn => {
        btn.onclick = async () => {
          const id = btn.getAttribute('data-id');
          if (!confirm('Cancel this scheduled message?')) return;
          try {
            await fetch(`/api/schedules/${id}`, { method: 'DELETE' });
            showToast('Scheduled message cancelled');
            loadSchedules();
          } catch (_) {}
        };
      });
    } catch (_) {
      queueList.innerHTML = `<div class="empty-state">Failed to load schedules.</div>`;
    }
  }

  if (refreshQueueBtn) refreshQueueBtn.onclick = loadSchedules;

  // 12. Connection Status & Pairing
  async function checkStatus() {
    try {
      const res = await fetch('/api/status');
      const data = await res.json();
      
      const isConn = data.status === 'connected';
      const isSyncing = Boolean(data.syncing);

      headerStatus.className = `status-indicator ${data.status}`;
      
      if (pickNativeContactBtn) {
        if (isConn) {
          pickNativeContactBtn.disabled = false;
          pickNativeContactBtn.removeAttribute('disabled');
          pickNativeContactBtn.classList.remove('btn-disabled');
          pickNativeContactBtn.title = "Sync contacts from phonebook";
        } else {
          pickNativeContactBtn.disabled = true;
          pickNativeContactBtn.setAttribute('disabled', 'true');
          pickNativeContactBtn.classList.add('btn-disabled');
          pickNativeContactBtn.title = "Connect WhatsApp first to sync phonebook";
        }
      }

      if (isConn) {
        if (isSyncing) {
          headerStatus.querySelector('.status-text').innerHTML = `Connected <span class="sync-spinner-inline"></span>`;
          updateSyncProgress(85, 'Syncing WhatsApp contacts & history…');
        } else {
          headerStatus.querySelector('.status-text').textContent = 'Connected';
          if (syncBanner && syncBannerText && syncBannerText.textContent.includes('Syncing WhatsApp')) {
            updateSyncProgress(100, '✓ WhatsApp Contacts Synced', true);
          }
        }

        if (qrModal.classList.contains('active')) {
          qrModal.classList.remove('active');
          showToast('✓ WhatsApp Connected Successfully!');
          const schedTab = document.querySelector('.nav-item[data-tab="paneSchedule"]');
          if (schedTab) schedTab.click();
        }
      } else {
        headerStatus.querySelector('.status-text').textContent = data.status === 'connecting' ? 'Connecting…' : 'Disconnected';
      }
    } catch (_) {
      headerStatus.className = 'status-indicator disconnected';
      headerStatus.querySelector('.status-text').textContent = 'Offline';
    }
  }

  checkStatus();
  setInterval(checkStatus, 2500);

  // 13. QR Modal & Pairing Handlers
  if (openQrBtn) {
    openQrBtn.onclick = async () => {
      qrModal.classList.add('active');
      qrLoading.style.display = 'block';
      qrImage.style.display = 'none';

      try {
        const res = await fetch('/api/qr');
        const data = await res.json();
        if (data.qr) {
          qrImage.src = data.qr;
          qrImage.style.display = 'block';
          qrLoading.style.display = 'none';
        } else {
          qrLoading.textContent = data.connected ? 'Already Connected!' : 'Generating QR Code…';
        }
      } catch (_) {
        qrLoading.textContent = 'Failed to load QR code.';
      }
    };
  }

  if (closeQrModal) closeQrModal.onclick = () => qrModal.classList.remove('active');

  if (pairCodeBtn) {
    pairCodeBtn.onclick = () => {
      pairModal.classList.add('active');
      pairCodeDisplay.style.display = 'none';
      pairPhoneInput.value = '';
    };
  }

  if (closePairModal) closePairModal.onclick = () => pairModal.classList.remove('active');

  if (requestPairCodeBtn) {
    requestPairCodeBtn.onclick = async () => {
      const phone = pairPhoneInput.value.trim().replace(/\D/g, '');
      if (!phone || phone.length < 10) {
        showToast('Please enter a valid phone number with country code (e.g. 919876543210)');
        return;
      }

      requestPairCodeBtn.disabled = true;
      requestPairCodeBtn.textContent = 'Requesting…';

      try {
        const res = await fetch('/api/pair-code', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ phone })
        });
        const data = await res.json();

        if (data.success && data.code) {
          pairCodeResult.textContent = data.code;
          pairCodeDisplay.style.display = 'block';
        } else {
          showToast(data.error || 'Failed to generate pairing code');
        }
      } catch (err) {
        showToast(`Error: ${err.message}`);
      } finally {
        requestPairCodeBtn.disabled = false;
        requestPairCodeBtn.textContent = 'Get 8-Digit Pairing Code';
      }
    };
  }
});