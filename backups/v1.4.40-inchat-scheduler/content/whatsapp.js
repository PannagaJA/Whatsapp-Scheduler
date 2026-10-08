(() => {
  const EXTENSION_VERSION = '1.4.39';
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  let activeSend = false;
  let sendQueue = Promise.resolve();
  let currentJobSendPressed = false;
  let currentJobDropAttempted = false;
  let attachmentsAssigned = false;

  function visible(el) {
    if (!el) return false;
    const r = el.getBoundingClientRect();
    const s = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && s.display !== 'none' && s.visibility !== 'hidden';
  }

  function clean(s) {
    return String(s ?? '').replace(/\s+/g, ' ').trim();
  }

  function exactText(s) {
    return String(s ?? '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  }

  function escapeHtml(s) {
    return String(s ?? '').replace(/[&<>'"]/g, c => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;'
    }[c]));
  }

  const GENERIC_LABELS = new Set([
    'search', 'menu', 'more', 'back', 'close', 'attach', 'send',
    'search messages', 'video call', 'voice call', 'conversation info', 'profile details', 'contact info',
    'click here for contact info', 'starred messages', 'add to favorites'
  ]);

  function debugLog(message, data) {
    try {
      console.log('[WA Scheduler]', message, data != null ? JSON.stringify(data) : '');
      chrome.runtime.sendMessage({
        type: 'DEBUG_LOG',
        entry: {
          message,
          data: data ?? null,
          url: location.href,
          time: new Date().toISOString()
        }
      }).catch(() => {});
    } catch (_) {}
  }

  function captureAttachUiDump(attachButton) {
    try {
      const btnRect = attachButton ? attachButton.getBoundingClientRect() : { left: 0, top: window.innerHeight - 80, right: 100, bottom: window.innerHeight };
      const minX = Math.max(0, btnRect.left - 50);
      const maxX = Math.min(window.innerWidth, btnRect.left + 450);
      const minY = Math.max(0, btnRect.top - 450);
      const maxY = Math.min(window.innerHeight, btnRect.bottom + 50);

      const allElements = [...document.querySelectorAll('*')].filter(visible);
      const nearby = [];
      for (const el of allElements) {
        if (el.tagName === 'BODY' || el.tagName === 'HTML' || el.id === 'app') continue;
        const r = el.getBoundingClientRect();
        if (r.width === 0 || r.height === 0) continue;
        if (r.right >= minX && r.left <= maxX && r.bottom >= minY && r.top <= maxY) {
          const text = clean(el.innerText || el.textContent || '').slice(0, 40);
          nearby.push({
            tag: el.tagName.toLowerCase(),
            role: el.getAttribute('role') || undefined,
            ariaLabel: el.getAttribute('aria-label') || undefined,
            testid: el.getAttribute('data-testid') || undefined,
            text: text || undefined,
            left: Math.round(r.left),
            top: Math.round(r.top),
            w: Math.round(r.width),
            h: Math.round(r.height)
          });
          if (nearby.length >= 40) break;
        }
      }

      const fileInputs = [...document.querySelectorAll('input[type="file"]')].map(inp => ({
        accept: inp.accept,
        multiple: inp.multiple,
        connected: inp.isConnected,
        hidden: inp.hidden || inp.style.display === 'none' || inp.style.visibility === 'hidden',
        parentTag: inp.parentElement ? inp.parentElement.tagName.toLowerCase() : null,
        outerHTML: (inp.outerHTML || '').slice(0, 200)
      }));

      return { nearbyElements: nearby, fileInputs };
    } catch (err) {
      return { error: String(err && err.message || err) };
    }
  }

  function getHeaderTitle() {
    const main = document.querySelector('#main');
    const header = main?.querySelector('header');
    if (!header || !visible(header)) return '';

    // IMPORTANT: prefer actual title attributes. WhatsApp uses many span[dir=auto]
    // nodes for secondary text such as "Message yourself" and "(You)".
    const titleCandidates = [...header.querySelectorAll('span[title], [title]')]
      .map(el => clean(el.getAttribute('title')))
      .filter(Boolean)
      .filter(v => !GENERIC_LABELS.has(v.toLowerCase()))
      .filter(v => v.toLowerCase() !== 'message yourself')
      .filter(v => v.toLowerCase() !== '(you)');

    // Prefer the longest meaningful title; this prevents "(You)" or status text
    // from winning over "+91 97414 05534 (You)" / a real contact name.
    if (titleCandidates.length) {
      const sorted = [...new Set(titleCandidates)].sort((a, b) => b.length - a.length);
      return sorted[0];
    }

    // Newer WhatsApp builds may expose aria-labels on the header button.
    const ariaCandidates = [...header.querySelectorAll('[aria-label]')]
      .map(el => clean(el.getAttribute('aria-label')))
      .filter(Boolean)
      .filter(v => !GENERIC_LABELS.has(v.toLowerCase()))
      .filter(v => !/^message yourself$/i.test(v))
      .filter(v => !/^\(you\)$/i.test(v));
    if (ariaCandidates.length) {
      const sorted = [...new Set(ariaCandidates)].sort((a, b) => b.length - a.length);
      return sorted[0];
    }

    // Last fallback: inspect visible header lines, but ignore secondary/status lines.
    const lines = (header.innerText || '')
      .split('\n')
      .map(clean)
      .filter(Boolean)
      .filter(value => !GENERIC_LABELS.has(value.toLowerCase()))
      .filter(value => !/^message yourself$/i.test(value))
      .filter(value => !/^\(you\)$/i.test(value));

    return lines[0] || '';
  }

  function getCurrentChat() {
    const name = getHeaderTitle();
    const isChatOpen = !!document.querySelector('#main header') && !!name;
    debugLog('GET_CURRENT_CHAT', { name, isChatOpen });
    return {
      name,
      isChatOpen
    };
  }

  function getChatRows() {
    const roots = [
      '#pane-side [role="listitem"]',
      '#pane-side [role="row"]',
      '#pane-side [aria-label][role="button"]',
      '#pane-side div[tabindex="-1"]',
      '#side [role="listitem"]',
      '#side [role="row"]',
      '#side [aria-label][role="button"]',
      '#side div[tabindex="-1"]'
    ];

    const rows = [];
    const seen = new Set();

    for (const selector of roots) {
      for (const row of document.querySelectorAll(selector)) {
        if (!visible(row) || seen.has(row)) continue;
        seen.add(row);
        rows.push(row);
      }
    }
    return rows;
  }

  function getContacts() {
    const result = [];
    const seen = new Set();

    for (const row of getChatRows()) {
      const name = extractRowContactName(row);
      if (!name || name.length > 120 || GENERIC_LABELS.has(name.toLowerCase())) continue;
      const key = name.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      result.push({ name });
    }

    return result.slice(0, 200);
  }

  function findSearchBox() {
    // Prefer WhatsApp's actual left-sidebar recipient search. Do not require
    // #side/#pane-side to exist because recent builds can temporarily omit it.
    const selectors = [
      '#side input[placeholder="Search or start a new chat"]',
      '#pane-side input[placeholder="Search or start a new chat"]',
      'input[placeholder="Search or start a new chat"]',
      'input[placeholder*="Search or start a new chat" i]',
      'input[aria-label*="Search or start a new chat" i]',
      '#side input[placeholder*="Search" i]',
      '#pane-side input[placeholder*="Search" i]'
    ];
    for (const selector of selectors) {
      const el = [...document.querySelectorAll(selector)].find(visible);
      if (el && !/search messages/i.test(clean(`${el.getAttribute('aria-label')||''} ${el.getAttribute('placeholder')||''}`))) return el;
    }

    // Fallback for contenteditable/search textbox implementations.
    const candidates = [...document.querySelectorAll('[contenteditable="true"],[contenteditable="plaintext-only"],[role="textbox"]')]
      .filter(visible)
      .filter(el => !document.querySelector('#main')?.contains(el))
      .filter(el => /search|new chat/i.test(clean(`${el.getAttribute('aria-label')||''} ${el.getAttribute('data-placeholder')||''} ${el.getAttribute('placeholder')||''}`)));
    return candidates[0] || null;
  }


  const norm = s => String(s ?? '')
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    .replace(/\u00A0/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  const readEditor = el =>
    (el instanceof HTMLTextAreaElement || el instanceof HTMLInputElement)
      ? el.value
      : (el.innerText || el.textContent || '');

  async function waitUntil(fn, timeout = 2000, step = 50) {
    const end = Date.now() + timeout;
    while (Date.now() < end) {
      try { const v = fn(); if (v) return v; } catch (_) {}
      await sleep(step);
    }
    return null;
  }

  function selectAllIn(el) {
    el.focus();
    const sel = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(el);
    sel.removeAllRanges();
    sel.addRange(range);
  }

  async function clearEditor(el) {
    if (!el) return true;
    for (let i = 0; i < 4; i++) {
      if (!norm(readEditor(el))) return true;
      selectAllIn(el);
      try { document.execCommand('delete', false); } catch (_) {}
      if (await waitUntil(() => !norm(readEditor(el)), 800)) return true;
      try {
        el.dispatchEvent(new InputEvent('beforeinput', {
          inputType: 'deleteContentBackward', bubbles: true, cancelable: true, composed: true }));
      } catch (_) {}
      if (await waitUntil(() => !norm(readEditor(el)), 600)) return true;
    }
    return !norm(readEditor(el));
  }

  function pasteText(el, text) {
    el.focus();
    const dt = new DataTransfer();
    dt.setData('text/plain', text);
    el.dispatchEvent(new ClipboardEvent('paste',
      { clipboardData: dt, bubbles: true, cancelable: true, composed: true }));
  }

  function execInsert(el, text) {
    el.focus();
    const lines = text.split('\n');
    lines.forEach((line, i) => {
      if (line) document.execCommand('insertText', false, line);
      if (i < lines.length - 1) document.execCommand('insertLineBreak', false);
    });
  }

  async function setEditorText(el, rawText) {
    const text = String(rawText ?? '').replace(/\r\n?/g, '\n').trim();
    const expected = norm(text);
    if (!expected) return true;
    const strategies = [
      ['paste',       () => { selectAllIn(el); pasteText(el, text); }],
      ['execCommand', () => { selectAllIn(el); execInsert(el, text); }]
    ];
    for (const [name, run] of strategies) {
      if (!document.contains(el)) return false;
      if (!(await clearEditor(el))) { debugLog('EDITOR_CLEAR_FAILED', { name }); continue; }
      run();
      const ok = await waitUntil(() => norm(readEditor(el)) === expected, 2500);
      if (ok) {
        await sleep(250); // stability window catches late duplicate inserts
        if (norm(readEditor(el)) === expected) { debugLog('EDITOR_SET_OK', { name }); return true; }
      }
      debugLog('EDITOR_SET_MISMATCH', { name, expectedLen: expected.length,
                                        actualLen: norm(readEditor(el)).length });
    }
    await clearEditor(el);
    return false;
  }

  function editorTextMatches(actual, expected) {
    return norm(actual) === norm(expected);
  }

  function getComposerText(el) {
    return readEditor(el);
  }

  async function clearAndType(el, text) {
    if (!el) throw new Error('Input element not found.');

    if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
      const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
      const value = String(text ?? '');
      if (setter) setter.call(el, ''); else el.value = '';
      el.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
      if (setter) setter.call(el, value); else el.value = value;
      try { el.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true, inputType: 'insertText', data: value })); }
      catch (_) { el.dispatchEvent(new Event('input', { bubbles: true, composed: true })); }
      el.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
      return el;
    }

    const success = await setEditorText(el, text);
    if (!success) {
      const actual = readEditor(el);
      debugLog('MESSAGE_TYPED_FAILED', { expected: text, actual, expectedNorm: norm(text), actualNorm: norm(actual) });
      const e = new Error('WhatsApp editor did not accept the exact scheduled text.');
      e.noRetry = false;
      throw e;
    }
    return el;
  }

  async function typeIntoVerifiedEditor(findEditor, text, label = 'message') {
    const trimmed = String(text ?? '').replace(/\r\n?/g, '\n').trim();
    if (!trimmed) return findEditor();
    let editor = findEditor();
    const deadline = Date.now() + 15000;
    while (!editor && Date.now() < deadline) { await sleep(250); editor = findEditor(); }
    if (!editor) throw new Error(`WhatsApp ${label || 'message'} editor was not found.`);

    debugLog(label === 'caption' ? 'CAPTION_COMPOSER_SELECTED' : 'MESSAGE_COMPOSER_SELECTED', {
      tag: editor.tagName, aria: editor.getAttribute('aria-label'), testid: editor.getAttribute('data-testid'),
      dataTab: editor.getAttribute('data-tab'), inDialog: !!editor.closest('[role="dialog"]'), inFooter: !!editor.closest('footer')
    });

    await clearEditor(editor);
    const typed = await clearAndType(editor, trimmed);
    const actual = readEditor(typed);
    debugLog('MESSAGE_TYPED', { expected: trimmed, actual, matches: editorTextMatches(actual, trimmed) });
    return typed;
  }

  function normalizeContactString(s) {
    return clean(s)
      .replace(/\s*\(you\)\s*$/i, '')
      .replace(/^message yourself$/i, '')
      .replace(/[\u200B-\u200D\uFEFF]/g, '')
      .trim()
      .toLowerCase();
  }

  function contactsMatch(a, b) {
    const normA = normalizeContactString(a);
    const normB = normalizeContactString(b);
    if (!normA || !normB) return false;

    // Strict exact name match (ignoring case and whitespace)
    if (normA === normB) return true;

    // Phone number comparison (normalizing non-digits)
    const digitsA = normA.replace(/\D/g, '');
    const digitsB = normB.replace(/\D/g, '');
    if (digitsA.length >= 7 && digitsB.length >= 7) {
      if (digitsA === digitsB) return true;
      // Handle country codes (e.g., +919741405534 vs 9741405534)
      if (digitsA.endsWith(digitsB) || digitsB.endsWith(digitsA)) {
        const minLen = Math.min(digitsA.length, digitsB.length);
        if (minLen >= 10) return true;
      }
    }

    return false;
  }

  function extractRowContactName(row) {
    if (!row) return '';
    // 1. Prefer explicit title attribute on child spans
    const titleNodes = [...row.querySelectorAll('span[title], [title]')];
    for (const n of titleNodes) {
      const t = clean(n.getAttribute('title'));
      if (t && !GENERIC_LABELS.has(t.toLowerCase()) && !/^\d{1,2}:\d{2}/.test(t)) return t;
    }

    // 2. Inspect aria-label (WhatsApp formats chat rows as: "Contact Name, timestamp, last message...")
    const aria = clean(row.getAttribute('aria-label'));
    if (aria) {
      const firstSegment = aria.split(',')[0].trim();
      if (firstSegment && !GENERIC_LABELS.has(firstSegment.toLowerCase()) && !/unread/i.test(firstSegment)) {
        return firstSegment;
      }
    }

    // 3. Fallback to the first non-empty text line
    const lines = (row.innerText || '').split('\n').map(clean).filter(Boolean);
    for (const line of lines) {
      if (line && !GENERIC_LABELS.has(line.toLowerCase()) && !/^\d{1,2}:\d{2}/.test(line) && !/unread/i.test(line)) {
        return line;
      }
    }

    return '';
  }

  function findSidebarResult(name) {
    const side = document.querySelector('#side') || document.querySelector('#pane-side') || document.body;
    if (!side) return null;

    // 1. Direct search on title nodes in sidebar / search results
    const titleNodes = [...side.querySelectorAll('span[title], [title]')].filter(visible);
    for (const node of titleNodes) {
      const title = clean(node.getAttribute('title'));
      if (title && contactsMatch(title, name)) {
        return node.closest('[role="listitem"], [role="row"], [role="button"], [data-testid*="cell-frame"], div[tabindex]') || node;
      }
    }

    // 2. Search through chat rows
    const rows = getChatRows();
    for (const row of rows) {
      const rowName = extractRowContactName(row);
      if (rowName && contactsMatch(rowName, name)) {
        return row;
      }
    }

    // 3. Search through aria-labels
    const ariaNodes = [...side.querySelectorAll('[aria-label]')].filter(visible);
    for (const node of ariaNodes) {
      const aria = clean(node.getAttribute('aria-label'));
      const firstSegment = aria.split(',')[0].trim();
      if (firstSegment && contactsMatch(firstSegment, name)) {
        return node.closest('[role="listitem"], [role="row"], [role="button"], [data-testid*="cell-frame"], div[tabindex]') || node;
      }
    }

    return null;
  }

  function clickChatRow(rowOrElement) {
    if (!rowOrElement) return false;
    const target = typeof rowOrElement === 'string' ? findSidebarResult(rowOrElement) : rowOrElement;
    if (!target) return false;

    try { target.scrollIntoView({ block: 'center', inline: 'nearest' }); } catch (_) {}

    const interactive = target.querySelector?.('[role="button"]') ||
                        target.querySelector?.('[data-testid*="cell-frame"]') ||
                        target.querySelector?.('span[title]') ||
                        target.querySelector?.('div[tabindex]') ||
                        target;

    clickLikeUser(interactive);
    return true;
  }

  async function openContact(contact) {
    const name = clean(contact?.name);
    if (!name) throw new Error('Recipient contact name is empty.');
    debugLog('OPEN_CONTACT', { name, currentHeader: getHeaderTitle() });

    const current = clean(getHeaderTitle());
    const currentGeneric = !current || GENERIC_LABELS.has(current.toLowerCase()) || /^(profile details|contact info|conversation info)$/i.test(current);

    // If the exact contact is ALREADY open, do not re-navigate
    if (!currentGeneric && contactsMatch(current, name)) {
      if (document.querySelector('#main') && visible(document.querySelector('#main'))) {
        debugLog('OPEN_CONTACT_ALREADY_OPEN', { name, current });
        return;
      }
    }

    if (currentGeneric) {
      const close = [...document.querySelectorAll('#main button,[role="button"]')].filter(visible).find(el => {
        const meta = clean(`${el.getAttribute('aria-label')||''} ${el.getAttribute('title')||''} ${el.getAttribute('data-testid')||''}`).toLowerCase();
        return /^(close|back)$/i.test(meta) && !isCallControl(el);
      });
      if (close) { try { close.click(); await sleep(300); } catch (_) {} }
    }

    let opened = false;
    let targetRow = findSidebarResult(name);

    // Step 1: Check if the contact row is directly visible in the left sidebar list
    if (targetRow && clickChatRow(targetRow)) {
      debugLog('OPEN_CONTACT_VISIBLE_CHAT_CLICKED', { name });
      try {
        await waitForHeader(name, 3500, targetRow);
        await waitForMainPane(3500);
        opened = true;
      } catch (_) {
        debugLog('OPEN_CONTACT_VISIBLE_CHAT_MISMATCH', { name, header: getHeaderTitle() });
      }
    }

    // Step 2: Use search box to locate the exact recipient
    if (!opened) {
      const search = findSearchBox();
      if (!search) throw new Error('Recipient search box not found in WhatsApp sidebar.');
      debugLog('OPEN_CONTACT_RECIPIENT_SEARCH', { name });

      await clearAndType(search, name);
      await sleep(1800);

      // Search results have populated; search rows for exact contact match
      targetRow = findSidebarResult(name);
      if (targetRow) {
        clickChatRow(targetRow);
      }

      // Also dispatch keyboard Enter on the search box
      const enterInit = { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true, composed: true };
      try { search.dispatchEvent(new KeyboardEvent('keydown', enterInit)); } catch (_) {}
      try { search.dispatchEvent(new KeyboardEvent('keypress', enterInit)); } catch (_) {}
      try { search.dispatchEvent(new KeyboardEvent('keyup', enterInit)); } catch (_) {}

      // STRICT VALIDATION: Ensure the opened chat matches the requested recipient
      await waitForHeader(name, 10000, targetRow);
      await waitForMainPane(8000);
    }
  }

  async function waitForMainPane(timeout = 8000) {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      const main = document.querySelector('#main');
      if (main && visible(main)) return true;
      await sleep(250);
    }
    throw new Error('WhatsApp chat pane (#main) did not open.');
  }

  async function waitForHeader(expected, timeout = 10000, retryClickTarget = null) {
    const start = Date.now();
    let lastHeader = '';
    while (Date.now() - start < timeout) {
      const current = clean(getHeaderTitle());
      lastHeader = current;
      const main = document.querySelector('#main');
      if (main && visible(main) && current && contactsMatch(current, expected)) return;

      // Retry clicking the search result row every ~1.5s if header hasn't updated yet
      if (retryClickTarget && (Date.now() - start) > 1500 && (Date.now() - start) % 1500 < 350) {
        clickChatRow(retryClickTarget);
      }
      await sleep(250);
    }
    throw new Error(`WhatsApp opened chat “${lastHeader || 'None'}” instead of requested contact “${expected}”. Send aborted to prevent wrong recipient delivery.`);
  }

  function findComposer() {
    // IMPORTANT: never search document.body for the composer. That can select
    // WhatsApp's left sidebar search box. The message editor lives in #main.
    const main = document.querySelector('#main');
    if (!main || !visible(main)) return null;

    const footer = main.querySelector('footer');
    const selectors = [
      'footer div[contenteditable="true"][data-tab="10"]',
      'footer div[contenteditable="true"][role="textbox"]',
      'footer [contenteditable="true"][aria-label*="message" i]',
      'footer [contenteditable="true"][data-placeholder*="message" i]',
      'footer [contenteditable="true"]',
      'div[contenteditable="true"][data-tab="10"]',
      'div[contenteditable="true"][role="textbox"]',
      '[contenteditable="true"][aria-label*="Type a message" i]',
      '[contenteditable="true"][data-placeholder*="Type a message" i]'
    ];

    const candidates = [];
    const seen = new Set();
    for (const selector of selectors) {
      let nodes = [];
      try { nodes = [...main.querySelectorAll(selector)]; } catch (_) {}
      for (const el of nodes) {
        if (seen.has(el) || !visible(el)) continue;
        seen.add(el);
        const r = el.getBoundingClientRect();
        const aria = clean(el.getAttribute('aria-label'));
        const placeholder = clean(el.getAttribute('data-placeholder') || el.getAttribute('placeholder'));
        const role = clean(el.getAttribute('role'));
        const testid = clean(el.getAttribute('data-testid'));
        const dataTab = clean(el.getAttribute('data-tab'));
        let score = 0;
        if (footer?.contains(el)) score += 1000;
        if (dataTab === '10') score += 500;
        if (el.getAttribute('contenteditable') === 'true') score += 300;
        if (role === 'textbox') score += 200;
        if (/type a message|message|reply/i.test(`${aria} ${placeholder} ${testid}`)) score += 300;
        if (r.bottom > window.innerHeight - 180) score += 150;
        candidates.push({el, score, aria, placeholder, role, testid, dataTab});
      }
    }

    candidates.sort((a,b) => b.score - a.score);
    const best = candidates[0]?.el || null;
    if (best) {
      const c = candidates[0];
      debugLog('COMPOSER_FOUND', {
        tag: best.tagName,
        score: c.score,
        role: c.role,
        contenteditable: best.getAttribute('contenteditable'),
        dataTab: c.dataTab,
        aria: c.aria,
        placeholder: c.placeholder,
        testid: c.testid,
        footer: !!footer?.contains(best)
      });
      return best;
    }

    debugLog('COMPOSER_NOT_FOUND', {
      mainExists: true,
      footerExists: !!footer,
      mainContentEditables: [...main.querySelectorAll('[contenteditable]')].filter(visible).slice(0, 20).map(el => ({
        tag: el.tagName,
        contenteditable: el.getAttribute('contenteditable'),
        role: el.getAttribute('role'),
        dataTab: el.getAttribute('data-tab'),
        aria: el.getAttribute('aria-label'),
        placeholder: el.getAttribute('data-placeholder') || el.getAttribute('placeholder'),
        testid: el.getAttribute('data-testid')
      }))
    });
    return null;
  }

  async function waitForComposer(timeout = 15000) {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      const composer = findComposer();
      if (composer) return composer;
      await sleep(300);
    }
    throw new Error('Message composer not found after 15 seconds.');
  }


  function isCallControl(el) {
    const label = clean([
      el?.getAttribute?.('aria-label'),
      el?.getAttribute?.('title'),
      el?.getAttribute?.('data-testid'),
      el?.getAttribute?.('data-icon')
    ].filter(Boolean).join(' ')).toLowerCase();
    return /\b(video|voice)\s*call\b|\bcall\b/.test(label);
  }

  function findAttachButton() {
    const main = document.querySelector('#main');
    const footer = main?.querySelector('footer');
    if (!main || !visible(main)) return null;

    const selectors = [
      'footer button[aria-label="Attach"]',
      'footer [role="button"][aria-label="Attach"]',
      'footer button[title="Attach"]',
      'footer [role="button"][title="Attach"]',
      'footer [data-testid="clip"]',
      'footer [data-testid="attach"]',
      'footer [data-icon="attach"]',
      'footer [data-icon="attach-menu-plus"]',
      'footer [data-icon="plus"]',
      'footer [data-icon="plus-rounded"]',
      'footer [data-icon="wds-ic-plus"]',
      'footer [data-testid="plus"]',
      'footer [data-icon*="plus" i]',
      'footer [data-icon*="attach" i]'
    ];

    for (const selector of selectors) {
      const el = [...main.querySelectorAll(selector)].find(x => visible(x) && !isCallControl(x));
      if (el) return el.closest('button,[role="button"]') || el;
    }

    if (!footer) return null;
    const icons = [...footer.querySelectorAll('[data-icon], [aria-label], [title]')].filter(visible);
    for (const icon of icons) {
      if (isCallControl(icon)) continue;
      const meta = clean([
        icon.getAttribute('aria-label'), icon.getAttribute('title'), icon.getAttribute('data-icon')
      ].filter(Boolean).join(' ')).toLowerCase();
      if (!/attach|paperclip|plus/.test(meta)) continue;
      const button = icon.closest('button,[role="button"]');
      if (button && visible(button) && !isCallControl(button)) return button;
    }
    return null;
  }

  function assignFilesToInput(input, files) {
    if (!input || !files?.length) return false;
    try { input.value = ''; } catch (_) {}
    const transfer = new DataTransfer();
    for (const file of files) transfer.items.add(file);

    try {
      const descriptor = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'files');
      if (descriptor?.set) {
        descriptor.set.call(input, transfer.files);
      } else {
        input.files = transfer.files;
      }
    } catch (_) {
      try { input.files = transfer.files; } catch (_) {}
    }

    try { input.focus(); } catch (_) {}
    try { input.dispatchEvent(new Event('input', { bubbles: true, composed: true, cancelable: true })); } catch (_) {}
    try { input.dispatchEvent(new Event('change', { bubbles: true, composed: true, cancelable: true })); } catch (_) {}
    try { input.dispatchEvent(new UIEvent('change', { bubbles: true, cancelable: true })); } catch (_) {}
    return true;
  }

  const MIME_EXT_MAP = {
    png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif',
    mp4: 'video/mp4', mov: 'video/quicktime', '3gp': 'video/3gpp',
    pdf: 'application/pdf', txt: 'text/plain', csv: 'text/csv', json: 'application/json', zip: 'application/zip',
    doc: 'application/msword', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    xls: 'application/vnd.ms-excel', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    ppt: 'application/vnd.ms-powerpoint', pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation'
  };

  function inferMimeType(name, type) {
    if (type && type !== 'application/octet-stream') return type;
    const ext = String(name || '').toLowerCase().split('.').pop();
    return MIME_EXT_MAP[ext] || type || 'application/octet-stream';
  }

  function isMediaFile(file) {
    const name = String(file?.name || '').toLowerCase();
    const ext = name.includes('.') ? name.slice(name.lastIndexOf('.') + 1) : '';
    if (ext === 'svg') return false;
    const type = String(file?.type || inferMimeType(name, '')).toLowerCase();
    const isImage = (type.startsWith('image/') || ['png', 'jpg', 'jpeg', 'webp', 'gif'].includes(ext)) && ext !== 'svg';
    const isVideo = type.startsWith('video/') || ['mp4', 'mov', '3gp'].includes(ext);
    return isImage || isVideo;
  }

  function areAllMediaFiles(files) {
    return Array.isArray(files) && files.length > 0 && files.every(isMediaFile);
  }

  function getMenuLabel(el) {
    if (!el) return '';
    const parent = el.closest('li, [role="listitem"], [role="menuitem"], button, [role="button"], label');
    if (!parent) return '';
    return clean(parent.innerText || parent.textContent || '').slice(0, 30);
  }

  function isStickerElement(el) {
    if (!el) return false;
    if (el.tagName === 'INPUT' && el.type === 'file') {
      const accept = String(el.accept || '').trim().toLowerCase();
      if (accept === 'image/*' && !el.multiple) return true;
    }
    const selfAttrs = [
      el.getAttribute?.('aria-label'),
      el.getAttribute?.('title'),
      el.getAttribute?.('data-testid'),
      el.getAttribute?.('data-icon')
    ].filter(Boolean).join(' ').toLowerCase();
    if (/sticker|custom-sticker|attach-sticker/i.test(selfAttrs)) return true;

    // Check immediate interactive wrapper (li, [role="listitem"], [role="menuitem"], button, label)
    const wrapper = el.closest('button, [role="button"], [role="menuitem"], [role="listitem"], li, label');
    if (wrapper) {
      const wrapperAttrs = [
        wrapper.getAttribute?.('aria-label'),
        wrapper.getAttribute?.('title'),
        wrapper.getAttribute?.('data-testid'),
        wrapper.getAttribute?.('data-icon')
      ].filter(Boolean).join(' ').toLowerCase();
      if (/sticker|custom-sticker|attach-sticker/i.test(wrapperAttrs)) return true;

      const directText = clean(wrapper.innerText || wrapper.textContent || '').toLowerCase();
      if (/sticker/i.test(directText)) return true;
    }
    return false;
  }

  function isSchedulerUiElement(el) {
    if (!el) return false;
    return !!(
      el.closest?.('[data-wa-sched-ui]') ||
      el.closest?.('#wa-sched-modal-root') ||
      el.closest?.('#wa-sched-inchat-btn') ||
      el.id === 'wa-sched-inchat-file-input'
    );
  }

  function selectFileInput(allInputs, files) {
    const isAllMedia = areAllMediaFiles(files);
    const validInputs = allInputs.filter(inp => {
      if (!inp || !inp.isConnected || inp.disabled || isSchedulerUiElement(inp)) return false;
      const accept = String(inp.accept || '').trim().toLowerCase();
      const menuLabel = getMenuLabel(inp);
      if (accept === 'image/*' && !inp.multiple) return false;
      if (/sticker/i.test(menuLabel)) return false;
      if (isStickerElement(inp)) return false;
      return true;
    });

    if (isAllMedia) {
      // 1. If ALL files are image/video: select the input whose accept includes "video" (multiple:true)
      const videoInput = validInputs.find(inp => {
        const accept = String(inp.accept || '').toLowerCase();
        return accept.includes('video') && inp.multiple;
      }) || validInputs.find(inp => {
        const accept = String(inp.accept || '').toLowerCase();
        return accept.includes('video');
      });

      if (videoInput) {
        return {
          input: videoInput,
          reason: 'media_video_accept',
          menuLabel: getMenuLabel(videoInput)
        };
      }

      // 2. If none exists after 4s, fall back to document input (accept "*" / "")
      const docInput = validInputs.find(inp => {
        const accept = String(inp.accept || '').trim().toLowerCase();
        return (accept === '*' || accept === '' || accept === '*/*') && inp.multiple;
      }) || validInputs.find(inp => {
        const accept = String(inp.accept || '').trim().toLowerCase();
        return accept === '*' || accept === '' || accept === '*/*';
      });

      if (docInput) {
        debugLog('ATTACHMENT_FALLBACK_AS_DOCUMENT', {
          accept: docInput.accept,
          multiple: docInput.multiple,
          menuLabel: getMenuLabel(docInput)
        });
        return {
          input: docInput,
          reason: 'fallback_as_document',
          menuLabel: getMenuLabel(docInput)
        };
      }

      return null;
    } else {
      // If ANY file is not image/video: select document input (accept "*", "", or "*/*"; multiple: true)
      const docInput = validInputs.find(inp => {
        const accept = String(inp.accept || '').trim().toLowerCase();
        return (accept === '*' || accept === '' || accept === '*/*') && inp.multiple;
      }) || validInputs.find(inp => {
        const accept = String(inp.accept || '').trim().toLowerCase();
        return accept === '*' || accept === '' || accept === '*/*';
      }) || validInputs.find(inp => !isMediaOnlyInput(inp));

      if (docInput) {
        return {
          input: docInput,
          reason: 'document_input',
          menuLabel: getMenuLabel(docInput)
        };
      }

      return null;
    }
  }

  function attachmentKind(files) {
    if (areAllMediaFiles(files)) return 'media';
    return 'document';
  }

  function findFileInput(preferredFiles = [], kind = 'document') {
    const inputs = [...document.querySelectorAll('input[type="file"]')].filter(el => !el.disabled && !isStickerElement(el) && !isSchedulerUiElement(el));
    if (!inputs.length) return null;
    const isMedia = kind === 'media' || areAllMediaFiles(preferredFiles);
    const wantedTypes = preferredFiles.map(f => String(f.type || '').toLowerCase()).filter(Boolean);
    const wantedExts = preferredFiles.map(f => { const n = String(f.name || '').toLowerCase(); return n.includes('.') ? n.slice(n.lastIndexOf('.')) : ''; }).filter(Boolean);
    const contextOf = input => {
      const bits = []; let node = input;
      for (let i = 0; node && i < 5; i++, node = node.parentElement) bits.push(node.getAttribute?.('aria-label') || '', node.getAttribute?.('title') || '', node.getAttribute?.('data-testid') || '', node.getAttribute?.('data-icon') || '', node.innerText || '');
      return clean(bits.join(' ')).toLowerCase();
    };
    const score = input => {
      if (isStickerElement(input)) return -99999;
      const accept = String(input.accept || '').toLowerCase();
      const mediaOnly = isMediaOnlyInput(input);
      const context = contextOf(input);
      let s = 0;
      if (/sticker|emoji|gif sticker/.test(context) || /sticker/.test(accept)) return -99999;
      if (/profile|avatar|status/.test(context)) s -= 5000;
      if (input.multiple) s += 50;

      if (isMedia) {
        if (/photos?\s*(and|&)\s*videos?|media|gallery/.test(context)) s += 5000;
        if (/image\/\*|video\/\*/.test(accept)) s += 4000;
        if (accept.includes('image/') || accept.includes('video/')) s += 2000;
      } else {
        // Document/general files (CSV, PDF, TXT, DOCX, ZIP, etc.)
        if (mediaOnly) s -= 30000;
        if (/photos?\s*(and|&)\s*videos?|camera/.test(context)) s -= 10000;
        if (/image\/\*|video\/\*/.test(accept)) s -= 15000;
        if (!mediaOnly) s += 10000;
        if (!accept || accept === '*' || accept === '*/*') s += 6000;
        if (accept.includes('application/')) s += 3000;
        if (accept.includes('text/')) s += 3000;
        if (/document|file|doc/.test(context)) s += 4000;
      }

      for (const type of wantedTypes) { if (accept.includes(type)) s += 500; const family = type.split('/')[0]; if (family && accept.includes(`${family}/*`)) s += 250; }
      for (const ext of wantedExts) if (accept.includes(ext)) s += 350;
      return s;
    };
    const ranked = inputs.map(input => ({ input, score: score(input), accept: input.accept, context: contextOf(input) })).filter(x => x.score > -10000).sort((a,b)=>b.score-a.score);
    debugLog('ATTACHMENT_INPUT_CANDIDATES', ranked.slice(0,10).map(x=>({score:x.score,accept:x.accept,multiple:x.input.multiple,visible:visible(x.input),context:x.context.slice(0,180)})));
    const best = ranked[0];
    return best?.input || null;
  }

  async function sha256Hex(input) {
    const resolved = await input;
    let buffer = resolved;
    if (resolved instanceof Blob) buffer = await resolved.arrayBuffer();
    else if (ArrayBuffer.isView(resolved)) buffer = resolved.buffer.slice(resolved.byteOffset, resolved.byteOffset + resolved.byteLength);
    if (!(buffer instanceof ArrayBuffer)) throw new TypeError('SHA-256 input must be an ArrayBuffer, ArrayBufferView, Blob, or Promise resolving to one.');
    const digest = await crypto.subtle.digest('SHA-256', buffer);
    return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('');
  }

  async function getAttachmentFile(meta) {
    const chunks = [];
    let offset = 0;
    let expectedHash = meta.hash || null;
    let lastModified = meta.lastModified || Date.now();
    while (true) {
      const response = await chrome.runtime.sendMessage({ type: 'GET_ATTACHMENT_CHUNK', attachmentId: meta.id, offset });
      if (!response?.success) throw new Error(response?.error || 'Could not read attachment.');
      if (typeof response.chunkBase64 !== 'string') throw new Error('Attachment chunk data was not encoded correctly.');
      if (response.hash) expectedHash = response.hash;
      if (response.lastModified) lastModified = response.lastModified;
      const binary = atob(response.chunkBase64);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      chunks.push(bytes);
      offset += bytes.byteLength;
      if (response.done) break;
    }
    const blob = new Blob(chunks, { type: meta.type || 'application/octet-stream' });
    if (Number.isFinite(meta.size) && blob.size !== meta.size) {
      throw new Error(`Attachment size mismatch for ${meta.name}: expected ${meta.size} bytes, got ${blob.size} bytes.`);
    }
    const actualHash = await sha256Hex(await blob.arrayBuffer());
    if (expectedHash && actualHash !== expectedHash) {
      throw new Error(`Attachment content mismatch for ${meta.name}: expected original SHA-256 ${expectedHash}, got ${actualHash}.`);
    }
    const originalType = meta.type || '';
    const uploadType = inferMimeType(meta.name, originalType);
    const file = new File([blob], meta.name, { type: uploadType, lastModified });
    debugLog('ATTACHMENT_FILE_RECONSTRUCTED', {
      name: file.name, type: file.type, originalType, uploadType, size: file.size, expectedSize: meta.size,
      hash: actualHash, expectedHash: expectedHash || null, lastModified: file.lastModified,
      exactBytes: !expectedHash || actualHash === expectedHash
    });
    return file;
  }

  function findAttachMenuItem(kind = 'document') {
    const isDoc = kind === 'document';
    const isMedia = kind === 'media';

    const scanScopes = (scopes) => {
      const candidates = [];
      const seen = new Set();

      for (const scope of scopes) {
        const elements = scope.querySelectorAll(
          'li, button, [role="button"], [role="menuitem"], [role="option"], [data-testid*="attach" i], label, div, span'
        );

        for (const el of elements) {
          if (!visible(el)) continue;

          // Skip chat messages, chat history containers, sidebar, and extension UI
          if (el.closest('#main [data-testid="conversation-panel-messages"], #main .copyable-area, [data-id], .message-in, .message-out, [data-pre-plain-text], #side, #pane-side') || isSchedulerUiElement(el)) continue;

          // STRICTLY REJECT sticker elements
          if (isStickerElement(el)) continue;

          const ownText = clean(el.innerText || el.textContent || '');
          const aria = clean(el.getAttribute('aria-label') || '');
          const title = clean(el.getAttribute('title') || '');
          const testid = clean(el.getAttribute('data-testid') || '');
          const icon = clean(el.getAttribute('data-icon') || el.querySelector?.('[data-icon]')?.getAttribute('data-icon') || '');

          let score = 0;
          if (isDoc) {
            if (/^documents?$/i.test(ownText)) score += 6000;
            else if (/^documents?$/i.test(aria) || /^documents?$/i.test(title)) score += 5500;
            else if (/attach-document|document/i.test(`${icon} ${testid}`)) score += 4000;
            else if (/^document\b/i.test(ownText) && ownText.length < 15) score += 3000;
          } else if (isMedia) {
            if (/^photos?\s*(&|and)\s*videos?$/i.test(ownText) || /^photos?$/i.test(ownText)) score += 6000;
            else if (/photos?\s*(&|and)\s*videos?/i.test(aria) || /photos?\s*(&|and)\s*videos?/i.test(title)) score += 5500;
            else if (/image|photo|gallery|attach-image/i.test(`${icon} ${testid}`)) score += 4000;
            else if (/\b(photos?|gallery|media)\b/i.test(ownText) && ownText.length < 20) score += 3000;
          }

          if (score > 0) {
            const clickable = el.closest('button, [role="button"], [role="menuitem"], [role="option"], li, label') || el;
            if (seen.has(clickable) || isStickerElement(clickable) || isSchedulerUiElement(clickable)) continue;
            seen.add(clickable);

            const directInput = clickable.querySelector?.('input[type="file"]') ||
                                el.querySelector?.('input[type="file"]') ||
                                clickable.parentElement?.querySelector?.('input[type="file"]');
            if (directInput && !isStickerElement(directInput) && !isSchedulerUiElement(directInput)) score += 2000;

            candidates.push({ el: clickable, input: directInput, score, text: ownText, aria, testid, icon });
          }
        }
      }

      candidates.sort((a, b) => b.score - a.score);
      return candidates;
    };

    const menuScopes = [
      ...document.querySelectorAll('[role="menu"], [role="listbox"], [data-animate-dropdown-item], [data-testid*="menu" i], [data-testid*="dropdown" i]'),
      document.querySelector('footer')
    ].filter(Boolean).filter(visible);

    let candidates = scanScopes(menuScopes.length ? menuScopes : [document.body]);

    // If no candidates found in menuScopes, trigger fallback scan over document.body
    if (!candidates.length && menuScopes.length > 0) {
      candidates = scanScopes([document.body]);
    }

    debugLog('ATTACH_MENU_ITEM_SEARCH', {
      kind,
      found: candidates.length,
      top: candidates.slice(0, 5).map(c => ({ score: c.score, text: c.text, aria: c.aria, icon: c.icon, tag: c.el?.tagName, hasInput: !!c.input }))
    });

    return candidates[0] || null;
  }

  function findDocumentMenuItem() {
    return findAttachMenuItem('document')?.el || null;
  }

  function isMediaOnlyInput(input) {
    const accept = String(input?.accept || '').toLowerCase().replace(/\s+/g,'');
    if (!accept || accept === '*' || accept === '*/*') return false;
    return /(^|,)(image\/\*|video\/\*)(,|$)/.test(accept) && !/application\/|text\/|\*\/\*|^\*$/.test(accept);
  }

  function rankDocumentInput(inputs) {
    const ranked = inputs.filter(el => el && !el.disabled && el.type === 'file' && !isMediaOnlyInput(el) && !isStickerElement(el) && !isSchedulerUiElement(el)).map(input => {
      const accept = String(input.accept || '').toLowerCase();
      const context = clean([
        input.getAttribute('aria-label'), input.getAttribute('title'), input.getAttribute('data-testid'),
        input.getAttribute('data-icon'), input.parentElement?.innerText || ''
      ].filter(Boolean).join(' ')).toLowerCase();
      let score = 5000;
      if (!accept || accept === '*' || accept === '*/*') score += 2000;
      if (/application\//.test(accept)) score += 1200;
      if (/text\//.test(accept)) score += 800;
      if (/document|file|attach/.test(context)) score += 1000;
      if (input.multiple) score += 200;
      return {input, score, accept, multiple:input.multiple, context};
    }).sort((a,b)=>b.score-a.score);
    debugLog('DOCUMENT_INPUT_RANKED', ranked.slice(0,10).map(x=>({score:x.score,accept:x.accept,multiple:x.multiple,connected:x.input.isConnected,visible:visible(x.input),context:x.context.slice(0,160)})));
    return ranked[0]?.input || null;
  }

  async function attachFilesViaDrop(files) {
    if (isPreviewOpen()) return true;
    if (currentJobDropAttempted) return false;
    currentJobDropAttempted = true;

    const main = document.querySelector('#main');
    const target = document.querySelector('#main [data-testid="conversation-panel-messages"]') ||
                   document.querySelector('#main .copyable-area') ||
                   main;
    if (!target || !visible(target)) return false;

    const transfer = new DataTransfer();
    for (const file of files) transfer.items.add(file);
    try { transfer.effectAllowed = 'copy'; } catch (_) {}
    try { transfer.dropEffect = 'copy'; } catch (_) {}

    const rect = target.getBoundingClientRect();
    const init = {
      bubbles: true,
      cancelable: true,
      composed: true,
      dataTransfer: transfer,
      clientX: Math.round(rect.left + Math.max(1, rect.width / 2)),
      clientY: Math.round(rect.top + Math.max(1, rect.height / 2)),
      screenX: window.screenX + Math.round(rect.left + Math.max(1, rect.width / 2)),
      screenY: window.screenY + Math.round(rect.top + Math.max(1, rect.height / 2))
    };
    try { target.dispatchEvent(new DragEvent('dragenter', init)); } catch (_) {}
    try { target.dispatchEvent(new DragEvent('dragover', init)); } catch (_) {}
    try { target.dispatchEvent(new DragEvent('drop', init)); } catch (_) {}
    debugLog('ATTACHMENT_DROP_DISPATCHED', { tag: target.tagName, className: String(target.className || '').slice(0, 120) });

    try {
      await waitForAttachmentPreview(files, 12000);
      return true;
    } catch (dropErr) {
      debugLog('ATTACHMENT_DROP_NO_PREVIEW', { error: dropErr?.message || String(dropErr) });
      return false;
    }
  }

  function findPreviewContainer() {
    const dialogs = [...document.querySelectorAll('[role="dialog"], [data-animate-modal-popup], [data-testid*="popup" i], [data-testid*="drawer" i]')].filter(visible);
    if (dialogs.length) return dialogs[0];

    const caption = findCaptionComposer();
    if (caption) {
      const nonFooterAncestor = caption.closest('div[tabindex="-1"], section, [role="region"], #main') || caption.parentElement;
      if (nonFooterAncestor && !nonFooterAncestor.closest('footer')) return nonFooterAncestor;
    }
    return null;
  }

  function isPreviewOpen() {
    const container = findPreviewContainer();
    if (container && visible(container)) return true;
    const caption = findCaptionComposer();
    if (caption && visible(caption) && !caption.closest('footer')) return true;
    return false;
  }

  async function closeAttachMenuIfOpen() {
    try {
      const menus = [...document.querySelectorAll('[role="menu"], [role="listbox"], [data-animate-dropdown-item], [data-testid*="menu" i], [data-testid*="dropdown" i]')].filter(visible);
      if (menus.length) {
        const escInit = { key: 'Escape', code: 'Escape', keyCode: 27, which: 27, bubbles: true, cancelable: true, composed: true };
        document.dispatchEvent(new KeyboardEvent('keydown', escInit));
        await sleep(150);
      }
    } catch (_) {}
  }

  async function closeAnyPreviewDialog() {
    try {
      const dialog = findPreviewContainer();
      if (dialog) {
        const closeBtn = [...dialog.querySelectorAll('button, [role="button"]')]
          .filter(visible)
          .find(el => {
            const meta = clean(`${el.getAttribute('aria-label') || ''} ${el.getAttribute('title') || ''} ${el.getAttribute('data-testid') || ''} ${el.getAttribute('data-icon') || ''}`).toLowerCase();
            return /close|back|cancel|dismiss|x\b/.test(meta) && !isCallControl(el);
          });
        if (closeBtn) {
          clickLikeUser(closeBtn);
          await sleep(200);
        }
      }
    } catch (_) {}
    try {
      const escInit = { key: 'Escape', code: 'Escape', keyCode: 27, which: 27, bubbles: true, cancelable: true, composed: true };
      document.dispatchEvent(new KeyboardEvent('keydown', escInit));
      document.dispatchEvent(new KeyboardEvent('keyup', escInit));
    } catch (_) {}
  }

  async function waitForAttachmentPreview(files, timeout = 15000) {
    const isMedia = areAllMediaFiles(files);
    const deadline = Date.now() + timeout;

    while (Date.now() < deadline) {
      const rejection = getAttachmentRejection();
      if (rejection) {
        const e = new Error(`WhatsApp rejected the attachment: ${rejection}`);
        e.noRetry = true;
        e.stage = 'attach-files';
        throw e;
      }

      const container = findPreviewContainer();
      const caption = findCaptionComposer();
      const nonFooterSend = [...(container || document).querySelectorAll('button, [role="button"], [aria-label]')]
        .filter(visible)
        .filter(el => !el.closest('footer'))
        .find(el => /^Send/i.test(clean(el.getAttribute('aria-label') || '')));

      const hasSendOrCaption = !!caption || !!nonFooterSend;

      if (hasSendOrCaption) {
        debugLog('ATTACHMENT_PREVIEW_READY', {
          isMedia,
          hasCaption: !!caption,
          hasSend: !!nonFooterSend,
          matchedSendAria: nonFooterSend ? clean(nonFooterSend.getAttribute('aria-label')) : null,
          containerFound: !!container
        });
        await sleep(400);
        return true;
      }

      await sleep(200);
    }

    const err = new Error('WhatsApp attachment preview was not ready within 15 seconds.');
    err.noRetry = false;
    err.stage = 'attach-files';
    throw err;
  }

  async function waitForNoPreview(timeout = 5000) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      if (!isPreviewOpen()) {
        const sendBtn = [...document.querySelectorAll('button, [role="button"], [aria-label]')]
          .filter(visible)
          .filter(el => !el.closest('footer'))
          .find(el => /^Send( \d+ selected)?$/i.test(clean(el.getAttribute('aria-label') || '')));
        if (!sendBtn) return true;
      }
      await sleep(200);
    }
    return !isPreviewOpen();
  }

  async function attachFiles(attachments) {
    if (!attachments?.length) return;

    const files = [];
    for (const meta of attachments) {
      const file = await getAttachmentFile(meta);
      if (Number.isFinite(meta.size) && file.size !== meta.size) {
        throw new Error(`Attachment size mismatch for ${meta.name}: expected ${meta.size} bytes, got ${file.size} bytes.`);
      }
      files.push(file);
    }
    const fileIntegrity = [];
    for (let i = 0; i < files.length; i++) {
      const hash = await sha256Hex(await files[i].arrayBuffer());
      const meta = attachments[i] || {};
      if (meta.size != null && files[i].size !== meta.size) throw new Error(`Attachment size mismatch for ${files[i].name}: expected ${meta.size} bytes, got ${files[i].size} bytes.`);
      if (meta.hash && hash !== meta.hash) throw new Error(`Attachment content mismatch for ${files[i].name}: the scheduled bytes are not the original file.`);
      fileIntegrity.push({ name: files[i].name, type: files[i].type, size: files[i].size, expectedSize: meta.size, hash, expectedHash: meta.hash || null, exactBytes: !meta.hash || hash === meta.hash });
    }
    debugLog('ATTACHMENT_FILE_INTEGRITY', fileIntegrity);
    const kind = attachmentKind(files);

    for (let fullAttempt = 0; fullAttempt < 2; fullAttempt++) {
      if (attachmentsAssigned) break;

      // Before attaching, run clearEditor on footer composer
      const footerComposer = findComposer();
      if (footerComposer) {
        await clearEditor(footerComposer);
      }

      const before = captureAttachmentState(files);
      debugLog('ATTACHMENT_RENDER_BASELINE', { ...before, fullAttempt });

      // Open attach menu (up to 3 tries)
      let menuItem = null;
      let dumpLoggedAfterFirstClick = false;

      for (let tryCount = 0; tryCount < 3; tryCount++) {
        menuItem = findAttachMenuItem(kind);
        if (menuItem?.el) break;

        const attachButton = findAttachButton();
        if (attachButton) {
          debugLog('ATTACH_BUTTON_CLICK', {
            tryCount,
            fullAttempt,
            aria: attachButton.getAttribute('aria-label'),
            title: attachButton.getAttribute('title'),
            testid: attachButton.getAttribute('data-testid'),
            icon: attachButton.getAttribute('data-icon')
          });
          clickLikeUser(attachButton);
        }

        const pollDeadline = Date.now() + 1500;
        const firstClickTime = Date.now();
        while (Date.now() < pollDeadline) {
          menuItem = findAttachMenuItem(kind);
          if (menuItem?.el) break;

          if (tryCount === 0 && !dumpLoggedAfterFirstClick && Date.now() - firstClickTime >= 800) {
            dumpLoggedAfterFirstClick = true;
            debugLog('ATTACH_UI_DUMP', captureAttachUiDump(attachButton));
          }

          await sleep(150);
        }

        if (menuItem?.el) break;

        if (tryCount === 0 && !dumpLoggedAfterFirstClick) {
          dumpLoggedAfterFirstClick = true;
          debugLog('ATTACH_UI_DUMP', captureAttachUiDump(attachButton));
        }

        debugLog('ATTACH_MENU_NOT_OPEN', { tryCount, fullAttempt, kind });
        await sleep(400);
      }

      if (!menuItem?.el) {
        debugLog('ATTACH_UI_DUMP', captureAttachUiDump(findAttachButton()));
      }

      if (menuItem?.el) {
        debugLog('ATTACH_MENU_ITEM_CLICK', {
          kind,
          fullAttempt,
          text: menuItem.text,
          aria: menuItem.aria,
          testid: menuItem.testid,
          icon: menuItem.icon,
          tag: menuItem.el.tagName
        });
        clickLikeUser(menuItem.el);
        await sleep(200);
      }

      // Poll up to 4s (150ms step) for connected file inputs
      const inputDeadline = Date.now() + 4000;
      let selected = null;
      let lastSnapshot = [];
      while (Date.now() < inputDeadline) {
        const allInputs = [...document.querySelectorAll('input[type="file"]')].filter(inp => inp.isConnected && !isSchedulerUiElement(inp));
        lastSnapshot = allInputs.map(inp => ({
          accept: inp.accept,
          multiple: inp.multiple,
          connected: inp.isConnected,
          menuLabel: getMenuLabel(inp)
        }));
        selected = selectFileInput(allInputs, files);
        if (selected?.input) break;
        await sleep(150);
      }

      debugLog('ATTACHMENT_FILE_INPUTS_SNAPSHOT', { inputs: lastSnapshot });

      if (selected?.input && !attachmentsAssigned) {
        debugLog('ATTACHMENT_INPUT_SELECTED', {
          accept: selected.input.accept,
          multiple: selected.input.multiple,
          menuLabel: selected.menuLabel,
          reason: selected.reason
        });

        try {
          assignFilesToInput(selected.input, files);
          attachmentsAssigned = true;

          const assigned = [...(selected.input.files || [])];
          debugLog('ATTACHMENT_INPUT_ASSIGNED', {
            count: assigned.length,
            names: assigned.map(f => f.name),
            sizes: assigned.map(f => f.size),
            types: assigned.map(f => f.type),
            accept: selected.input.accept
          });

          await closeAttachMenuIfOpen();
          await waitForAttachmentPreview(files, 15000);
          return;
        } catch (inputErr) {
          debugLog('ATTACHMENT_INPUT_ERROR', { error: inputErr?.message || String(inputErr) });
          if (inputErr?.stage === 'attach-files' && inputErr?.noRetry) throw inputErr;
        }
      }

      // If no file input was found at all and nothing was assigned, try drop fallback
      if (!attachmentsAssigned) {
        debugLog('ATTACHMENT_FALLBACK_DROP_ATTEMPT', { fileCount: files.length, fullAttempt });
        const dropSucceeded = await attachFilesViaDrop(files);
        if (dropSucceeded) {
          attachmentsAssigned = true;
          debugLog('ATTACHMENT_DROP_SUCCESS', { fileCount: files.length });
          return;
        }
      }

      // If preview did not show up and we have attempts left:
      if (fullAttempt === 0) {
        attachmentsAssigned = false;
        await cleanupEditorAndDialogs();
        await sleep(800);
        await waitForNoPreview(5000);
        debugLog('ATTACHMENT_RETRYING_FROM_TOP', { nextAttempt: 1 });
      }
    }

    const rejection = getAttachmentRejection();
    if (rejection) {
      debugLog('ATTACHMENT_REJECTED_BY_WHATSAPP', { message: rejection, names: files.map(f => f.name) });
      const e = new Error(`WhatsApp rejected the attachment: ${rejection}`); e.noRetry = true; e.stage = 'attach-files'; throw e;
    }

    const e = new Error('WhatsApp could not attach the scheduled file(s). Please ensure WhatsApp Web chat is fully loaded.');
    e.noRetry = false;
    e.stage = 'attach-files';
    throw e;
  }

  function getAttachmentRejection() {
    const selectors = [
      '[role="alert"]',
      '[role="status"]',
      '[data-testid*="toast" i]',
      '[data-testid*="alert" i]'
    ];
    const seen = new Set();
    const texts = [];
    for (const selector of selectors) {
      for (const el of document.querySelectorAll(selector)) {
        if (seen.has(el) || !visible(el)) continue;
        seen.add(el);
        const text = clean(el.innerText || el.textContent || '');
        if (text) texts.push(text);
      }
    }
    // WhatsApp currently renders this error as a transient toast. Keep the
    // match narrow so ordinary chat text containing the words "not supported"
    // cannot make the scheduler fail.
    const match = texts.find(text => /file(?:s)? you tried adding (?:is|are) not supported/i.test(text));
    if (!match) return null;
    return match;
  }

  function captureAttachmentState(files = []) {
    const main = document.querySelector('#main');
    const bodyText = clean(document.body?.innerText || '');
    const names = files.map(f => clean(f.name)).filter(Boolean);
    const filenameHits = names.filter(name => name && bodyText.includes(name)).length;
    const dialogs = [...document.querySelectorAll('[role="dialog"]')].filter(visible).length;
    const media = main ? [...main.querySelectorAll('img,video')].filter(visible).length : 0;
    const editables = main ? [...main.querySelectorAll('[contenteditable="true"],[contenteditable="plaintext-only"]')].filter(visible).length : 0;
    const sendVisible = !!findSendButton();

    // The current WhatsApp media composer can render without a role=dialog.
    // It exposes editing controls (crop/rotate/draw/text) and/or the selected
    // filename in the main pane. These are stronger signals than simply
    // counting all images in #main, which can include old chat media.
    const editControlCount = main ? [...main.querySelectorAll('button,[role="button"]')]
      .filter(visible)
      .filter(el => /crop|rotate|draw|sticker|text|edit/i.test(clean(`${el.getAttribute('aria-label')||''} ${el.getAttribute('title')||''} ${el.getAttribute('data-testid')||''}`))).length : 0;

    return { filenameHits, dialogs, media, editables, sendVisible, editControlCount };
  }

  function attachmentStateChanged(before, after) {
    return (after.filenameHits > before.filenameHits) ||
      (after.dialogs > before.dialogs) ||
      (after.sendVisible && !before.sendVisible) ||
      (after.editControlCount > before.editControlCount) ||
      (after.media > before.media && after.editables >= before.editables);
  }

  function findCaptionComposer() {
    const dialogs = [...document.querySelectorAll('[role="dialog"], [data-animate-modal-popup], [data-testid*="popup" i], [data-testid*="drawer" i]')].filter(visible);
    if (!dialogs.length) return null;

    const candidates = [];
    const seen = new Set();

    for (const scope of dialogs) {
      for (const el of scope.querySelectorAll('[contenteditable="true"],[contenteditable="plaintext-only"],textarea')) {
        if (seen.has(el) || !visible(el) || el.closest('footer')) continue;
        seen.add(el);
        const meta = clean([
          el.getAttribute('aria-label'), el.getAttribute('data-placeholder'),
          el.getAttribute('placeholder'), el.getAttribute('data-testid'),
          el.getAttribute('data-tab')
        ].filter(Boolean).join(' ')).toLowerCase();
        let score = 1000;
        if (/caption|add a caption/.test(meta)) score += 2000;
        candidates.push({ el, score });
      }
    }

    candidates.sort((a, b) => b.score - a.score);
    const best = candidates[0]?.el || null;
    debugLog(best ? 'CAPTION_COMPOSER_FOUND' : 'CAPTION_COMPOSER_NOT_FOUND', best ? {
      aria: best.getAttribute('aria-label'),
      placeholder: best.getAttribute('data-placeholder') || best.getAttribute('placeholder')
    } : { inDialogs: dialogs.length });
    return best;
  }

  function getClickable(el) {
    if (!el) return null;
    const clickable = el.closest('button,[role="button"],[tabindex="0"]');
    return clickable && visible(clickable) ? clickable : (visible(el) ? el : null);
  }

  function findAttachmentSendButton() {
    const main = document.querySelector('#main');
    const dialogs = [...document.querySelectorAll('[role="dialog"], [data-testid*="popup" i], [data-testid*="drawer" i]')].filter(visible);
    const scopes = [...dialogs, ...(main && visible(main) ? [main] : []), document.querySelector('#app') || document.body];

    const nodes = [];
    const seen = new Set();
    const selectors = [
      '[aria-label^="Send"][aria-label*="selected" i]',
      '[aria-label*="Send 1 selected" i]',
      '[data-testid*="send-selected" i]',
      '[data-testid*="media-send" i]',
      'button[aria-label="Send"]',
      '[role="button"][aria-label="Send"]',
      'button[aria-label*="Send" i]',
      '[role="button"][aria-label*="Send" i]',
      '[data-testid="send"]',
      '[data-testid*="send" i]',
      '[data-icon="wds-ic-send-filled"]',
      '[data-icon="send"]'
    ];

    for (const scope of scopes) {
      if (!scope) continue;
      for (const sel of selectors) {
        for (const el of scope.querySelectorAll(sel)) {
          if (visible(el) && !seen.has(el)) {
            seen.add(el);
            nodes.push(el);
          }
        }
      }
    }

    const caption = findCaptionComposer();
    const cr = caption?.getBoundingClientRect();
    const candidates = [];
    const seenButtons = new Set();

    for (const node of nodes) {
      const button = getClickable(node);
      if (!button || seenButtons.has(button)) continue;
      seenButtons.add(button);
      const r = button.getBoundingClientRect();
      let score = 2000;
      if (main?.contains(button)) score += 500;
      if (/send\s*\d+\s*selected/i.test(clean(node.getAttribute('aria-label')))) score += 1500;
      if (/^send$/i.test(clean(node.getAttribute('aria-label')))) score += 1000;
      if (button.closest('[role="dialog"]')) score += 1200;
      if (cr) {
        const verticalOverlap = Math.min(r.bottom, cr.bottom) - Math.max(r.top, cr.top);
        if (verticalOverlap > 0) score += 700;
        if (r.left >= cr.right - 20) score += 500;
      }
      candidates.push({button, score, aria: clean(node.getAttribute('aria-label')), testid: node.getAttribute('data-testid')});
    }

    candidates.sort((a,b) => b.score - a.score);
    const best = candidates[0]?.button || null;
    if (best) {
      debugLog('ATTACHMENT_SEND_BUTTON_FOUND', {
        tag: best.tagName,
        aria: best.getAttribute('aria-label'),
        title: best.getAttribute('title'),
        testid: best.getAttribute('data-testid'),
        icon: best.querySelector?.('[data-icon]')?.getAttribute('data-icon') || best.getAttribute('data-icon')
      });
    }
    return best;
  }

  function findSendButton() {
    const main = document.querySelector('#main');
    const scopes = [
      ...[...document.querySelectorAll('[role="dialog"]')].filter(visible),
      ...(main && visible(main) ? [main] : [])
    ];
    const candidates = [];
    const seen = new Set();

    const selectors = [
      'button[aria-label="Send"]',
      'button[aria-label*="Send" i]',
      '[role="button"][aria-label="Send"]',
      '[role="button"][aria-label*="Send" i]',
      '[data-testid="send"]',
      '[data-testid*="send" i]',
      '[data-icon="wds-ic-send-filled"]',
      '[data-icon="send"]'
    ];

    for (const scope of scopes) {
      for (const selector of selectors) {
        for (const el of [...scope.querySelectorAll(selector)]) {
          if (seen.has(el) || !visible(el)) continue;
          seen.add(el);
          const aria=clean(el.getAttribute('aria-label'));
          const title=clean(el.getAttribute('title'));
          const icon=clean(el.getAttribute('data-icon'));
          const r=el.getBoundingClientRect();
          let score=0;
          if (scope.matches?.('[role="dialog"]')) score+=1200;
          if (main?.contains(el)) score+=800;
          if (/^send$/i.test(aria)) score+=700;
          else if (/^send$/i.test(title)) score+=500;
          if (/wds-ic-send-filled|^send$/i.test(icon)) score+=500;
          if (r.bottom > window.innerHeight-220) score+=350;
          if (r.right > window.innerWidth-180) score+=250;
          candidates.push({el,score,aria,title,icon});
        }
      }
    }

    for (const icon of [...document.querySelectorAll('[data-icon="wds-ic-send-filled"],[data-icon="send"]')].filter(visible)) {
      const clickable=getClickable(icon);
      if (!clickable || seen.has(clickable)) continue;
      seen.add(clickable);
      const r=clickable.getBoundingClientRect();
      candidates.push({
        el:clickable,
        score:1500+(r.bottom>window.innerHeight-220?350:0)+(r.right>window.innerWidth-180?250:0),
        aria:clean(clickable.getAttribute('aria-label')),
        title:clean(clickable.getAttribute('title')),
        icon:clean(icon.getAttribute('data-icon'))
      });
    }

    candidates.sort((a,b)=>b.score-a.score);
    const best=candidates[0]?.el || null;
    if (!best) return null;
    const clickable=getClickable(best) || best;
    if (!visible(clickable)) return null;

    debugLog('SEND_BUTTON_FOUND',{
      tag:clickable.tagName,
      aria:clickable.getAttribute('aria-label'),
      title:clickable.getAttribute('title'),
      icon:best.getAttribute('data-icon'),
      testid:clickable.getAttribute('data-testid')
    });
    return clickable;
  }

  function countVisibleTextOccurrences(root, name) {
    if (!root || !name) return 0;
    const needle = String(name);
    let count = 0;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) {
      const parent = node.parentElement;
      if (!visible(parent)) continue;
      if (parent.closest('[role="dialog"], [data-animate-modal-popup], [data-testid*="drawer"], footer')) continue;
      const text = String(node.nodeValue || '');
      if (!text) continue;
      let at = 0;
      while ((at = text.indexOf(needle, at)) !== -1) {
        count++;
        at += Math.max(needle.length, 1);
      }
    }
    return count;
  }


  function captureOutgoingState(text = '', attachments = []) {
    const main = document.querySelector('#main');
    if (!main) return { textHits: 0, textOccurrences: 0, filenameHits: 0, filenameOccurrences: 0, mediaHits: 0, documentHits: 0, outgoingNodes: 0, rowCount: 0, mainTextLength: 0 };
    const expected = norm(text);
    const names = attachments.map(a => clean(a.name)).filter(Boolean);

    // Query outgoing messages strictly within #main, excluding open dialogs/drawers/footers
    const outgoing = [...main.querySelectorAll('.message-out, [data-pre-plain-text], [data-id*="true_"], [data-id*="out_"], [role="row"], [data-id]')]
      .filter(visible)
      .filter(el => !el.closest('[role="dialog"], [data-animate-modal-popup], [data-testid*="drawer"], footer'));

    const rows = [...main.querySelectorAll('[role="row"], [data-id]')].filter(visible).filter(el => !el.closest('footer'));
    const rowCount = rows.length;

    let textHits = 0;
    let textOccurrences = 0;
    let filenameHits = 0;
    let filenameOccurrences = 0;
    let mediaHits = 0;
    let documentHits = 0;

    for (const node of outgoing) {
      const value = norm(node.innerText || node.textContent || '');
      if (expected && value === expected) textHits++;
      if (expected && value.includes(expected)) {
        let at = 0;
        while ((at = value.indexOf(expected, at)) !== -1) {
          textOccurrences++;
          at += Math.max(expected.length, 1);
        }
      }
      if (names.some(name => value.includes(name))) filenameHits++;

      const media = node.querySelectorAll('img[src], video, [data-testid*="image" i], [data-testid*="video" i], [data-testid*="media" i]').length;
      const docs = node.querySelectorAll('a[href], [data-testid*="document" i], [data-testid*="file" i]').length;
      if (media) mediaHits++;
      if (docs || names.some(name => value.includes(name))) documentHits++;
    }

    // Exclude staged attachment previews in dialogs/footers from counting against baseline
    const chatContainer = main.querySelector('[data-testid="conversation-panel-messages"], div[role="application"], .copyable-area') || main;
    for (const name of names) filenameOccurrences += countVisibleTextOccurrences(chatContainer, name);

    return {
      textHits, textOccurrences, filenameHits, filenameOccurrences, mediaHits, documentHits,
      outgoingNodes: outgoing.length, rowCount, mainTextLength: String(main.innerText || '').length
    };
  }

  function captureAttachmentComposerState() {
    const main = document.querySelector('#main');
    const sendSelected = [...document.querySelectorAll('[aria-label*="Send 1 selected" i],[aria-label*="Send selected" i]')].filter(visible).length;
    const sendButtons = [...document.querySelectorAll('button,[role="button"]')]
      .filter(visible)
      .filter(el => /^send$/i.test(clean(el.getAttribute('aria-label')) || ''))
      .length;
    const selectedFiles = [...document.querySelectorAll('input[type="file"]')]
      .reduce((n, el) => n + (el.files?.length || 0), 0);
    const captionEditors = main ? [...main.querySelectorAll('[contenteditable="true"],[contenteditable="plaintext-only"],textarea')]
      .filter(visible)
      .filter(el => /type a message|caption|message/i.test(clean(`${el.getAttribute('aria-label')||''} ${el.getAttribute('data-placeholder')||''} ${el.getAttribute('placeholder')||''}`))).length : 0;
    const mediaEditControls = main ? [...main.querySelectorAll('button,[role="button"]')]
      .filter(visible)
      .filter(el => /crop|rotate|draw|sticker|text|edit/i.test(clean(`${el.getAttribute('aria-label')||''} ${el.getAttribute('title')||''} ${el.getAttribute('data-testid')||''}`))).length : 0;
    const mediaPreview = main ? [...main.querySelectorAll('img,video')].filter(visible).length : 0;
    return { sendSelected, sendVisible: sendSelected > 0 || sendButtons > 0, selectedFiles, captionEditors, mediaEditControls, mediaPreview };
  }

  function clickLikeUser(el) {
    if (!el) return;
    try { el.focus(); } catch (_) {}
    const rect = el.getBoundingClientRect();
    const clientX = Math.round(rect.left + Math.max(1, rect.width / 2));
    const clientY = Math.round(rect.top + Math.max(1, rect.height / 2));
    const eventInit = {
      bubbles: true,
      cancelable: true,
      composed: true,
      view: window,
      detail: 1,
      screenX: window.screenX + clientX,
      screenY: window.screenY + clientY,
      clientX,
      clientY,
      button: 0,
      buttons: 1
    };

    try { el.dispatchEvent(new PointerEvent('pointerdown', { ...eventInit, pointerType: 'mouse', isPrimary: true })); } catch (_) {}
    try { el.dispatchEvent(new MouseEvent('mousedown', eventInit)); } catch (_) {}
    try { el.dispatchEvent(new PointerEvent('pointerup', { ...eventInit, pointerType: 'mouse', isPrimary: true, buttons: 0 })); } catch (_) {}
    try { el.dispatchEvent(new MouseEvent('mouseup', { ...eventInit, buttons: 0 })); } catch (_) {}
    try { el.dispatchEvent(new MouseEvent('click', { ...eventInit, buttons: 0 })); } catch (_) {}
  }

  async function sendMessage(payload, beforeState) {
    const hasAttachment = !!(payload.attachments?.length);
    const expectedText = String(payload.text ?? '').replace(/\r\n?/g, '\n').trim();
    await sleep(400);

    if (hasAttachment) {
      if (expectedText) {
        let captionBox = findCaptionComposer();
        if (!captionBox) {
          const captionDeadline = Date.now() + 5000;
          while (Date.now() < captionDeadline) {
            await sleep(200);
            captionBox = findCaptionComposer();
            if (captionBox) break;
          }
        }
        if (!captionBox) {
          const err = new Error('WhatsApp caption editor was not found in preview dialog.');
          err.noRetry = false;
          err.stage = 'attach-files';
          throw err;
        }
        await clearEditor(captionBox);
        const setOk = await setEditorText(captionBox, expectedText);
        if (!setOk) {
          const err = new Error('WhatsApp editor did not accept the exact scheduled text.');
          err.noRetry = false;
          err.stage = 'attach-files';
          throw err;
        }
        debugLog('ATTACHMENT_CAPTION_FILLED', { expectedText });
      }

      let button = null;
      const sendButtonDeadline = Date.now() + 10000;
      while (Date.now() < sendButtonDeadline) {
        button = findAttachmentSendButton() || findSendButton();
        if (button && visible(button) && !button.disabled && button.getAttribute('aria-disabled') !== 'true') {
          break;
        }
        await sleep(250);
      }

      if (!button || button.disabled || button.getAttribute('aria-disabled') === 'true') {
        const err = new Error('WhatsApp attachment Send button was not found.');
        err.noRetry = false;
        err.stage = 'attach-files';
        throw err;
      }

      // CHANGE 4: verify the file count before pressing Send
      const sendAria = clean(button.getAttribute('aria-label') || '');
      const countMatch = sendAria.match(/send\s+(\d+)\s+selected/i);
      if (countMatch) {
        const n = parseInt(countMatch[1], 10);
        const expectedCount = payload.attachments.length;
        if (n !== expectedCount) {
          debugLog('ATTACHMENT_COUNT_MISMATCH', { countInPreview: n, expectedCount, sendAria });
          await cleanupEditorAndDialogs();
          const err = new Error(`Preview has ${n} items, expected ${expectedCount}`);
          err.stage = 'attach-files';
          err.noRetry = false;
          throw err;
        }
      }

      debugLog('ATTACHMENT_SEND_BUTTON_CLICK', {
        aria: button.getAttribute('aria-label'),
        title: button.getAttribute('title'),
        testid: button.getAttribute('data-testid')
      });

      const sendButton = button;
      currentJobSendPressed = true;
      sendButton.click();

      // CHANGE 5: element-based send confirmation (no false failures, no re-clicks)
      const deadline = Date.now() + 15000;
      let retryClicked = false;
      const retryTime = Date.now() + 4000;

      while (Date.now() < deadline) {
        await sleep(200);

        const closed = !document.contains(sendButton) || !visible(sendButton);
        if (closed) {
          debugLog('ATTACHMENT_SEND_CONFIRMED', { durationMs: Date.now() - (deadline - 15000) });
          const after = captureOutgoingState(expectedText, payload.attachments || []);
          debugLog('ATTACHMENT_SEND_ROW_DIAGNOSTICS', {
            beforeRowCount: beforeState?.rowCount || 0,
            afterRowCount: after.rowCount
          });
          return true;
        }

        const rejection = getAttachmentRejection();
        if (rejection) {
          const e = new Error(`WhatsApp rejected one or more attachments: ${rejection}`);
          e.noRetry = true;
          e.stage = 'send-message';
          throw e;
        }

        if (!retryClicked && Date.now() >= retryTime) {
          if (document.contains(sendButton) && visible(sendButton)) {
            retryClicked = true;
            debugLog('ATTACHMENT_SEND_RETRY_CLICK', {
              aria: sendButton.getAttribute('aria-label'),
              connected: document.contains(sendButton),
              visible: visible(sendButton)
            });
            sendButton.click();
          }
        }
      }

      const isConnected = document.contains(sendButton);
      const isVis = visible(sendButton);
      const e = new Error(`WhatsApp attachment Send was clicked but Send button is still present after 15s (connected: ${isConnected}, visible: ${isVis}).`);
      e.noRetry = true;
      e.stage = 'send-message';
      throw e;
    }

    const button = findSendButton();
    if (!button) throw new Error('WhatsApp Send button was not found after preparing the message.');
    if (button.disabled || button.getAttribute('aria-disabled') === 'true') {
      throw new Error('WhatsApp Send button is disabled.');
    }

    if (currentJobSendPressed) {
      debugLog('SEND_BUTTON_CLICK_SKIPPED', { reason: 'already_pressed_in_current_job' });
    } else {
      currentJobSendPressed = true;
      debugLog('SEND_BUTTON_CLICK_START', {
        aria: button.getAttribute('aria-label'), title: button.getAttribute('title'),
        testid: button.getAttribute('data-testid'), disabled: !button.disabled
      });
      button.click();
    }

    const textDeadline = Date.now() + 10000;
    while (Date.now() < textDeadline) {
      await sleep(200);
      const editor = findComposer();
      const text = editor ? norm(readEditor(editor)) : '';
      if (!text) {
        await sleep(350);
        debugLog('SEND_COMPLETE_TEXT_CLEARED', { composerEmpty: true });
        return true;
      }
    }

    const e = new Error('WhatsApp Send was clicked but composer text was not cleared.');
    e.noRetry = true;
    e.stage = 'send-message';
    throw e;
  }

  async function cleanupEditorAndDialogs() {
    try {
      const composer = findComposer();
      if (composer && norm(readEditor(composer))) {
        await clearEditor(composer);
      }
    } catch (_) {}
    try {
      const caption = findCaptionComposer();
      if (caption && norm(readEditor(caption))) {
        await clearEditor(caption);
      }
    } catch (_) {}

    const escInit = { key: 'Escape', code: 'Escape', keyCode: 27, which: 27, bubbles: true, cancelable: true, composed: true };
    const deadline = Date.now() + 5000;

    while (Date.now() < deadline) {
      const remainingSend = [...document.querySelectorAll('button, [role="button"], [aria-label]')]
        .filter(visible)
        .filter(el => !el.closest('footer'))
        .find(el => /^Send( \d+ selected)?$/i.test(clean(el.getAttribute('aria-label') || '')));

      if (!remainingSend && !isPreviewOpen()) {
        break;
      }

      try {
        const closeBtns = [...document.querySelectorAll('button, [role="button"], [aria-label]')]
          .filter(visible)
          .filter(el => !el.closest('footer'))
          .filter(el => {
            const meta = clean(`${el.getAttribute('aria-label') || ''} ${el.getAttribute('title') || ''} ${el.getAttribute('data-testid') || ''} ${el.getAttribute('data-icon') || ''}`).toLowerCase();
            return /close|back|cancel|dismiss|x\b/.test(meta) && !isCallControl(el);
          });
        for (const btn of closeBtns) {
          try { btn.click(); } catch (_) {}
        }
      } catch (_) {}

      try {
        document.dispatchEvent(new KeyboardEvent('keydown', escInit));
        document.dispatchEvent(new KeyboardEvent('keyup', escInit));
      } catch (_) {}

      await sleep(500);

      try {
        document.dispatchEvent(new KeyboardEvent('keydown', escInit));
        document.dispatchEvent(new KeyboardEvent('keyup', escInit));
      } catch (_) {}

      await sleep(200);
    }
  }

  async function sendScheduledMessage(payload) {
    let success = false;
    const startTime = Date.now();
    const run = async (stage, fn) => {
      const stageStart = Date.now();
      try {
        debugLog('SEND_STAGE_START', { stage, contact: payload.contact?.name });
        const result = await fn();
        debugLog('SEND_STAGE_OK', { stage, durationMs: Date.now() - stageStart, contact: payload.contact?.name });
        return result;
      } catch (error) {
        debugLog('SEND_STAGE_ERROR', { stage, durationMs: Date.now() - stageStart, error: error?.message || String(error), contact: payload.contact?.name });
        const wrapped = new Error(error?.message || String(error));
        wrapped.stage = error?.stage || stage;
        wrapped.noRetry = !!error?.noRetry;
        throw wrapped;
      }
    };

    try {
      currentJobSendPressed = false;
      currentJobDropAttempted = false;
      attachmentsAssigned = false;
      await sleep(350);
      await run('open-contact', () => openContact(payload.contact));

      // Before the first insert of every job, clear composer so drafts left from earlier failures can never be prepended or duplicated
      const initialComposer = findComposer();
      if (initialComposer) {
        await clearEditor(initialComposer);
      }

      const beforeState = captureOutgoingState(payload.text, payload.attachments || []);

      if (payload.attachments?.length) {
        await run('attach-files', () => attachFiles(payload.attachments));
      }
      if (!payload.attachments?.length && payload.text) {
        await run('type-message', () => typeIntoVerifiedEditor(findComposer, payload.text, 'message'));
      }

      await run('send-message', () => sendMessage(payload, beforeState));
      debugLog('SEND_COMPLETE', { durationMs: Date.now() - startTime, contact: payload.contact?.name });
      success = true;
      return { success: true };
    } finally {
      if (!success) {
        await cleanupEditorAndDialogs();
      }
    }
  }


  const RUNTIME_LISTENER_KEY='__WA_SCHEDULER_RUNTIME_LISTENER__';
  const previousController=window[RUNTIME_LISTENER_KEY];
  try { previousController?.teardown?.(); } catch (_) {}
  const onRuntimeMessage=(message,sender,sendResponse)=>{
    (async () => {
      try {
        switch (message.type) {
          case 'PING':
            sendResponse({ success: true, ready: true, version: EXTENSION_VERSION });
            break;
          case 'DIAGNOSTICS':
            sendResponse({
              success: true,
              href: location.href,
              title: document.title,
              readyState: document.readyState,
              current: getCurrentChat(),
              main: !!document.querySelector('#main'),
              header: !!document.querySelector('#main header'),
              sidebar: !!document.querySelector('#pane-side'),
              searchInputs: [...document.querySelectorAll('input')].filter(visible).map(x => ({ placeholder: x.placeholder, aria: x.getAttribute('aria-label') })).slice(0, 20),
              contentEditables: [...document.querySelectorAll('[contenteditable="true"]')].filter(visible).length,
              fileInputs: [...document.querySelectorAll('input[type="file"]')].filter(visible).length,
              headerCandidates: (() => {
                const h = document.querySelector('#main header');
                if (!h) return [];
                return [...h.querySelectorAll('[title], [aria-label], [data-testid]')]
                  .filter(visible)
                  .slice(0, 80)
                  .map(el => ({
                    tag: el.tagName,
                    text: clean(el.textContent).slice(0, 120),
                    title: clean(el.getAttribute('title')),
                    aria: clean(el.getAttribute('aria-label')),
                    testid: clean(el.getAttribute('data-testid')),
                    role: clean(el.getAttribute('role'))
                  }));
              })()
            });
            break;
          case 'GET_CURRENT_CHAT':
            sendResponse({ success: true, ...getCurrentChat() });
            break;
          case 'GET_CONTACTS':
            sendResponse({ success: true, contacts: getContacts(), current: getCurrentChat() });
            break;
          case 'OPEN_CONTACT':
            await openContact({ name: message.name });
            sendResponse({ success: true, current: getCurrentChat() });
            break;
          case 'SEND_SCHEDULED_MESSAGE': {
            // Scheduled alarms can fire at the same moment. Do not turn a
            // legitimate second job into a permanent failure just because the
            // first job is still typing/uploading. Serialize sends in this tab.
            const runAfterPrevious = sendQueue.then(async () => {
              activeSend = true;
              try { return await sendScheduledMessage(message.payload); }
              finally { activeSend = false; }
            });
            sendQueue = runAfterPrevious.catch(() => {});
            sendResponse(await runAfterPrevious);
            break;
          }
          default:
            sendResponse({ success: false, error: `Unknown command: ${message.type}` });
        }
      } catch (error) {
        console.error('[WhatsApp Scheduler]', error);
        sendResponse({ success: false, error: error?.message || String(error), stage: error?.stage || 'content-script', noRetry: !!error?.noRetry });
      }
    })();
    return true;
  };
  chrome.runtime.onMessage.addListener(onRuntimeMessage);
  window[RUNTIME_LISTENER_KEY]={version:EXTENSION_VERSION,teardown(){try{chrome.runtime.onMessage.removeListener(onRuntimeMessage);}catch(_){}}};

  // ==========================================
  // IN-CHAT SCHEDULER UI & MODAL MODULE
  // ==========================================

  const INCHAT_STYLE_ID = 'wa-sched-inchat-styles';
  const INCHAT_BTN_ID = 'wa-sched-inchat-btn';
  const INCHAT_MODAL_ROOT_ID = 'wa-sched-modal-root';

  function injectInChatStyles() {
    if (document.getElementById(INCHAT_STYLE_ID)) return;
    const style = document.createElement('style');
    style.id = INCHAT_STYLE_ID;
    style.textContent = `
      #${INCHAT_BTN_ID} {
        background: transparent;
        border: none;
        border-radius: 50%;
        width: 40px;
        height: 40px;
        min-width: 40px;
        min-height: 40px;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        align-self: center;
        cursor: pointer;
        color: var(--icon, #8696a0);
        transition: color 0.15s ease, background-color 0.15s ease, transform 0.15s ease;
        margin: 0 4px;
        padding: 8px;
        flex-shrink: 0;
        box-sizing: border-box;
        line-height: 0;
      }
      body.dark #${INCHAT_BTN_ID} {
        color: var(--icon, #aebac1);
      }
      #${INCHAT_BTN_ID}:hover {
        background-color: rgba(134, 150, 160, 0.12);
        color: #00a884;
        transform: scale(1.06);
      }
      #${INCHAT_BTN_ID}:active {
        transform: scale(0.94);
      }
      #${INCHAT_BTN_ID} svg {
        width: 24px;
        height: 24px;
        display: block;
      }

      /* In-chat Modal Overlay */
      .wa-sched-overlay {
        position: fixed;
        top: 0;
        left: 0;
        right: 0;
        bottom: 0;
        background: rgba(11, 20, 26, 0.72);
        backdrop-filter: blur(4px);
        -webkit-backdrop-filter: blur(4px);
        z-index: 999999;
        display: flex;
        align-items: center;
        justify-content: center;
        opacity: 0;
        visibility: hidden;
        transition: opacity 0.22s ease, visibility 0.22s ease;
      }
      .wa-sched-overlay.active {
        opacity: 1;
        visibility: visible;
      }

      /* In-chat Modal Card */
      .wa-sched-card {
        background: #202c33;
        color: #e9edef;
        width: 90%;
        max-width: 480px;
        border-radius: 14px;
        box-shadow: 0 16px 36px rgba(0, 0, 0, 0.45), 0 0 0 1px rgba(255, 255, 255, 0.08);
        display: flex;
        flex-direction: column;
        overflow: hidden;
        transform: scale(0.92) translateY(12px);
        transition: transform 0.25s cubic-bezier(0.16, 1, 0.3, 1);
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      }
      body:not(.dark) .wa-sched-card {
        background: #ffffff;
        color: #111b21;
        box-shadow: 0 16px 36px rgba(0, 0, 0, 0.18), 0 0 0 1px rgba(0, 0, 0, 0.08);
      }
      .wa-sched-overlay.active .wa-sched-card {
        transform: scale(1) translateY(0);
      }

      /* Header */
      .wa-sched-head {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 16px 20px;
        border-bottom: 1px solid rgba(134, 150, 160, 0.15);
      }
      .wa-sched-head-left {
        display: flex;
        align-items: center;
        gap: 12px;
      }
      .wa-sched-logo-icon {
        width: 32px;
        height: 32px;
        background: rgba(0, 168, 132, 0.15);
        border-radius: 8px;
        display: flex;
        align-items: center;
        justify-content: center;
        color: #00a884;
      }
      .wa-sched-title {
        font-size: 16px;
        font-weight: 600;
        line-height: 1.2;
      }
      .wa-sched-recipient {
        font-size: 12px;
        color: #8696a0;
        margin-top: 2px;
        display: flex;
        align-items: center;
        gap: 4px;
      }
      .wa-sched-recipient strong {
        color: #00a884;
        font-weight: 600;
      }
      .wa-sched-close-btn {
        background: transparent;
        border: none;
        color: #8696a0;
        width: 30px;
        height: 30px;
        border-radius: 50%;
        display: flex;
        align-items: center;
        justify-content: center;
        cursor: pointer;
        font-size: 16px;
        transition: background-color 0.15s;
      }
      .wa-sched-close-btn:hover {
        background: rgba(134, 150, 160, 0.15);
        color: #e9edef;
      }
      body:not(.dark) .wa-sched-close-btn:hover {
        color: #111b21;
      }

      /* Body */
      .wa-sched-body {
        padding: 18px 20px;
        display: flex;
        flex-direction: column;
        gap: 14px;
        max-height: 72vh;
        overflow-y: auto;
      }
      .wa-sched-field {
        display: flex;
        flex-direction: column;
        gap: 6px;
      }
      .wa-sched-field label {
        font-size: 12px;
        font-weight: 500;
        color: #8696a0;
        text-transform: uppercase;
        letter-spacing: 0.5px;
      }
      .wa-sched-textarea {
        background: #111b21;
        border: 1px solid rgba(134, 150, 160, 0.2);
        border-radius: 8px;
        padding: 10px 12px;
        color: inherit;
        font-size: 14px;
        font-family: inherit;
        resize: vertical;
        min-height: 80px;
        max-height: 180px;
        outline: none;
        transition: border-color 0.2s;
      }
      body:not(.dark) .wa-sched-textarea {
        background: #f0f2f5;
        border-color: rgba(0, 0, 0, 0.12);
      }
      .wa-sched-textarea:focus {
        border-color: #00a884;
      }

      /* Attachments list */
      .wa-sched-files-wrap {
        display: flex;
        flex-direction: column;
        gap: 8px;
      }
      .wa-sched-files-head {
        display: flex;
        align-items: center;
        justify-content: space-between;
      }
      .wa-sched-attach-btn {
        background: rgba(134, 150, 160, 0.12);
        border: 1px dashed rgba(134, 150, 160, 0.3);
        border-radius: 8px;
        color: inherit;
        padding: 8px 12px;
        font-size: 13px;
        cursor: pointer;
        display: inline-flex;
        align-items: center;
        gap: 6px;
        transition: all 0.15s;
      }
      .wa-sched-attach-btn:hover {
        background: rgba(0, 168, 132, 0.12);
        border-color: #00a884;
        color: #00a884;
      }
      .wa-sched-files-list {
        display: flex;
        flex-wrap: wrap;
        gap: 6px;
      }
      .wa-sched-file-tag {
        background: rgba(134, 150, 160, 0.16);
        border-radius: 6px;
        padding: 4px 8px;
        font-size: 12px;
        display: flex;
        align-items: center;
        gap: 6px;
      }
      .wa-sched-file-remove {
        cursor: pointer;
        color: #8696a0;
        font-weight: bold;
        padding: 0 2px;
      }
      .wa-sched-file-remove:hover {
        color: #ea4335;
      }

      /* Date & Time Row */
      .wa-sched-grid {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: 10px;
      }
      .wa-sched-input {
        background: #111b21;
        border: 1px solid rgba(134, 150, 160, 0.2);
        border-radius: 8px;
        padding: 8px 10px;
        color: inherit;
        font-size: 13px;
        font-family: inherit;
        outline: none;
        transition: border-color 0.2s;
        width: 100%;
        box-sizing: border-box;
      }
      body:not(.dark) .wa-sched-input {
        background: #f0f2f5;
        border-color: rgba(0, 0, 0, 0.12);
      }
      .wa-sched-input:focus {
        border-color: #00a884;
      }

      /* Presets Chips */
      .wa-sched-chips {
        display: flex;
        flex-wrap: wrap;
        gap: 6px;
      }
      .wa-sched-chip {
        background: rgba(134, 150, 160, 0.1);
        border: 1px solid rgba(134, 150, 160, 0.15);
        border-radius: 14px;
        color: #8696a0;
        padding: 4px 10px;
        font-size: 11px;
        font-weight: 500;
        cursor: pointer;
        transition: all 0.15s;
      }
      .wa-sched-chip:hover {
        background: rgba(0, 168, 132, 0.15);
        border-color: #00a884;
        color: #00a884;
      }

      /* Status message */
      .wa-sched-status {
        font-size: 12px;
        min-height: 16px;
        line-height: 1.4;
      }
      .wa-sched-status.error { color: #f15c6d; }
      .wa-sched-status.success { color: #00a884; }
      .wa-sched-status.info { color: #53bdeb; }

      /* Footer */
      .wa-sched-foot {
        display: flex;
        align-items: center;
        justify-content: flex-end;
        gap: 10px;
        padding: 14px 20px;
        border-top: 1px solid rgba(134, 150, 160, 0.15);
      }
      .wa-sched-btn {
        border: none;
        border-radius: 8px;
        padding: 9px 18px;
        font-size: 13px;
        font-weight: 600;
        cursor: pointer;
        transition: all 0.15s;
      }
      .wa-sched-btn-sec {
        background: transparent;
        color: #8696a0;
      }
      .wa-sched-btn-sec:hover {
        background: rgba(134, 150, 160, 0.12);
        color: #e9edef;
      }
      body:not(.dark) .wa-sched-btn-sec:hover {
        color: #111b21;
      }
      .wa-sched-btn-prim {
        background: #00a884;
        color: #ffffff;
      }
      .wa-sched-btn-prim:hover {
        background: #06cf9c;
        box-shadow: 0 2px 10px rgba(0, 168, 132, 0.35);
      }
      .wa-sched-btn-prim:disabled {
        opacity: 0.5;
        cursor: not-allowed;
      }

      /* Toast */
      .wa-sched-toast {
        position: fixed;
        top: 24px;
        left: 50%;
        transform: translateX(-50%) translateY(-20px);
        background: #00a884;
        color: #ffffff;
        padding: 10px 20px;
        border-radius: 20px;
        font-size: 13px;
        font-weight: 600;
        box-shadow: 0 8px 24px rgba(0, 0, 0, 0.3);
        z-index: 1000000;
        opacity: 0;
        pointer-events: none;
        transition: all 0.28s cubic-bezier(0.16, 1, 0.3, 1);
        display: flex;
        align-items: center;
        gap: 8px;
      }
      .wa-sched-toast.active {
        opacity: 1;
        transform: translateX(-50%) translateY(0);
      }
    `;
    document.head.appendChild(style);
  }

  let inChatModalElement = null;
  let inChatSelectedFiles = [];

  function showInChatToast(text, duration = 3500) {
    let toast = document.getElementById('wa-sched-toast');
    if (!toast) {
      toast = document.createElement('div');
      toast.id = 'wa-sched-toast';
      toast.className = 'wa-sched-toast';
      document.body.appendChild(toast);
    }
    toast.innerHTML = `<span>✓</span> <span>${clean(text)}</span>`;
    toast.classList.add('active');
    setTimeout(() => {
      toast.classList.remove('active');
    }, duration);
  }

  function padZero(n) { return String(n).padStart(2, '0'); }

  function setInChatDateTime(dateObj) {
    const dateInput = document.getElementById('wa-sched-inchat-date');
    const timeInput = document.getElementById('wa-sched-inchat-time');
    if (dateInput && timeInput) {
      dateInput.value = `${dateObj.getFullYear()}-${padZero(dateObj.getMonth() + 1)}-${padZero(dateObj.getDate())}`;
      timeInput.value = `${padZero(dateObj.getHours())}:${padZero(dateObj.getMinutes())}`;
    }
  }

  function renderInChatFileList() {
    const listEl = document.getElementById('wa-sched-inchat-files-list');
    if (!listEl) return;
    listEl.innerHTML = inChatSelectedFiles.map((file, idx) => `
      <div class="wa-sched-file-tag">
        <span>📎 ${clean(file.name).slice(0, 24)} (${(file.size / 1024 / 1024).toFixed(2)} MB)</span>
        <span class="wa-sched-file-remove" data-idx="${idx}">✕</span>
      </div>
    `).join('');

    listEl.querySelectorAll('.wa-sched-file-remove').forEach(btn => {
      btn.onclick = (e) => {
        e.stopPropagation();
        const idx = parseInt(btn.getAttribute('data-idx'), 10);
        inChatSelectedFiles.splice(idx, 1);
        renderInChatFileList();
      };
    });
  }

  function sendRuntimeMessageWithTimeout(msg, timeoutMs = 20000) {
    return new Promise((resolve, reject) => {
      let resolved = false;
      const timer = setTimeout(() => {
        if (!resolved) {
          resolved = true;
          reject(new Error('Background service worker response timed out.'));
        }
      }, timeoutMs);

      try {
        chrome.runtime.sendMessage(msg, (response) => {
          if (resolved) return;
          resolved = true;
          clearTimeout(timer);
          if (chrome.runtime.lastError) {
            reject(new Error(chrome.runtime.lastError.message || 'Extension runtime error'));
          } else {
            resolve(response);
          }
        });
      } catch (err) {
        if (!resolved) {
          resolved = true;
          clearTimeout(timer);
          reject(err);
        }
      }
    });
  }

  function fileToBase64(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        const result = String(reader.result || '');
        const commaIdx = result.indexOf(',');
        const base64 = commaIdx >= 0 ? result.slice(commaIdx + 1) : result;
        resolve(base64);
      };
      reader.onerror = () => reject(reader.error || new Error('Failed to read file'));
      reader.readAsDataURL(file);
    });
  }

  async function stageAttachmentFromContent(file, onProgress) {
    const id = crypto.randomUUID();
    const fileType = file.type || 'application/octet-stream';
    const CHUNK_SIZE = 250 * 1024;
    if (file.size <= CHUNK_SIZE) {
      if (onProgress) onProgress(30);
      const base64 = await fileToBase64(file);
      if (onProgress) onProgress(70);

      const res = await sendRuntimeMessageWithTimeout({
        type: 'STAGE_ATTACHMENT',
        id,
        name: file.name,
        fileType,
        size: file.size,
        lastModified: file.lastModified || 0,
        base64
      }, 30000);

      if (onProgress) onProgress(100);
      if (!res?.success) throw new Error(res?.error || `Failed to stage ${file.name}`);
      return { id, name: file.name, type: fileType, size: file.size, lastModified: file.lastModified || 0 };
    }

    let offset = 0;
    while (offset < file.size) {
      const slice = file.slice(offset, offset + CHUNK_SIZE);
      const chunkBase64 = await fileToBase64(slice);
      const done = (offset + slice.size) >= file.size;
      const res = await sendRuntimeMessageWithTimeout({
        type: 'STAGE_ATTACHMENT_CHUNK',
        id,
        name: file.name,
        fileType,
        size: file.size,
        lastModified: file.lastModified || 0,
        offset,
        chunkBase64,
        done
      }, 30000);
      if (!res?.success) throw new Error(res?.error || `Failed to upload chunk of ${file.name}`);
      offset += slice.size;
      if (onProgress) onProgress(Math.min(99, Math.round((offset / file.size) * 100)));
    }
    if (onProgress) onProgress(100);
    return { id, name: file.name, type: fileType, size: file.size, lastModified: file.lastModified || 0 };
  }

  function createInChatModal() {
    if (document.getElementById(INCHAT_MODAL_ROOT_ID)) return;
    injectInChatStyles();

    const root = document.createElement('div');
    root.id = INCHAT_MODAL_ROOT_ID;
    root.setAttribute('data-wa-sched-ui', 'true');
    root.innerHTML = `
      <div class="wa-sched-overlay" id="wa-sched-inchat-overlay">
        <div class="wa-sched-card" id="wa-sched-inchat-card">
          <div class="wa-sched-head">
            <div class="wa-sched-head-left">
              <div class="wa-sched-logo-icon">
                <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                  <circle cx="12" cy="12" r="9.5"></circle>
                  <polyline points="12 6.5 12 12 15.5 14"></polyline>
                </svg>
              </div>
              <div>
                <div class="wa-sched-title">Schedule Message</div>
                <div class="wa-sched-recipient" id="wa-sched-inchat-recipient">To: <strong>Loading…</strong></div>
              </div>
            </div>
            <button type="button" class="wa-sched-close-btn" id="wa-sched-inchat-close-btn">✕</button>
          </div>

          <div class="wa-sched-body">
            <div class="wa-sched-field">
              <label for="wa-sched-inchat-text">Message</label>
              <textarea id="wa-sched-inchat-text" class="wa-sched-textarea" placeholder="Type scheduled message…"></textarea>
            </div>

            <div class="wa-sched-field">
              <div class="wa-sched-files-head">
                <label>Attachments</label>
                <button type="button" class="wa-sched-attach-btn" id="wa-sched-inchat-browse-btn">
                  📎 Add File
                </button>
              </div>
              <input type="file" id="wa-sched-inchat-file-input" multiple style="display:none">
              <div class="wa-sched-files-list" id="wa-sched-inchat-files-list"></div>
            </div>

            <div class="wa-sched-grid">
              <div class="wa-sched-field">
                <label for="wa-sched-inchat-date">Date</label>
                <input type="date" id="wa-sched-inchat-date" class="wa-sched-input">
              </div>
              <div class="wa-sched-field">
                <label for="wa-sched-inchat-time">Time</label>
                <input type="time" id="wa-sched-inchat-time" class="wa-sched-input">
              </div>
            </div>

            <div class="wa-sched-chips">
              <button type="button" class="wa-sched-chip" data-preset="15m">+15 min</button>
              <button type="button" class="wa-sched-chip" data-preset="1h">+1 hr</button>
              <button type="button" class="wa-sched-chip" data-preset="3h">+3 hrs</button>
              <button type="button" class="wa-sched-chip" data-preset="tomorrow9">Tomorrow 9 AM</button>
              <button type="button" class="wa-sched-chip" data-preset="tomorrow18">Tomorrow 6 PM</button>
            </div>

            <div id="wa-sched-inchat-status" class="wa-sched-status"></div>
          </div>

          <div class="wa-sched-foot">
            <button type="button" class="wa-sched-btn wa-sched-btn-sec" id="wa-sched-inchat-cancel-btn">Cancel</button>
            <button type="button" class="wa-sched-btn wa-sched-btn-prim" id="wa-sched-inchat-submit-btn">Schedule Message</button>
          </div>
        </div>
      </div>
    `;

    document.body.appendChild(root);

    const overlay = document.getElementById('wa-sched-inchat-overlay');
    const closeBtn = document.getElementById('wa-sched-inchat-close-btn');
    const cancelBtn = document.getElementById('wa-sched-inchat-cancel-btn');
    const browseBtn = document.getElementById('wa-sched-inchat-browse-btn');
    const fileInput = document.getElementById('wa-sched-inchat-file-input');
    const submitBtn = document.getElementById('wa-sched-inchat-submit-btn');

    const closeModal = () => {
      overlay.classList.remove('active');
    };

    closeBtn.onclick = closeModal;
    cancelBtn.onclick = closeModal;
    overlay.onclick = (e) => {
      if (e.target === overlay) closeModal();
    };

    browseBtn.onclick = () => fileInput.click();
    fileInput.onchange = () => {
      if (fileInput.files?.length) {
        for (const file of fileInput.files) {
          inChatSelectedFiles.push(file);
        }
        fileInput.value = '';
        renderInChatFileList();
      }
    };

    // Preset time buttons
    root.querySelectorAll('[data-preset]').forEach(chip => {
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
        setInChatDateTime(now);
      };
    });

    submitBtn.onclick = async () => {
      const statusEl = document.getElementById('wa-sched-inchat-status');
      const text = document.getElementById('wa-sched-inchat-text').value.trim();
      const dateVal = document.getElementById('wa-sched-inchat-date').value;
      const timeVal = document.getElementById('wa-sched-inchat-time').value;
      const current = getCurrentChat();
      const contactName = current?.name || getHeaderTitle();

      if (!contactName) {
        statusEl.className = 'wa-sched-status error';
        statusEl.textContent = 'No active WhatsApp chat detected.';
        return;
      }
      if (!text && !inChatSelectedFiles.length) {
        statusEl.className = 'wa-sched-status error';
        statusEl.textContent = 'Please enter a message or attach a file.';
        return;
      }
      if (!dateVal || !timeVal) {
        statusEl.className = 'wa-sched-status error';
        statusEl.textContent = 'Please select scheduled date and time.';
        return;
      }

      const scheduledAt = new Date(`${dateVal}T${timeVal}`).getTime();
      if (!Number.isFinite(scheduledAt) || scheduledAt <= Date.now()) {
        statusEl.className = 'wa-sched-status error';
        statusEl.textContent = 'Scheduled time must be in the future.';
        return;
      }

      submitBtn.disabled = true;
      statusEl.className = 'wa-sched-status info';
      statusEl.textContent = inChatSelectedFiles.length ? 'Uploading attachments…' : 'Scheduling…';

      try {
        const stagedAttachments = [];
        for (let i = 0; i < inChatSelectedFiles.length; i++) {
          const file = inChatSelectedFiles[i];
          statusEl.textContent = `Uploading attachment ${i + 1} of ${inChatSelectedFiles.length}…`;
          const meta = await stageAttachmentFromContent(file, (pct) => {
            statusEl.textContent = `Uploading ${clean(file.name).slice(0, 16)} (${pct}%)…`;
          });
          stagedAttachments.push(meta);
        }

        statusEl.textContent = 'Saving schedule…';
        const res = await sendRuntimeMessageWithTimeout({
          type: 'CREATE_SCHEDULE',
          payload: {
            contact: { name: contactName },
            text,
            scheduledAt,
            attachments: stagedAttachments
          }
        });

        if (!res?.success) {
          statusEl.className = 'wa-sched-status error';
          statusEl.textContent = res?.error || 'Failed to schedule message.';
          return;
        }

        inChatSelectedFiles = [];
        renderInChatFileList();
        document.getElementById('wa-sched-inchat-text').value = '';
        closeModal();
        showInChatToast(`Scheduled for ${new Date(scheduledAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} to ${contactName}`);
      } catch (err) {
        statusEl.className = 'wa-sched-status error';
        statusEl.textContent = err?.message || 'Failed to schedule message.';
      } finally {
        submitBtn.disabled = false;
      }
    };

    // Close on Escape
    window.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && overlay.classList.contains('active')) {
        e.stopPropagation();
        closeModal();
      }
    }, true);
  }

  function openInChatModal() {
    try {
      createInChatModal();
      const overlay = document.getElementById('wa-sched-inchat-overlay');
      const recipientEl = document.getElementById('wa-sched-inchat-recipient');
      const textEl = document.getElementById('wa-sched-inchat-text');
      const statusEl = document.getElementById('wa-sched-inchat-status');

      const current = getCurrentChat();
      const contactName = current?.name || getHeaderTitle();
      debugLog('INCHAT_MODAL_OPEN', { contactName });

      recipientEl.innerHTML = `To: <strong>${escapeHtml(contactName || 'Current chat')}</strong>`;
      statusEl.textContent = '';
      statusEl.className = 'wa-sched-status';

      // If footer composer has text draft, import it
      const composer = findComposer();
      const draftText = composer ? readEditor(composer) : '';
      if (draftText && !textEl.value) {
        textEl.value = draftText;
      }

      inChatSelectedFiles = [];
      renderInChatFileList();

      // Default time: +10 minutes
      const defTime = new Date(Date.now() + 10 * 60 * 1000);
      setInChatDateTime(defTime);

      overlay.classList.add('active');
      setTimeout(() => {
        try { textEl.focus(); } catch (_) {}
      }, 100);
    } catch (err) {
      console.error('[WA Scheduler] Error opening in-chat modal:', err);
      debugLog('INCHAT_MODAL_ERROR', { error: err?.message || String(err) });
    }
  }

  function attachInChatButton() {
    const main = document.querySelector('#main');
    if (!main || !visible(main)) return;
    const footer = main.querySelector('footer');
    if (!footer || !visible(footer)) return;

    if (footer.querySelector(`#${INCHAT_BTN_ID}`)) return;

    injectInChatStyles();

    const btn = document.createElement('button');
    btn.id = INCHAT_BTN_ID;
    btn.type = 'button';
    btn.setAttribute('aria-label', 'Schedule message');
    btn.setAttribute('title', 'Schedule message for this chat');
    btn.setAttribute('data-wa-sched-ui', 'true');
    btn.innerHTML = `
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <circle cx="12" cy="12" r="9.5"></circle>
        <polyline points="12 6.5 12 12 15.5 14"></polyline>
      </svg>
    `;

    const handleOpen = (e) => {
      e.preventDefault();
      e.stopPropagation();
      openInChatModal();
    };

    btn.addEventListener('click', handleOpen);
    btn.addEventListener('pointerdown', (e) => e.stopPropagation());
    btn.addEventListener('mousedown', (e) => e.stopPropagation());

    // Find mic / PTT button or right button group
    const micOrSend = footer.querySelector('[data-icon="ptt"], [data-icon="mic"], [data-icon="wds-ic-mic-filled"], [data-icon="wds-ic-mic"], [data-testid*="ptt" i], [aria-label*="voice" i], [aria-label*="audio" i], [data-icon="send"], [data-icon="wds-ic-send-filled"], button[aria-label="Send"]');
    if (micOrSend) {
      const btnWrapper = micOrSend.closest('button, [role="button"]') || micOrSend;
      btnWrapper.parentElement.insertBefore(btn, btnWrapper);
    } else {
      footer.appendChild(btn);
    }
  }

  // Observe chat footer to keep in-chat button attached (debounced to avoid layout thrashing)
  let attachDebounceTimer = null;
  function scheduleAttachInChatButton() {
    if (attachDebounceTimer) return;
    attachDebounceTimer = setTimeout(() => {
      attachDebounceTimer = null;
      try { attachInChatButton(); } catch (_) {}
    }, 150);
  }

  const footerObserver = new MutationObserver(scheduleAttachInChatButton);
  try {
    const appEl = document.getElementById('app') || document.body;
    footerObserver.observe(appEl, { childList: true, subtree: true });
  } catch (_) {
    footerObserver.observe(document.body, { childList: true, subtree: true });
  }

  const footerInterval = setInterval(() => {
    try { attachInChatButton(); } catch (_) {}
  }, 2000);

  // Initial attach
  scheduleAttachInChatButton();

  // ==========================================
  // INITIALIZATION
  // ==========================================

  debugLog('CONTENT_SCRIPT_READY', { href: location.href, title: document.title, version: EXTENSION_VERSION });
})();
