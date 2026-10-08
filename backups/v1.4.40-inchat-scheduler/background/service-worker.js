const CONTENT_SCRIPT_VERSION = '1.4.39';
const ALARM_PREFIX = 'wa-schedule:';
const RETRY_PREFIX = 'wa-retry:';
const RETRY_LIMIT = 2;
const RETRY_MINUTES = 2;
const CHUNK_SIZE = 200 * 1024;

// All WhatsApp sends are serialized per WhatsApp tab. Chrome alarms that share
// the exact same timestamp can fire together; without this queue they would
// race the same composer and attachment picker. The queue is intentionally
// in-memory because the actual schedule remains persisted in chrome.storage.
const tabSendQueues = new Map();
const processingIds = new Set();
const stagingChunks = new Map();
const PROCESSING_LEASE_MS = 5 * 60 * 1000;

function enqueueTabSend(tabId, task) {
  const previous = tabSendQueues.get(tabId) || Promise.resolve();
  const current = previous.catch(() => {}).then(task);
  tabSendQueues.set(tabId, current);
  current.finally(() => {
    if (tabSendQueues.get(tabId) === current) tabSendQueues.delete(tabId);
  }).catch(() => {});
  return current;
}

async function sha256Hex(input) {
  let buffer;
  if (input instanceof Blob) {
    buffer = await input.arrayBuffer();
  } else if (input instanceof ArrayBuffer) {
    buffer = input;
  } else if (ArrayBuffer.isView(input)) {
    buffer = input.buffer.slice(input.byteOffset, input.byteOffset + input.byteLength);
  } else {
    throw new TypeError('Invalid input for sha256Hex');
  }
  const digest = await crypto.subtle.digest('SHA-256', buffer);
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('');
}

let dbPromise = null;
function getDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    try {
      const request = indexedDB.open('waScheduler', 1);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains('attachments')) db.createObjectStore('attachments', { keyPath: 'id' });
      };
      request.onsuccess = () => {
        const db = request.result;
        db.onversionchange = () => { try { db.close(); } catch (_) {} dbPromise = null; };
        db.onclose = () => { dbPromise = null; };
        resolve(db);
      };
      request.onerror = () => {
        dbPromise = null;
        reject(request.error || new Error('Failed to open IndexedDB'));
      };
      request.onblocked = () => {
        dbPromise = null;
        reject(new Error('IndexedDB open blocked'));
      };
    } catch (e) {
      dbPromise = null;
      reject(e);
    }
  });
  return dbPromise;
}

async function getMessages() {
  const { messages = [] } = await chrome.storage.local.get('messages');
  return messages;
}

async function setMessages(messages) {
  await chrome.storage.local.set({ messages });
}

async function getMessage(id) {
  return (await getMessages()).find(m => m.id === id) || null;
}

async function updateMessage(id, patch) {
  const messages = await getMessages();
  const i = messages.findIndex(m => m.id === id);
  if (i < 0) return null;
  messages[i] = { ...messages[i], ...patch, updatedAt: Date.now() };
  await setMessages(messages);
  return messages[i];
}

function alarmName(id) { return ALARM_PREFIX + id; }
function retryAlarmName(id) { return RETRY_PREFIX + id; }

async function putAttachment(id, blob, name, type, size, hash = null, lastModified = 0, pending = false) {
  const db = await getDb();
  let buffer = null;
  if (blob instanceof Blob) {
    try { buffer = await blob.arrayBuffer(); } catch (_) {}
  } else if (blob instanceof ArrayBuffer) {
    buffer = blob;
    blob = new Blob([buffer], { type: type || 'application/octet-stream' });
  } else if (ArrayBuffer.isView(blob)) {
    buffer = blob.buffer.slice(blob.byteOffset, blob.byteOffset + blob.byteLength);
    blob = new Blob([buffer], { type: type || 'application/octet-stream' });
  }
  return new Promise((resolve, reject) => {
    try {
      const tx = db.transaction('attachments', 'readwrite');
      const store = tx.objectStore('attachments');
      store.put({ id, blob, buffer, name, type, size, hash, lastModified, pending });
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error || new Error('IndexedDB put error'));
      tx.onabort = () => reject(tx.error || new Error('Transaction aborted'));
    } catch (err) {
      reject(err);
    }
  });
}

