const $ = id => document.getElementById(id);
const ATTACHMENT_DB = 'waScheduler';
const ATTACHMENT_DB_VERSION = 1;
let selectedFiles = [];
let contacts = [];

const attachmentDbPromise = new Promise((resolve, reject) => {
  const request = indexedDB.open(ATTACHMENT_DB, ATTACHMENT_DB_VERSION);
  request.onupgradeneeded = () => {
    const db = request.result;
    if (!db.objectStoreNames.contains('attachments')) db.createObjectStore('attachments', { keyPath: 'id' });
  };
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(request.error);
});

async function storeAttachmentForSchedule(file) {
  const id = crypto.randomUUID();
  const db = await attachmentDbPromise;
  await new Promise((resolve, reject) => {
    const tx = db.transaction('attachments', 'readwrite');
    tx.objectStore('attachments').put({
      id,
      blob: file,
      name: file.name,
      type: file.type || 'application/octet-stream',
      size: file.size,
      lastModified: file.lastModified || 0,
      pending: true
    });
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
  return { id, name: file.name, type: file.type || 'application/octet-stream', size: file.size, lastModified: file.lastModified || 0 };
}

async function deleteStoredAttachment(id) {
  const db = await attachmentDbPromise;
  await new Promise((resolve, reject) => {
    const tx = db.transaction('attachments', 'readwrite');
    tx.objectStore('attachments').delete(id);
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
}

function notify(text, error = false) {
  $('notice').textContent = text;
  $('notice').style.color = error ? '#b42318' : '#287a3d';
}

function pad(n) { return String(n).padStart(2, '0'); }

function localDateTimeDefaults() {
  const d = new Date(Date.now() + 10 * 60 * 1000);
  $('date').value = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  $('time').value = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>'"]/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;'
  }[c]));
}

function renderContacts(filter = '') {
  const select = $('contactSelect');
  const wanted = filter.trim().toLowerCase();
  const current = $('contact').value.trim();
  const list = contacts.filter(c => !wanted || c.name.toLowerCase().includes(wanted));

  select.innerHTML = '<option value="">Choose a WhatsApp contact…</option>';
  for (const c of list) {
    const option = document.createElement('option');
    option.value = c.name;
    option.textContent = c.name;
    if (c.name === current) option.selected = true;
    select.appendChild(option);
  }
}

async function getStatus() {
  const r = await chrome.runtime.sendMessage({ type: 'GET_STATUS' });
  if (!r?.whatsappOpen) {
    $('waStatus').textContent = 'Open WhatsApp Web first';
    $('waStatus').className = 'bad';
    return r;
  }
  $('waStatus').textContent = r.connected ? 'WhatsApp Web connected' : 'Connecting to WhatsApp Web…';
  $('waStatus').className = r.connected ? 'good' : 'warn-text';
  return r;
}

async function loadCurrent() {
  const r = await chrome.runtime.sendMessage({ type: 'GET_CURRENT_CHAT' });
  if (r?.success && r.name) {
    $('currentChat').textContent = r.name;
    $('contact').value = r.name;
    renderContacts($('contactSearch').value);
  } else {
    $('currentChat').textContent = 'No chat open';
  }
  return r;
}

async function loadContacts() {
  const r = await chrome.runtime.sendMessage({ type: 'GET_CONTACTS' });
  if (!r?.success) {
    notify(r?.error || 'Could not load WhatsApp contacts.', true);
    return;
  }
  contacts = r.contacts || [];
  renderContacts($('contactSearch').value);
  if (r.current?.name) {
    $('currentChat').textContent = r.current.name;
    if (!$('contact').value) $('contact').value = r.current.name;
  }
}

$('refresh').onclick = async () => {
  notify('Refreshing…');
  await getStatus();
  await loadCurrent();
  await loadContacts();
  notify('WhatsApp contact list refreshed.');
};

$('useCurrent').onclick = async () => {
  const r = await loadCurrent();
  if (!r?.success || !r.name) return notify('Open a WhatsApp chat first.', true);
  $('contact').value = r.name;
  renderContacts($('contactSearch').value);
  notify(`Selected “${r.name}”.`);
};

$('contactSelect').onchange = async () => {
  const name = $('contactSelect').value;
  if (!name) return;
  $('contact').value = name;
  notify(`Selected “${name}”. Click Open if you want WhatsApp to switch to this chat.`);
};

$('contactSearch').oninput = () => renderContacts($('contactSearch').value);

$('openSelected').onclick = async () => {
  const name = $('contact').value.trim();
  if (!name) return notify('Choose a contact first.', true);
  notify(`Searching WhatsApp for ${name}…`);
  const r = await chrome.runtime.sendMessage({ type: 'OPEN_CONTACT', name });
  if (!r?.success) return notify(r?.error || 'Could not open chat.', true);
  $('currentChat').textContent = r.current?.name || name;
  notify(`Opened “${r.current?.name || name}”.`);
};

$('files').onchange = () => {
  selectedFiles = [...$('files').files];
  $('fileList').innerHTML = selectedFiles.map(f =>
    `<div class="file">📎 ${escapeHtml(f.name)} — ${(f.size / 1024 / 1024).toFixed(2)} MB</div>`
  ).join('');
};

$('schedule').onclick = async () => {
  const contact = $('contact').value.trim();
  const text = $('text').value;
  const date = $('date').value;
  const time = $('time').value;

  if (!contact) return notify('Choose or enter a recipient.', true);
  if (!text && !selectedFiles.length) return notify('Add a message or attachment.', true);
  if (!date || !time) return notify('Choose date and time.', true);

  const scheduledAt = new Date(`${date}T${time}`).getTime();
  if (!Number.isFinite(scheduledAt) || scheduledAt <= Date.now()) return notify('Choose a future time.', true);

  notify('Saving exact file bytes…');
  const attachments = [];
  const storedIds = [];
  try {
    for (const f of selectedFiles) {
      const meta = await storeAttachmentForSchedule(f);
      attachments.push(meta);
      storedIds.push(meta.id);
    }
  } catch (error) {
    for (const id of storedIds) { try { await deleteStoredAttachment(id); } catch (_) {} }
    return notify(error?.message || 'Could not store the attachment.', true);
  }

  const r = await chrome.runtime.sendMessage({
    type: 'CREATE_SCHEDULE',
    payload: { contact: { name: contact }, text, scheduledAt, attachments }
  });

  if (!r?.success) {
    for (const id of storedIds) { try { await deleteStoredAttachment(id); } catch (_) {} }
    return notify(r?.error || 'Could not schedule.', true);
  }

  notify(`Scheduled for ${new Date(scheduledAt).toLocaleString()}.`);
  $('text').value = '';
  $('files').value = '';
  selectedFiles = [];
  $('fileList').innerHTML = '';
  await render();
};

function formatStage(stage) {
  const labels = {
    'whatsapp-tab': 'WhatsApp Web',
    'open-contact': 'Opening contact',
    'find-composer': 'Finding message box',
    'type-message': 'Typing message',
    'type-caption': 'Adding attachment caption',
    'attach-files': 'Uploading attachment',
    'send-message': 'Sending message',
    'content-script': 'WhatsApp automation',
    'scheduler': 'Scheduler'
  };
  return labels[stage] || stage || 'Unknown stage';
}

async function render() {
  const r = await chrome.runtime.sendMessage({ type: 'LIST_MESSAGES' });
  const messages = (r.messages || []).sort((a, b) => a.scheduledAt - b.scheduledAt);
  $('messages').innerHTML = messages.length ? messages.map(m => {
    const badge = m.status === 'sent' ? 'success' : m.status === 'failed' ? 'danger' : m.status === 'retrying' ? 'warn' : '';
    return `<div class="msg">
      <div class="msgtop"><strong>${escapeHtml(m.contact.name)}</strong><span class="badge ${badge}">${escapeHtml(m.status)}</span></div>
      <div class="status">${new Date(m.scheduledAt).toLocaleString()} · ${m.attachments?.length || 0} attachment(s)</div>
      <div class="msgtext">${escapeHtml(m.text || '(attachment only)')}</div>
      ${m.error ? `
        <div class="errorbox">
          <div class="errorhead">
            <span>⚠ Last error</span>
            <span class="errorstage">${escapeHtml(formatStage(m.errorStage))}</span>
          </div>
          <div class="errortext">${escapeHtml(m.error)}</div>
          ${m.status === 'retrying' && m.nextRetryAt ? `<div class="retryinfo">Next retry: ${escapeHtml(new Date(m.nextRetryAt).toLocaleTimeString())}</div>` : ''}
          ${m.attempts ? `<div class="retryinfo">Attempt ${escapeHtml(String(m.attempts))}</div>` : ''}
        </div>` : ''}
      <div class="actions">
        ${['scheduled', 'retrying'].includes(m.status) ? `<button data-cancel="${m.id}">Cancel</button>` : ''}
        <button data-delete="${m.id}">Delete</button>
      </div>
    </div>`;
  }).join('') : '<div class="empty">No scheduled messages.</div>';

  document.querySelectorAll('[data-cancel]').forEach(b => b.onclick = async () => {
    await chrome.runtime.sendMessage({ type: 'CANCEL_MESSAGE', id: b.dataset.cancel });
    render();
  });
  document.querySelectorAll('[data-delete]').forEach(b => b.onclick = async () => {
    await chrome.runtime.sendMessage({ type: 'DELETE_MESSAGE', id: b.dataset.delete });
    render();
  });
}

$('openDebug').onclick = () => chrome.tabs.create({ url: chrome.runtime.getURL('debug.html') });
$('openOptions').onclick = () => chrome.runtime.openOptionsPage();

(async () => {
  localDateTimeDefaults();
  await getStatus();
  await loadCurrent();
  await loadContacts();
  await render();
})();
