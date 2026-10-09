document.addEventListener('DOMContentLoaded', () => {
  // DOM Elements - Navigation & Panes
  const paneSchedule = document.getElementById('paneSchedule');
  const paneQueue = document.getElementById('paneQueue');
  const paneDevice = document.getElementById('paneDevice');
  const navItems = document.querySelectorAll('.nav-item');

  // DOM Elements - Header
  const headerStatus = document.getElementById('headerStatus');
  const linkDeviceBtn = document.getElementById('linkDeviceBtn');

  // DOM Elements - Schedule Form
  const scheduleForm = document.getElementById('scheduleForm');
  const recipientInput = document.getElementById('recipientInput');
  const contactsDropdown = document.getElementById('contactsDropdown');
  const messageInput = document.getElementById('messageInput');
  const dateInput = document.getElementById('dateInput');
  const timeInput = document.getElementById('timeInput');
  const filePicker = document.getElementById('filePicker');
  const addFileBtn = document.getElementById('addFileBtn');
  const filesList = document.getElementById('filesList');
  const submitScheduleBtn = document.getElementById('submitScheduleBtn');
  const pickNativeContactBtn = document.getElementById('pickNativeContactBtn');

  // DOM Elements - Sync Banner
  const syncBanner = document.getElementById('syncBanner');
  const syncBannerText = document.getElementById('syncBannerText');
  const syncProgressBar = document.getElementById('syncProgressBar');
  const syncPercentBadge = document.getElementById('syncPercentBadge');

  // DOM Elements - Queue
  const queueList = document.getElementById('queueList');
  const refreshQueueBtn = document.getElementById('refreshQueueBtn');

  // DOM Elements - Device Link
  const devicePill = document.getElementById('devicePill');
  const deviceUserInfo = document.getElementById('deviceUserInfo');
  const showQrBtn = document.getElementById('showQrBtn');
  const showPairCodeBtn = document.getElementById('showPairCodeBtn');
  const logoutBox = document.getElementById('logoutBox');
  const logoutBtn = document.getElementById('logoutBtn');

  // DOM Elements - QR Modal
  const qrModal = document.getElementById('qrModal');
  const qrModalClose = document.getElementById('qrModalClose');
  const qrImg = document.getElementById('qrImg');
  const qrSpinner = document.getElementById('qrSpinner');
  const qrStatusText = document.getElementById('qrStatusText');

  // DOM Elements - Pair Code Modal
  const pairModal = document.getElementById('pairModal');
  const pairModalClose = document.getElementById('pairModalClose');
  const pairPhoneInput = document.getElementById('pairPhoneInput');
  const requestPairCodeBtn = document.getElementById('requestPairCodeBtn');
  const pairCodeDisplay = document.getElementById('pairCodeDisplay');
  const pairCodeResult = document.getElementById('pairCodeResult');

  // State
  let selectedFiles = [];
  let stagedFiles = [];
  let allContacts = [];
  const avatarCache = new Map();
  let qrPollInterval = null;

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

  // Helper: Format Phone Number
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

  // 1. Toast Notification
  function showToast(msg, duration = 3000) {
    const toast = document.getElementById('toast');
    if (!toast) return;
    toast.textContent = msg;
    toast.classList.add('show');
    setTimeout(() => toast.classList.remove('show'), duration);
  }

  // 2. Register Service Worker
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  }

  // 3. Tab Switching
  function switchTab(targetId) {
    navItems.forEach(n => {
      if (n.getAttribute('data-tab') === targetId) {
        n.classList.add('active');
      } else {
        n.classList.remove('active');
      }
    });

    [paneSchedule, paneQueue, paneDevice].forEach(p => {
      if (p) {
        if (p.id === targetId) {
          p.classList.add('active');
        } else {
          p.classList.remove('active');
        }
      }
    });

    if (targetId === 'paneQueue') {
      loadSchedules();
    } else if (targetId === 'paneSchedule') {
      loadContacts();
    } else if (targetId === 'paneDevice') {
      checkStatus();
    }
  }

  navItems.forEach(item => {
    item.addEventListener('click', () => {
      const target = item.getAttribute('data-tab');
      if (target) switchTab(target);
    });
  });

  if (linkDeviceBtn) {
    linkDeviceBtn.addEventListener('click', () => switchTab('paneDevice'));
  }

  if (headerStatus) {
    headerStatus.style.cursor = 'pointer';
    headerStatus.addEventListener('click', () => switchTab('paneDevice'));
  }

  // 4. Default Date & Time
  function initDateTime() {
    const now = new Date();
    if (dateInput) dateInput.value = now.toISOString().split('T')[0];
    
    const future = new Date(now.getTime() + 15 * 60000);
    const hours = String(future.getHours()).padStart(2, '0');
    const minutes = String(future.getMinutes()).padStart(2, '0');
    if (timeInput) timeInput.value = `${hours}:${minutes}`;

    document.querySelectorAll('.preset-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.preset-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        const mins = parseInt(btn.getAttribute('data-mins'), 10);
        const targetDate = new Date(Date.now() + mins * 60000);
        if (dateInput) dateInput.value = targetDate.toISOString().split('T')[0];
        if (timeInput) timeInput.value = `${String(targetDate.getHours()).padStart(2, '0')}:${String(targetDate.getMinutes()).padStart(2, '0')}`;
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
        <span>📎 ${escapeHtml(f.name || 'Attachment')} (${f.size ? (f.size / 1024).toFixed(0) + 'KB' : 'File'})</span>
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

  // 6. Native Share Target API
  async function checkSharedData() {
    const params = new URLSearchParams(window.location.search);
    const shareText = [params.get('title'), params.get('text')].filter(Boolean).join(' ');
    if (shareText && messageInput) {
      messageInput.value = shareText;
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
  checkSharedData();

  // 7. Sync Progress Bar & Native Contact Sync Bridge
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
        if (recipientInput) renderContactSuggestions(recipientInput.value);
      } else {
        showToast('No phonebook contacts found on device.');
      }
    } catch (err) {
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
              if (recipientInput) renderContactSuggestions(recipientInput.value);
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

  // 8. Contact Autocomplete Engine
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

  if (recipientInput) {
    recipientInput.addEventListener('focus', () => renderContactSuggestions(recipientInput.value));
    recipientInput.addEventListener('input', () => {
      recipientInput.removeAttribute('data-jid');
      recipientInput.removeAttribute('data-phone');
      renderContactSuggestions(recipientInput.value);
    });
  }

  document.addEventListener('click', (e) => {
    if (recipientInput && contactsDropdown && !recipientInput.contains(e.target) && !contactsDropdown.contains(e.target)) {
      contactsDropdown.style.display = 'none';
    }
  });

  // 9. Submit Schedule Form
  if (scheduleForm) {
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

      if (!recipient) {
        showToast('Please enter a recipient or select a contact.');
        return;
      }
      if (!text && selectedFiles.length === 0 && stagedFiles.length === 0) {
        showToast('Please enter message text or add an attachment.');
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

      if (submitScheduleBtn) {
        submitScheduleBtn.disabled = true;
        submitScheduleBtn.innerHTML = '<span>Scheduling…</span>';
      }

      try {
        const formData = new FormData();
        formData.append('recipient', recipient);
        formData.append('text', text);
        formData.append('scheduledAt', scheduledAt);

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
          switchTab('paneQueue');
        } else {
          showToast(`Schedule Failed: ${data.error}`);
        }
      } catch (err) {
        showToast(`Error: ${err.message}`);
      } finally {
        if (submitScheduleBtn) {
          submitScheduleBtn.disabled = false;
          submitScheduleBtn.innerHTML = '<span>Schedule Message</span>';
        }
      }
    };
  }

  // 10. Queue Management
  async function loadSchedules() {
    try {
      const res = await fetch('/api/schedules');
      const data = await res.json();
      if (!data?.schedules || !queueList) return;

      if (data.schedules.length === 0) {
        queueList.innerHTML = `<div class="empty-state">No scheduled messages.<br>Tap "Schedule" to create one.</div>`;
        return;
      }

      queueList.innerHTML = data.schedules.map(job => {
        const timeStr = new Date(job.scheduled_at).toLocaleString([], { 
          month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' 
        });
        const files = job.attachments || [];

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
      if (queueList) queueList.innerHTML = `<div class="empty-state">Failed to load schedules.</div>`;
    }
  }

  if (refreshQueueBtn) refreshQueueBtn.onclick = loadSchedules;

  // 11. Live Connection Status, Input Locking & QR Code Polling
  let syncAnimationPercent = 0;
  let syncAnimTimer = null;

  function setScheduleInputsLock(isLocked, mode = 'disconnected', count = 0) {
    if (recipientInput) {
      recipientInput.disabled = isLocked;
      if (isLocked) {
        recipientInput.classList.add('input-disabled');
        recipientInput.placeholder = mode === 'syncing' 
          ? '⏳ Syncing WhatsApp contacts… Please wait' 
          : '⚠️ Connect WhatsApp first to schedule messages';
      } else {
        recipientInput.classList.remove('input-disabled');
        recipientInput.placeholder = 'Name or +919876543210…';
      }
    }

    if (pickNativeContactBtn) {
      pickNativeContactBtn.disabled = isLocked;
      if (isLocked) {
        pickNativeContactBtn.classList.add('btn-disabled');
        pickNativeContactBtn.title = mode === 'syncing' ? 'Sync in progress…' : 'Connect WhatsApp first to sync phonebook';
      } else {
        pickNativeContactBtn.classList.remove('btn-disabled');
        pickNativeContactBtn.title = 'Sync contacts from phonebook';
      }
    }

    if (messageInput) {
      messageInput.disabled = isLocked;
      if (isLocked) {
        messageInput.classList.add('input-disabled');
        messageInput.placeholder = mode === 'syncing' 
          ? 'Message input will unlock once 100% sync completes…' 
          : 'Connect WhatsApp to enable message composition';
      } else {
        messageInput.classList.remove('input-disabled');
        messageInput.placeholder = 'Type your scheduled message…';
      }
    }

    if (submitScheduleBtn) {
      submitScheduleBtn.disabled = isLocked;
      if (isLocked) {
        submitScheduleBtn.classList.add('btn-disabled');
      } else {
        submitScheduleBtn.classList.remove('btn-disabled');
      }
    }
  }

  async function checkStatus() {
    try {
      const res = await fetch('/api/status');
      const data = await res.json();
      
      const isConn = data.status === 'connected';
      const isSyncing = Boolean(data.syncing);
      const contactCount = data.contactCount || 0;

      if (headerStatus) {
        headerStatus.className = `status-indicator ${data.status}`;
      }

      if (devicePill) {
        if (isConn) {
          devicePill.textContent = 'Status: Connected ✓';
          devicePill.style.background = 'rgba(37, 211, 102, 0.15)';
          devicePill.style.color = '#25D366';
        } else {
          devicePill.textContent = data.status === 'connecting' ? 'Status: Connecting…' : 'Status: Disconnected';
          devicePill.style.background = 'rgba(234, 67, 53, 0.15)';
          devicePill.style.color = '#ff6b6b';
        }
      }

      if (deviceUserInfo) {
        if (isConn && data.user) {
          deviceUserInfo.innerHTML = `<strong>Linked Account:</strong> ${escapeHtml(data.user.name || '')} (${data.user.id ? data.user.id.split(':')[0] : ''})<br><small style="color: var(--text-muted);">${contactCount} Contacts Synced</small>`;
          deviceUserInfo.style.display = 'block';
        } else {
          deviceUserInfo.style.display = 'none';
        }
      }

      if (logoutBox) {
        logoutBox.style.display = isConn ? 'block' : 'none';
      }

      if (isConn) {
        if (isSyncing) {
          // Locked during sync until 100%
          setScheduleInputsLock(true, 'syncing', contactCount);

          if (headerStatus) headerStatus.querySelector('.status-text').innerHTML = `Syncing ${contactCount > 0 ? '(' + contactCount + ')' : ''} <span class="sync-spinner-inline"></span>`;
          
          if (!syncAnimTimer) {
            syncAnimationPercent = 15;
            syncAnimTimer = setInterval(() => {
              if (syncAnimationPercent < 90) {
                syncAnimationPercent += Math.floor(Math.random() * 8) + 4;
                if (syncAnimationPercent > 90) syncAnimationPercent = 90;
                updateSyncProgress(syncAnimationPercent, `Syncing contacts from WhatsApp… ${contactCount > 0 ? contactCount + ' synced' : ''}`);
              }
            }, 600);
          } else {
            updateSyncProgress(syncAnimationPercent, `Syncing contacts from WhatsApp… ${contactCount > 0 ? contactCount + ' synced' : ''}`);
          }
        } else {
          // 100% Sync Complete & Connected -> UNLOCK ALL INPUTS!
          if (syncAnimTimer) {
            clearInterval(syncAnimTimer);
            syncAnimTimer = null;
            syncAnimationPercent = 100;
            updateSyncProgress(100, `✓ 100% Synced (${contactCount} contacts from WhatsApp)`, true);
            loadContacts();
          }

          setScheduleInputsLock(false, 'ready', contactCount);
          if (headerStatus) headerStatus.querySelector('.status-text').textContent = 'Connected';
        }

        if (qrModal && qrModal.classList.contains('active')) {
          qrModal.classList.remove('active');
          if (qrPollInterval) { clearInterval(qrPollInterval); qrPollInterval = null; }
          showToast('✓ WhatsApp Connected Successfully!');
          switchTab('paneSchedule');
        }
        if (pairModal && pairModal.classList.contains('active')) {
          pairModal.classList.remove('active');
          showToast('✓ WhatsApp Connected Successfully!');
          switchTab('paneSchedule');
        }
      } else {
        // Disconnected -> Lock inputs with prompt to connect
        setScheduleInputsLock(true, 'disconnected');
        if (headerStatus) {
          headerStatus.querySelector('.status-text').textContent = data.status === 'connecting' ? 'Connecting…' : 'Disconnected';
        }

        if (qrModal && qrModal.classList.contains('active')) {
          if (data.qr) {
            if (qrImg) {
              qrImg.src = data.qr;
              qrImg.style.display = 'block';
            }
            if (qrSpinner) qrSpinner.style.display = 'none';
          }
        }
      }
    } catch (_) {
      setScheduleInputsLock(true, 'disconnected');
      if (headerStatus) {
        headerStatus.className = 'status-indicator disconnected';
        headerStatus.querySelector('.status-text').textContent = 'Offline';
      }
    }
  }

  // 12. Show QR Code Modal Handler
  async function fetchQrNow() {
    try {
      const res = await fetch('/api/qr');
      const data = await res.json();
      if (data.qr) {
        if (qrImg) {
          qrImg.src = data.qr;
          qrImg.style.display = 'block';
        }
        if (qrSpinner) qrSpinner.style.display = 'none';
      } else if (data.connected) {
        if (qrSpinner) {
          qrSpinner.style.display = 'flex';
          if (qrStatusText) qrStatusText.textContent = '✓ Already Connected!';
        }
      } else {
        if (qrSpinner) {
          qrSpinner.style.display = 'flex';
          if (qrStatusText) qrStatusText.textContent = 'Generating QR Code…';
        }
      }
    } catch (_) {
      if (qrSpinner && qrStatusText) qrStatusText.textContent = 'Failed to load QR code.';
    }
  }

  if (showQrBtn) {
    showQrBtn.onclick = () => {
      if (qrModal) {
        qrModal.classList.add('active');
        if (qrSpinner) qrSpinner.style.display = 'flex';
        if (qrImg) qrImg.style.display = 'none';
        if (qrStatusText) qrStatusText.textContent = 'Loading QR Code…';
        fetchQrNow();

        if (qrPollInterval) clearInterval(qrPollInterval);
        qrPollInterval = setInterval(fetchQrNow, 2000);
      }
    };
  }

  if (qrModalClose) {
    qrModalClose.onclick = () => {
      if (qrModal) qrModal.classList.remove('active');
      if (qrPollInterval) { clearInterval(qrPollInterval); qrPollInterval = null; }
    };
  }

  // 13. Show 8-Digit Pairing Code Modal Handler
  if (showPairCodeBtn) {
    showPairCodeBtn.onclick = () => {
      if (pairModal) {
        pairModal.classList.add('active');
        if (pairCodeDisplay) pairCodeDisplay.style.display = 'none';
        if (pairPhoneInput) {
          pairPhoneInput.value = '';
          setTimeout(() => pairPhoneInput.focus(), 150);
        }
      }
    };
  }

  if (pairModalClose) {
    pairModalClose.onclick = () => {
      if (pairModal) pairModal.classList.remove('active');
    };
  }

  // Close modals on clicking overlay backdrop
  window.addEventListener('click', (e) => {
    if (qrModal && e.target === qrModal) {
      qrModal.classList.remove('active');
      if (qrPollInterval) { clearInterval(qrPollInterval); qrPollInterval = null; }
    }
    if (pairModal && e.target === pairModal) {
      pairModal.classList.remove('active');
    }
  });

  // Request 8-Digit Pairing Code
  if (requestPairCodeBtn) {
    requestPairCodeBtn.onclick = async () => {
      let phone = (pairPhoneInput ? pairPhoneInput.value : '').trim().replace(/\D/g, '');
      if (phone.startsWith('0')) phone = phone.replace(/^0+/, '');
      if (phone.length === 10) {
        phone = '91' + phone;
      }

      if (!phone || phone.length < 10) {
        showToast('Please enter a valid 10-digit phone number (e.g. 9876543210)');
        return;
      }

      requestPairCodeBtn.disabled = true;
      requestPairCodeBtn.innerHTML = '<span>Requesting Code…</span>';

      try {
        const res = await fetch('/api/pair-code', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ phoneNumber: phone })
        });
        const data = await res.json();

        if (data.success && data.code) {
          // Format 8-digit code e.g. ABCD-1234
          const rawCode = String(data.code);
          const formattedCode = rawCode.length === 8 ? `${rawCode.slice(0, 4)}-${rawCode.slice(4)}` : rawCode;
          if (pairCodeResult) pairCodeResult.textContent = formattedCode;
          if (pairCodeDisplay) pairCodeDisplay.style.display = 'block';
          showToast('✓ 8-Digit Pairing Code Generated!');
        } else {
          showToast(data.error || 'Failed to generate pairing code');
        }
      } catch (err) {
        showToast(`Error: ${err.message}`);
      } finally {
        requestPairCodeBtn.disabled = false;
        requestPairCodeBtn.innerHTML = '<span>Get 8-Digit Pairing Code</span>';
      }
    };
  }

  // 14. Logout Handler
  if (logoutBtn) {
    logoutBtn.onclick = async () => {
      if (!confirm('Are you sure you want to unlink this WhatsApp account?')) return;
      try {
        logoutBtn.disabled = true;
        logoutBtn.textContent = 'Unlinking…';
        await fetch('/api/logout', { method: 'POST' });
        showToast('✓ WhatsApp Unlinked');
        checkStatus();
      } catch (err) {
        showToast(`Logout error: ${err.message}`);
      } finally {
        logoutBtn.disabled = false;
        logoutBtn.textContent = 'Unlink WhatsApp Account';
      }
    };
  }

  // 15. In-App Auto-Update Checker
  const updateBanner = document.getElementById('updateBanner');
  const updateVersionTag = document.getElementById('updateVersionTag');
  const updateNotes = document.getElementById('updateNotes');
  const updateNowBtn = document.getElementById('updateNowBtn');
  const updateDismissBtn = document.getElementById('updateDismissBtn');

  async function checkForUpdates() {
    try {
      const currentVersion = (window.AndroidNative && typeof window.AndroidNative.getAppVersionName === 'function')
        ? window.AndroidNative.getAppVersionName()
        : '1.0.0';

      const res = await fetch('https://api.github.com/repos/pannagaja/Whatsapp-Scheduler/releases/latest');
      if (!res.ok) return;
      const release = await res.json();
      if (!release || !release.tag_name) return;

      const latestTag = release.tag_name.replace(/^v/i, '').trim();
      const currentTag = currentVersion.replace(/^v/i, '').trim();

      if (latestTag && latestTag !== currentTag && latestTag > currentTag) {
        let apkUrl = `https://github.com/pannagaja/Whatsapp-Scheduler/releases/download/${release.tag_name}/WhatsApp-Scheduler.apk`;
        if (release.assets && release.assets.length > 0) {
          const apkAsset = release.assets.find(a => a.name.endsWith('.apk'));
          if (apkAsset && apkAsset.browser_download_url) {
            apkUrl = apkAsset.browser_download_url;
          }
        }

        if (updateBanner && updateVersionTag) {
          updateVersionTag.textContent = `v${latestTag}`;
          if (updateNotes && release.name) {
            updateNotes.textContent = release.name;
          }
          updateBanner.style.display = 'flex';

          if (updateNowBtn) {
            updateNowBtn.onclick = () => {
              if (window.AndroidNative && typeof window.AndroidNative.downloadAndInstallUpdate === 'function') {
                showToast('Starting in-app download…', 3000);
                window.AndroidNative.downloadAndInstallUpdate(apkUrl);
              } else {
                window.open(apkUrl, '_blank');
              }
            };
          }

          if (updateDismissBtn) {
            updateDismissBtn.onclick = () => {
              updateBanner.style.display = 'none';
            };
          }
        }
      }
    } catch (_) {}
  }

  setTimeout(checkForUpdates, 3000);

});