async function getAttachment(id) {
  const db = await getDb();
  return new Promise((resolve, reject) => {
    try {
      const tx = db.transaction('attachments', 'readonly');
      const req = tx.objectStore('attachments').get(id);
      req.onsuccess = () => {
        const item = req.result;
        if (item) {
          if (!item.blob && item.buffer) {
            item.blob = new Blob([item.buffer], { type: item.type || 'application/octet-stream' });
          } else if (item.blob && !(item.blob instanceof Blob)) {
            item.blob = new Blob([item.blob], { type: item.type || 'application/octet-stream' });
          }
        }
        resolve(item || null);
      };
      req.onerror = () => reject(req.error);
      tx.onerror = () => reject(tx.error);
    } catch (err) {
      reject(err);
    }
  });
}

async function deleteAttachment(id) {
  const db = await getDb();
  return new Promise((resolve, reject) => {
    try {
      const tx = db.transaction('attachments', 'readwrite');
      const req = tx.objectStore('attachments').delete(id);
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
      tx.onerror = () => reject(tx.error);
    } catch (err) {
      reject(err);
    }
  });
}

async function createSchedule(payload) {
  const id = crypto.randomUUID();
  const attachments = [];
  const committed = [];

  try {
    for (const file of payload.attachments || []) {
      if (!file?.id) throw new Error(`Attachment reference missing for ${file?.name || 'unnamed file'}.`);
      const staged = await getAttachment(file.id);
      if (!staged?.blob && !staged?.buffer) throw new Error(`Staged attachment not found for ${file.name || file.id}.`);

      const canonicalType = file.type || staged.type || 'application/octet-stream';
      const size = Number.isFinite(file.size) ? file.size : (staged.size || staged.blob?.size || staged.buffer?.byteLength || 0);
      const hash = staged.hash || file.hash || (staged.buffer ? await sha256Hex(staged.buffer) : await sha256Hex(staged.blob));

      // Mark the attachment record as committed / no longer pending
      await putAttachment(file.id, staged.blob || staged.buffer, file.name, canonicalType, size, hash, file.lastModified || staged.lastModified || 0, false);
      attachments.push({ id: file.id, name: file.name, type: canonicalType, size, hash, lastModified: file.lastModified || staged.lastModified || 0 });
      committed.push(file.id);
    }

    const message = {
      id,
      contact: payload.contact,
      text: payload.text ?? '',
      attachments,
      scheduledAt: payload.scheduledAt,
      status: 'scheduled',
      attempts: 0,
      createdAt: Date.now(),
      updatedAt: Date.now()
    };

    const messages = await getMessages();
    messages.push(message);
    await setMessages(messages);
    await chrome.alarms.create(alarmName(id), { when: message.scheduledAt });

    return message;
  } catch (error) {
    for (const attachmentId of committed) { try { await deleteAttachment(attachmentId); } catch (_) {} }
    throw error;
  }
}


async function restoreAlarms() {
  const messages = await getMessages();
  const now = Date.now();
  for (const message of messages) {
    if (message.status === 'processing') {
      // Recover a job left behind by a service-worker/browser restart. Do not
      // immediately duplicate a possibly active send; only reclaim an expired
      // processing lease.
      if ((message.processingLeaseUntil || 0) <= now) {
        await updateMessage(message.id, { status: 'scheduled', error: 'Recovered after scheduler restart.', errorStage: 'scheduler', processingLeaseUntil: null });
      } else {
        continue;
      }
    }
    const current = await getMessage(message.id);
    if (!current || !['scheduled', 'retrying'].includes(current.status)) continue;
    if (current.scheduledAt <= now) await processMessage(current.id);
    else {
      await chrome.alarms.create(alarmName(current.id), { when: current.scheduledAt });
    }
  }
}


async function findWhatsAppTab() {
  const tabs = await chrome.tabs.query({ url: 'https://web.whatsapp.com/*' });
  return tabs.find(t => t.status === 'complete') || tabs[0] || null;
}

