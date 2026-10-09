(() => {
  // DOM Elements
  const headerStatus = document.getElementById('headerStatus');
  const linkDeviceBtn = document.getElementById('linkDeviceBtn');
  const shareBanner = document.getElementById('shareBanner');
  const shareSummary = document.getElementById('shareSummary');
  const shareDismiss = document.getElementById('shareDismiss');
  
  const recipientInput = document.getElementById('recipientInput');
  const contactsDropdown = document.getElementById('contactsDropdown');
  const messageInput = document.getElementById('messageInput');
  const dateInput = document.getElementById('dateInput');
  const timeInput = document.getElementById('timeInput');
  const filePicker = document.getElementById('filePicker');
  const addFileBtn = document.getElementById('addFileBtn');
  const filesList = document.getElementById('filesList');
  const scheduleForm = document.getElementById('scheduleForm');
  const submitBtn = document.getElementById('submitScheduleBtn');
  
  const queueList = document.getElementById('queueList');
  const refreshQueueBtn = document.getElementById('refreshQueueBtn');
  
  const devicePill = document.getElementById('devicePill');
  const deviceUserInfo = document.getElementById('deviceUserInfo');
  const showQrBtn = document.getElementById('showQrBtn');
  const showPairCodeBtn = document.getElementById('showPairCodeBtn');
  const logoutBox = document.getElementById('logoutBox');
  const logoutBtn = document.getElementById('logoutBtn');
  
  const qrModal = document.getElementById('qrModal');
  const modalTitle = document.getElementById('modalTitle');
  const modalBody = document.getElementById('modalBody');
  const modalClose = document.getElementById('modalClose');
  const toast = document.getElementById('toast');

  let selectedFiles = []; // File objects
  let existingStagedFiles = []; // Staged files from /share endpoint
  let allContacts = [];
  let pollStatusTimer = null;

  // 1. Register PWA Service Worker
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  }

  // 2. Toast Notification
  function showToast(msg, duration = 3500) {
    toast.textContent = msg;
    toast.classList.add('active');
    setTimeout(() => toast.classList.remove('active'), duration);
  }

  // 3. Tab Switching
  document.querySelectorAll('.nav-item').forEach(btn => {
    btn.onclick = () => {
      document.querySelectorAll('.nav-item').forEach(b => b.classList.remove('active'));
      document.querySelectorAll('.tab-pane').forEach(p => p.classList.remove('active'));
      btn.classList.add('active');
      const target = document.getElementById(btn.getAttribute('data-tab'));
      if (target) target.classList.add('active');

      if (btn.getAttribute('data-tab') === 'paneQueue') loadSchedules();
      if (btn.getAttribute('data-tab') === 'paneDevice') checkStatus();
    };
  });

  linkDeviceBtn.onclick = () => {
    document.querySelector('.nav-item[data-tab="paneDevice"]').click();
  };

  // 4. Time Presets & Date Defaults
  function pad(n) { return String(n).padStart(2, '0'); }
  function setDateTime(d) {
    dateInput.value = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    timeInput.value = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }

  // Set default time: +15 minutes
  const defDate = new Date(Date.now() + 15 * 60 * 1000);
  setDateTime(defDate);

  document.querySelectorAll('.chip[data-preset]').forEach(chip => {
    chip.onclick = () => {
      const preset = chip.getAttribute('data-preset');
      const now = new Date();
      if (preset === '15m') now.setMinutes(now.getMinutes() + 15);
      else if (preset === '1h') now.setHours(now.getHours() + 1);
      else if (preset === '3h') now.setHours(now.getHours() + 3);
      else if (preset === 'tomorrow9') {
        now.setDate(now.getDate() + 1);
        now.setHours(9, 0, 0, 0);
      } else if (preset === 'tomorrow18') {
        now.setDate(now.getDate() + 1);
        now.setHours(18, 0, 0, 0);
      }
      setDateTime(now);
    };
  });

  // 5. Attachment Handling
  addFileBtn.onclick = () => filePicker.click();

  filePicker.onchange = () => {
    if (filePicker.files?.length) {
      for (const f of filePicker.files) selectedFiles.push(f);
      filePicker.value = '';
      renderFiles();
    }
  };

  function renderFiles() {
    filesList.innerHTML = '';
    
    // Existing staged files from native share
    existingStagedFiles.forEach((file, idx) => {
      const tag = document.createElement('div');
      tag.className = 'file-tag';
      tag.innerHTML = `
        <span class="file-name">📎 ${file.name}</span>
        <span class="file-remove" data-type="existing" data-idx="${idx}">✕</span>
      `;
      filesList.appendChild(tag);
    });

    // Local selected files
    selectedFiles.forEach((file, idx) => {
      const tag = document.createElement('div');
      tag.className = 'file-tag';
      tag.innerHTML = `
        <span class="file-name">📎 ${file.name} (${(file.size / 1024 / 1024).toFixed(2)} MB)</span>
        <span class="file-remove" data-type="local" data-idx="${idx}">✕</span>
      `;
      filesList.appendChild(tag);
    });

    filesList.querySelectorAll('.file-remove').forEach(btn => {
      btn.onclick = (e) => {
        e.stopPropagation();
        const type = btn.getAttribute('data-type');
        const idx = parseInt(btn.getAttribute('data-idx'), 10);
        if (type === 'existing') existingStagedFiles.splice(idx, 1);
        else selectedFiles.splice(idx, 1);
        renderFiles();
      };
    });
  }

  // 6. Handle Native Web Share Target API Ingestion
  async function checkIncomingShare() {
    const urlParams = new URLSearchParams(window.location.search);
    const shareId = urlParams.get('shareId');
    if (!shareId) return;

    // Clean up URL query param
    window.history.replaceState({}, document.title, window.location.pathname);

    try {
      const res = await fetch(`/api/shared/${shareId}`);
      const data = await res.json();
      if (data?.success) {
        if (data.text) messageInput.value = data.text;
        if (data.files && data.files.length > 0) {
          existingStagedFiles = data.files;
          renderFiles();
          shareSummary.textContent = `${data.files.length} file(s) attached`;
        } else {
          shareSummary.textContent = `Text message ready`;
        }
        shareBanner.style.display = 'flex';
      }
    } catch (_) {}
  }
  shareDismiss.onclick = () => { shareBanner.style.display = 'none'; };
  checkIncomingShare();

  // 7. Contact Autocomplete & Native Phone Contact Picker
  const pickNativeContactBtn = document.getElementById('pickNativeContactBtn');
  if ('contacts' in navigator && 'ContactsManager' in window) {
    pickNativeContactBtn.style.display = 'inline-block';
    pickNativeContactBtn.onclick = async () => {
      try {
        const contacts = await navigator.contacts.select(['name', 'tel'], { multiple: false });
        if (contacts && contacts[0]) {
          const c = contacts[0];
          const tel = c.tel && c.tel[0] ? c.tel[0].replace(/\D/g, '') : '';
          const name = c.name && c.name[0] ? c.name[0] : '';
          recipientInput.value = name || tel;
        }
      } catch (err) {
        console.log('Native contact picker error:', err);
      }
    };
  }

  async function loadContacts() {
    try {
      const res = await fetch('/api/contacts');
      const data = await res.json();
      if (data?.contacts) allContacts = data.contacts;
    } catch (_) {}
  }
  loadContacts();
  // Poll contacts every 10 seconds while on schedule tab
  setInterval(loadContacts, 10000);

  const avatarCache = new Map();

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
    const q = filter.trim().toLowerCase();
    const qDigits = q.replace(/\D/g, '');
    let matches = [];

    if (!q) {
      matches = allContacts.slice(0, 10);
    } else {
      matches = allContacts.filter(c => {
        const cName = (c.name || '').toLowerCase();
        const cPhone = (c.phone || '').replace(/\D/g, '');
        if (cName.includes(q)) return true;
        if (qDigits) {
          if (cPhone.includes(qDigits)) return true;
          if (qDigits.length === 10 && cPhone === '91' + qDigits) return true;
          if (cPhone.startsWith('91') && cPhone.slice(2).includes(qDigits)) return true;
        }
        return false;
      }).slice(0, 10);
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

    // Header
    const headEl = document.createElement('div');
    headEl.style.cssText = 'padding: 6px 12px; font-size: 11px; font-weight: 600; color: var(--text-muted); border-bottom: 1px solid var(--border-subtle); display: flex; justify-content: space-between;';
    const headTitle = document.createElement('span');
    headTitle.textContent = q ? 'MATCHING CONTACTS' : 'RECENT CHATS & CONTACTS';
    const headCount = document.createElement('span');
    headCount.textContent = `${allContacts.length} Synced`;
    headEl.appendChild(headTitle);
    headEl.appendChild(headCount);
    contactsDropdown.appendChild(headEl);

    // List items created via DOM elements
    matches.forEach(c => {
      const item = document.createElement('div');
      item.className = 'suggestion-item';
      item.setAttribute('data-recipient', c.jid || c.phone || c.name);

      // Avatar
      const avatarEl = document.createElement('div');
      avatarEl.className = 'suggestion-avatar';
      avatarEl.setAttribute('data-jid', c.jid || '');

      const cachedUrl = c.jid ? avatarCache.get(c.jid) : null;
      if (cachedUrl) {
        const img = document.createElement('img');
        img.src = cachedUrl;
        img.alt = '';
        avatarEl.appendChild(img);
      } else {
        avatarEl.textContent = c.is_group ? '👥' : '👤';
      }

      // Details
      const detailsEl = document.createElement('div');
      detailsEl.className = 'suggestion-details';

      const nameEl = document.createElement('span');
      nameEl.className = 'suggestion-name';
      nameEl.textContent = c.name || c.phone || c.jid;

      const phoneEl = document.createElement('span');
      phoneEl.className = 'suggestion-phone';
      if (c.is_group) {
        phoneEl.textContent = 'WhatsApp Group';
      } else if (c.phone) {
        phoneEl.textContent = c.phone.startsWith('91') ? '+91 ' + c.phone.slice(2) : '+' + c.phone;
      } else {
        phoneEl.textContent = '';
      }

      detailsEl.appendChild(nameEl);
      detailsEl.appendChild(phoneEl);

      item.appendChild(avatarEl);
      item.appendChild(detailsEl);

      item.onclick = () => {
        recipientInput.value = item.getAttribute('data-recipient');
        contactsDropdown.style.display = 'none';
      };

      contactsDropdown.appendChild(item);

      if (c.jid && !avatarCache.has(c.jid)) {
        loadAvatar(c.jid, avatarEl);
      }
    });

    contactsDropdown.style.display = 'block';
  }

  recipientInput.onfocus = () => {
    loadContacts().then(() => renderContactSuggestions(recipientInput.value));
  };

  recipientInput.oninput = () => {
    renderContactSuggestions(recipientInput.value);
  };

  document.addEventListener('click', (e) => {
    if (!recipientInput.contains(e.target) && !contactsDropdown.contains(e.target)) {
      contactsDropdown.style.display = 'none';
    }
  });

  // 8. Submit Schedule Form
  scheduleForm.onsubmit = async (e) => {
    e.preventDefault();
    const recipient = recipientInput.value.trim();
    const text = messageInput.value.trim();
    const dateVal = dateInput.value;
    const timeVal = timeInput.value;

    if (!recipient) return showToast('Please enter recipient');
    if (!text && selectedFiles.length === 0 && existingStagedFiles.length === 0) {
      return showToast('Please enter a message or attach a file');
    }
    if (!dateVal || !timeVal) return showToast('Please select date and time');

    const scheduledAt = new Date(`${dateVal}T${timeVal}`).getTime();
    if (!Number.isFinite(scheduledAt) || scheduledAt <= Date.now()) {
      return showToast('Scheduled time must be in the future');
    }

    submitBtn.disabled = true;
    submitBtn.innerHTML = '<span>Saving schedule…</span>';

    try {
      const formData = new FormData();
      formData.append('recipient', recipient);
      formData.append('text', text);
      formData.append('scheduledAt', String(scheduledAt));

      if (existingStagedFiles.length > 0) {
        formData.append('existingFiles', JSON.stringify(existingStagedFiles));
      }

      for (const file of selectedFiles) {
        formData.append('attachments', file);
      }

      const res = await fetch('/api/schedules', {
        method: 'POST',
        body: formData
      });

      const data = await res.json();
      if (!data?.success) throw new Error(data?.error || 'Failed to schedule');

      showToast(`Scheduled for ${new Date(scheduledAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`);
      
      // Reset form
      messageInput.value = '';
      selectedFiles = [];
      existingStagedFiles = [];
      shareBanner.style.display = 'none';
      renderFiles();
      setDateTime(new Date(Date.now() + 15 * 60 * 1000));
      
      // Switch to Queue tab
      document.querySelector('.nav-item[data-tab="paneQueue"]').click();
    } catch (err) {
      showToast(`Error: ${err.message}`);
    } finally {
      submitBtn.disabled = false;
      submitBtn.innerHTML = '<span>Schedule Message</span>';
    }
  };

  // 9. Queue Management
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

        return `
          <div class="job-card">
            <div class="job-head">
              <span class="job-recipient">To: ${job.recipient}</span>
              <span class="job-status-badge ${job.status}">${job.status}</span>
            </div>
            ${job.text ? `<div class="job-text">${job.text}</div>` : ''}
            ${files.length > 0 ? `
              <div class="job-files">
                ${files.map(f => `<span class="job-file-pill">📎 ${f.name}</span>`).join('')}
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

  refreshQueueBtn.onclick = loadSchedules;

  const syncBanner = document.getElementById('syncBanner');
  const syncBannerText = document.getElementById('syncBannerText');

  // 10. Connection Status & Pairing
  async function checkStatus() {
    try {
      const res = await fetch('/api/status');
      const data = await res.json();
      
      const isConn = data.status === 'connected';
      const isSyncing = Boolean(data.syncing);

      headerStatus.className = `status-indicator ${data.status}`;
      if (isConn) {
        if (isSyncing) {
          headerStatus.querySelector('.status-text').innerHTML = `Connected <span class="sync-spinner-inline"></span>`;
          if (syncBanner) {
            syncBanner.style.display = 'flex';
            if (syncBannerText) syncBannerText.textContent = `Syncing WhatsApp contacts & chats…`;
          }
        } else {
          headerStatus.querySelector('.status-text').textContent = 'Connected';
          if (syncBanner) syncBanner.style.display = 'none';
        }

        // Auto-close QR / Pairing modal when scanned & connected
        if (qrModal.classList.contains('active')) {
          qrModal.classList.remove('active');
          showToast('✓ WhatsApp Connected Successfully!');
          const schedTab = document.querySelector('.nav-item[data-tab="paneSchedule"]');
          if (schedTab) schedTab.click();
        }
      } else {
        if (syncBanner) syncBanner.style.display = 'none';
        headerStatus.querySelector('.status-text').textContent = data.status === 'qr' ? 'Scan QR' : 'Disconnected';
      }

      devicePill.textContent = `Status: ${data.status.toUpperCase()}`;
      devicePill.style.color = isConn ? 'var(--accent)' : 'var(--warning)';

      if (isConn && data.user) {
        deviceUserInfo.innerHTML = `Linked as: <strong>${data.user.name}</strong> (${data.user.id.split(':')[0]})`;
        logoutBox.style.display = 'block';
      } else {
        deviceUserInfo.textContent = 'Not linked to any WhatsApp account.';
        logoutBox.style.display = 'none';
      }

      return data;
    } catch (_) {
      headerStatus.className = 'status-indicator disconnected';
      headerStatus.querySelector('.status-text').textContent = 'Server Offline';
      if (syncBanner) syncBanner.style.display = 'none';
    }
  }

  checkStatus();
  // Poll faster (every 2.5 seconds) for snappy QR detection and sync feedback
  setInterval(checkStatus, 2500);

  // QR Modal
  showQrBtn.onclick = async () => {
    const data = await checkStatus();
    modalTitle.textContent = 'Scan QR Code';
    modalHelp.textContent = 'Open WhatsApp on your phone > Settings > Linked Devices > Link a Device';
    
    if (data?.qr) {
      modalBody.innerHTML = `
        <div class="qr-wrap">
          <img src="${data.qr}" alt="WhatsApp QR Code">
        </div>
        <p class="modal-help">${modalHelp.textContent}</p>
      `;
    } else if (data?.status === 'connected') {
      modalBody.innerHTML = `<p class="modal-help" style="color:var(--accent);font-weight:600;">✓ WhatsApp is already connected and ready!</p>`;
    } else {
      modalBody.innerHTML = `<p class="modal-help">Generating QR code, please wait a moment…</p>`;
    }
    qrModal.classList.add('active');
  };

  // 8-Digit Pairing Code Modal
  showPairCodeBtn.onclick = () => {
    modalTitle.textContent = 'Link via Phone Number';
    modalBody.innerHTML = `
      <div class="form-group" style="margin-bottom:14px;">
        <label>Your Phone Number (with Country Code)</label>
        <input type="text" id="pairPhoneInput" placeholder="+919876543210" style="margin-top:4px;">
      </div>
      <button type="button" class="btn-primary" id="requestPairBtn" style="margin-top:0;">
        Get 8-Digit Code
      </button>
      <div id="pairCodeResult" style="margin-top:14px;"></div>
      <p class="modal-help" style="margin-top:12px;">Open WhatsApp > Settings > Linked Devices > Link with phone number instead</p>
    `;

    document.getElementById('requestPairBtn').onclick = async () => {
      const phone = document.getElementById('pairPhoneInput').value.trim();
      if (!phone) return showToast('Enter phone number');
      const resultEl = document.getElementById('pairCodeResult');
      resultEl.innerHTML = '<span style="color:var(--text-secondary)">Generating pairing code…</span>';

      try {
        const res = await fetch('/api/pair-code', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ phoneNumber: phone })
        });
        const data = await res.json();
        if (data.code) {
          resultEl.innerHTML = `
            <div class="pair-code-display">${data.code}</div>
            <p style="text-align:center;font-size:12px;color:var(--text-secondary);">Enter this code on your WhatsApp phone notification.</p>
          `;
        } else {
          resultEl.innerHTML = `<span style="color:var(--danger)">${data.error || 'Failed to get code'}</span>`;
        }
      } catch (err) {
        resultEl.innerHTML = `<span style="color:var(--danger)">Error: ${err.message}</span>`;
      }
    };

    qrModal.classList.add('active');
  };

  modalClose.onclick = () => qrModal.classList.remove('active');
  qrModal.onclick = (e) => { if (e.target === qrModal) qrModal.classList.remove('active'); };

  logoutBtn.onclick = async () => {
    if (!confirm('Unlink this WhatsApp session?')) return;
    try {
      await fetch('/api/logout', { method: 'POST' });
      showToast('WhatsApp account unlinked');
      checkStatus();
    } catch (_) {}
  };
})();