async function waitForContentScript(tabId, timeout = 12000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    try {
      const ping = await chrome.tabs.sendMessage(tabId, { type: 'PING' });
      if (ping?.ready && ping.version === CONTENT_SCRIPT_VERSION) return true;
    } catch (_) {}
    await new Promise(r => setTimeout(r, 300));
  }
  return false;
}

async function ensureContentScript(tabId) {
  try {
    const ping = await chrome.tabs.sendMessage(tabId, { type: 'PING' });
    if (ping?.ready && ping.version === CONTENT_SCRIPT_VERSION) return true;
    if (ping?.ready && ping.version !== CONTENT_SCRIPT_VERSION) {
      // Never stack a new listener on an old WhatsApp content script. Reloading
      // installs exactly one copy from the manifest and prevents duplicate sends.
      await chrome.tabs.reload(tabId);
      if (await waitForContentScript(tabId)) return true;
      throw new Error(`WhatsApp Scheduler ${CONTENT_SCRIPT_VERSION} did not initialize after reload.`);
    }
  } catch (error) {
    if (/did not initialize after reload/i.test(error?.message || '')) throw error;
  }

  // No content-script listener exists (for example, WhatsApp was already open
  // before the extension was installed). A one-time injection is safe here.
  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: ['content/whatsapp.js'] });
  } catch (_) {}
  if (await waitForContentScript(tabId)) return true;
  throw new Error(`WhatsApp Scheduler ${CONTENT_SCRIPT_VERSION} is not ready.`);
}

async function sendToTab(tabId, message) {
  await ensureContentScript(tabId);
  return chrome.tabs.sendMessage(tabId, message);
}

async function processMessage(id) {
  if (processingIds.has(id)) return;
  const initial = await getMessage(id);
  if (!initial || !['scheduled', 'retrying'].includes(initial.status)) return;

  const tab = await findWhatsAppTab();
  if (!tab) return retry(id, 'WhatsApp Web is not open.', 'whatsapp-tab');

  return enqueueTabSend(tab.id, async () => {
    if (processingIds.has(id)) return;
    const message = await getMessage(id);
    if (!message || !['scheduled', 'retrying'].includes(message.status)) return;

    processingIds.add(id);
    const attempt = (message.attempts || 0) + 1;
    await updateMessage(id, {
      status: 'processing',
      attempts: attempt,
      error: null,
      errorStage: null,
      lastAttemptAt: Date.now(),
      nextRetryAt: null,
      processingLeaseUntil: Date.now() + PROCESSING_LEASE_MS
    });

    try {
      // Ensure the tab has exactly the current content-script version before
      // starting this serialized job. This also forces an old injected script
      // out of the way after an extension update.
      const result = await sendToTab(tab.id, {
        type: 'SEND_SCHEDULED_MESSAGE',
        payload: {
          id: message.id,
          contact: message.contact,
          text: message.text,
          attachments: message.attachments
        }
      });

      if (!result?.success) {
        const err = new Error(result?.error || 'WhatsApp automation failed.');
        err.stage = result?.stage || 'whatsapp-automation';
        err.noRetry = !!result?.noRetry;
        throw err;
      }
      await updateMessage(id, {
        status: 'sent',
        sentAt: Date.now(),
        error: null,
        errorStage: null,
        nextRetryAt: null,
        processingLeaseUntil: null
      });
      // Clean up attachment blobs now that the message is sent
      for (const a of message.attachments || []) {
        try { await deleteAttachment(a.id); } catch (_) {}
      }
    } catch (error) {
      const isSendStage = (error?.stage || error?.errorStage) === 'send-message';
      if (error?.noRetry || isSendStage) {
        await updateMessage(id, {
          status: 'failed',
          error: error.message || String(error),
          errorStage: error.stage || 'send-message',
          nextRetryAt: null,
          lastErrorAt: Date.now(),
          processingLeaseUntil: null
        });
      } else {
        await retry(id, error?.message || String(error), error?.stage || 'scheduler');
      }
    } finally {
      processingIds.delete(id);
    }
  });
}


async function retry(id, error, stage = 'scheduler') {
  const message = await getMessage(id);
  if (!message || message.status === 'sent' || message.status === 'cancelled') return;
  // If the send button was already interacted with, never retry automatically to prevent duplicate sending.
  if (stage === 'send-message') {
    await updateMessage(id, { status: 'failed', error, errorStage: stage, nextRetryAt: null, lastErrorAt: Date.now(), processingLeaseUntil: null });
    return;
  }
  const attempts = message.attempts || 0;
  if (attempts >= RETRY_LIMIT) {
    await updateMessage(id, { status: 'failed', error, errorStage: stage, nextRetryAt: null, lastErrorAt: Date.now(), processingLeaseUntil: null });
    return;
  }
  const nextRetryAt = Date.now() + RETRY_MINUTES * 60 * 1000;
  await updateMessage(id, { status: 'retrying', error, errorStage: stage, lastErrorAt: Date.now(), nextRetryAt, processingLeaseUntil: null });
  await chrome.alarms.create(retryAlarmName(id), { delayInMinutes: RETRY_MINUTES });
}

chrome.runtime.onInstalled.addListener(() => restoreAlarms());
chrome.runtime.onStartup.addListener(() => restoreAlarms());

chrome.alarms.onAlarm.addListener(async alarm => {
  if (alarm.name.startsWith(ALARM_PREFIX)) return processMessage(alarm.name.slice(ALARM_PREFIX.length));
  if (alarm.name.startsWith(RETRY_PREFIX)) return processMessage(alarm.name.slice(RETRY_PREFIX.length));
});

const DEBUG_LIMIT = 300;

async function addDebugLog(entry) {
  const { debugLogs = [] } = await chrome.storage.local.get('debugLogs');
  debugLogs.push(entry);
  while (debugLogs.length > DEBUG_LIMIT) debugLogs.shift();
  await chrome.storage.local.set({ debugLogs });
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  (async () => {
    try {
      if (message.type === 'DEBUG_LOG') {
        await addDebugLog(message.entry || { message: 'unknown', time: new Date().toISOString() });
        sendResponse({ success: true });
      } else if (message.type === 'GET_DIAGNOSTICS' || message.type === 'GET_DEBUG') {
        const tab = await findWhatsAppTab();
        let page = null;
        if (tab) {
          try {
            await ensureContentScript(tab.id);
            page = await chrome.tabs.sendMessage(tab.id, { type: 'DIAGNOSTICS' });
          } catch (e) {
            page = { success: false, error: e?.message || String(e) };
          }
        }
        const { debugLogs = [] } = await chrome.storage.local.get('debugLogs');
        const messages = await getMessages();
        sendResponse({ success: true, tab: tab ? { id: tab.id, url: tab.url, title: tab.title } : null, page, messages, logs: debugLogs });
      } else if (message.type === 'CLEAR_DEBUG_LOGS' || message.type === 'CLEAR_DEBUG') {
        await chrome.storage.local.set({ debugLogs: [] });
        sendResponse({ success: true });
      } else if (message.type === 'CREATE_SCHEDULE') {
        const created = await createSchedule(message.payload);
        sendResponse({ success: true, message: created });
      } else if (message.type === 'LIST_MESSAGES') {
        sendResponse({ success: true, messages: await getMessages() });
      } else if (message.type === 'CANCEL_MESSAGE') {
        const current = await getMessage(message.id);
        await chrome.alarms.clear(alarmName(message.id));
        await chrome.alarms.clear(retryAlarmName(message.id));
        if (current) {
          await updateMessage(message.id, { status: 'cancelled' });
          for (const a of current.attachments || []) await deleteAttachment(a.id);
        }
        sendResponse({ success: true });
      } else if (message.type === 'DELETE_MESSAGE') {
        const current = await getMessage(message.id);
        await chrome.alarms.clear(alarmName(message.id));
        await chrome.alarms.clear(retryAlarmName(message.id));
        if (current) for (const a of current.attachments || []) await deleteAttachment(a.id);
        await setMessages((await getMessages()).filter(m => m.id !== message.id));
        sendResponse({ success: true });
      } else if (message.type === 'GET_ATTACHMENT_CHUNK') {
        const item = await getAttachment(message.attachmentId);
        if (!item) throw new Error('Attachment not found.');
        const buffer = await item.blob.arrayBuffer();
        const start = message.offset || 0;
        const end = Math.min(start + CHUNK_SIZE, buffer.byteLength);
        const bytes = new Uint8Array(buffer.slice(start, end));
        let binary = '';
        const STEP = 0x8000;
        for (let i = 0; i < bytes.length; i += STEP) {
          binary += String.fromCharCode(...bytes.subarray(i, Math.min(i + STEP, bytes.length)));
        }
        sendResponse({
          success: true,
          attachmentId: message.attachmentId,
          name: item.name,
          type: item.type,
          size: item.size,
          hash: item.hash || null,
          lastModified: item.lastModified || 0,
          offset: start,
          done: end >= buffer.byteLength,
          chunkBase64: btoa(binary)
        });
      } else if (message.type === 'STAGE_ATTACHMENT') {
        const { id, name, fileType, mimeType, type, size, lastModified, base64 } = message;
        const canonicalType = fileType || mimeType || (type !== 'STAGE_ATTACHMENT' ? type : '') || 'application/octet-stream';
        const binary = atob(base64 || '');
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
        const hash = await sha256Hex(bytes);
        await putAttachment(id, bytes.buffer, name, canonicalType, bytes.byteLength, hash, lastModified || 0, true);
        sendResponse({ success: true, id, size: bytes.byteLength, hash });
      } else if (message.type === 'STAGE_ATTACHMENT_CHUNK') {
        const { id, name, fileType, mimeType, type, size, lastModified, offset, chunkBase64, done } = message;
        const canonicalType = fileType || mimeType || (type !== 'STAGE_ATTACHMENT_CHUNK' ? type : '') || 'application/octet-stream';
        let entry = stagingChunks.get(id);
        if (!entry) {
          entry = { name, type: canonicalType, size, lastModified, chunks: [] };
          stagingChunks.set(id, entry);
        }
        if (chunkBase64) {
          const binary = atob(chunkBase64);
          const bytes = new Uint8Array(binary.length);
          for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
          entry.chunks.push(bytes);
        }
        if (done) {
          stagingChunks.delete(id);
          const totalBlob = new Blob(entry.chunks, { type: entry.type || 'application/octet-stream' });
          const hash = await sha256Hex(totalBlob);
          await putAttachment(id, totalBlob, entry.name, entry.type, totalBlob.size, hash, entry.lastModified || 0, true);
          sendResponse({ success: true, id, size: totalBlob.size, hash });
        } else {
          sendResponse({ success: true, id, offset });
        }
      } else if (message.type === 'DELETE_ATTACHMENT') {
        await deleteAttachment(message.id);
        sendResponse({ success: true });
      } else if (message.type === 'GET_STATUS') {
        const tab = await findWhatsAppTab();
        if (!tab) return sendResponse({ success: true, whatsappOpen: false, connected: false, tabId: null });
        let connected = false;
        try { connected = !!(await ensureContentScript(tab.id)); } catch (_) {}
        sendResponse({ success: true, whatsappOpen: true, connected, tabId: tab.id });
      } else if (message.type === 'GET_CONTACTS') {
        const tab = await findWhatsAppTab();
        if (!tab) return sendResponse({ success: false, error: 'Open WhatsApp Web first.' });
        await ensureContentScript(tab.id);
        const result = await chrome.tabs.sendMessage(tab.id, { type: 'GET_CONTACTS' });
        sendResponse({ success: true, ...result });
      } else if (message.type === 'GET_CURRENT_CHAT') {
        const tab = await findWhatsAppTab();
        if (!tab) return sendResponse({ success: false, error: 'Open WhatsApp Web first.' });
        await ensureContentScript(tab.id);
        const result = await chrome.tabs.sendMessage(tab.id, { type: 'GET_CURRENT_CHAT' });
        sendResponse({ success: true, ...result });
      } else if (message.type === 'OPEN_CONTACT') {
        const tab = await findWhatsAppTab();
        if (!tab) return sendResponse({ success: false, error: 'Open WhatsApp Web first.' });
        await ensureContentScript(tab.id);
        const result = await chrome.tabs.sendMessage(tab.id, { type: 'OPEN_CONTACT', name: message.name });
        sendResponse({ success: true, ...result });
      } else {
        sendResponse({ success: false, error: `Unhandled message type: ${message?.type}` });
      }
    } catch (error) {
      sendResponse({ success: false, error: error?.message || String(error) });
    }
  })();
  return true;
});
