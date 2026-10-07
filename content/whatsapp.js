(() => {
  const EXTENSION_VERSION = '1.4.33';
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  let activeSend = false;
  let sendQueue = Promise.resolve();

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

  const GENERIC_LABELS = new Set([
    'search', 'menu', 'more', 'back', 'close', 'attach', 'send',
    'search messages', 'video call', 'voice call', 'conversation info', 'profile details', 'contact info',
    'click here for contact info', 'starred messages', 'add to favorites'
  ]);

  function debugLog(message, data) {
    try {
      console.log('[WA Scheduler]', message, data ?? '');
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
      '#pane-side [aria-label][role="button"]',
      '#pane-side div[tabindex="-1"]'
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
      let name = '';
      const titleNodes = [...row.querySelectorAll('span[title], [title]')];
      const titleNode = titleNodes.find(n => clean(n.getAttribute('title')));
      if (titleNode) name = clean(titleNode.getAttribute('title'));

      if (!name) {
        const aria = clean(row.getAttribute('aria-label'));
        if (aria) name = aria.split(',')[0].trim();
      }

      if (!name) {
        const lines = (row.innerText || '').split('\n').map(clean).filter(Boolean);
        name = lines[0] || '';
      }

      if (!name || name.length > 120) continue;
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


  function clearEditorContents(el) {
    el.focus();
    try {
      const sel = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(el);
      sel?.removeAllRanges();
      sel?.addRange(range);
      document.execCommand('delete', false);
    } catch (_) {}
    try {
      const sel = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(el);
      range.deleteContents();
      range.collapse(true);
      sel?.removeAllRanges();
      sel?.addRange(range);
    } catch (_) {}
  }

  function dispatchEditorInput(el, inputType = 'insertText', data = null) {
    try {
      el.dispatchEvent(new InputEvent('input', {
        bubbles: true, composed: true, inputType, data
      }));
    } catch (_) {
      try { el.dispatchEvent(new Event('input', { bubbles: true, composed: true })); } catch (_) {}
    }
  }

  function hardClearContentEditable(el) {
    if (!el) return false;
    el.focus();
    for (let pass = 0; pass < 3 && getComposerText(el) !== ''; pass++) {
      try { document.execCommand('selectAll', false); document.execCommand('delete', false); } catch (_) {}
      try {
        const sel = window.getSelection(); const range = document.createRange();
        range.selectNodeContents(el); sel?.removeAllRanges(); sel?.addRange(range);
        document.execCommand('delete', false);
      } catch (_) {}
      if (getComposerText(el) !== '') {
        try {
          const sel = window.getSelection(); const range = document.createRange();
          range.selectNodeContents(el); range.deleteContents(); sel?.removeAllRanges(); sel?.addRange(range);
          dispatchEditorInput(el, 'deleteContentBackward', null);
        } catch (_) {}
      }
    }
    try {
      const sel = window.getSelection(); const range = document.createRange();
      range.selectNodeContents(el); range.collapse(true); sel?.removeAllRanges(); sel?.addRange(range);
    } catch (_) {}
    return getComposerText(el) === '';
  }

  function insertExactText(el, value) {
    if (!value) return;
    el.focus();
    if (!value.includes('\n')) {
      try { document.execCommand('insertText', false, value); }
      catch (_) { el.appendChild(document.createTextNode(value)); dispatchEditorInput(el, 'insertText', value); }
      return;
    }
    const lines=value.split('\n');
    for (let i=0;i<lines.length;i++) {
      if (lines[i]) { try { document.execCommand('insertText', false, lines[i]); } catch (_) { el.appendChild(document.createTextNode(lines[i])); } }
      if (i<lines.length-1) {
        let inserted=false; try { inserted=document.execCommand('insertLineBreak', false); } catch (_) {}
        if (!inserted) { try { inserted=document.execCommand('insertParagraph', false); } catch (_) {} }
        if (!inserted) el.appendChild(document.createElement('br'));
      }
    }
    dispatchEditorInput(el, 'insertText', value);
  }

  function selectAllEditorContents(el) {
    if (!el || !document.contains(el)) return false;
    try {
      el.focus();
      const sel = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(el);
      sel?.removeAllRanges();
      sel?.addRange(range);

      // Do NOT compare Selection.toString() with our logical editor text.
      // WhatsApp's contenteditable frequently represents visual line breaks as
      // BR/div nodes, while Selection.toString() serializes those nodes
      // differently. That comparison caused valid selections to be rejected
      // and, consequently, the scheduler never reached the actual paste.
      if (!sel || sel.rangeCount !== 1) return false;
      const activeRange = sel.getRangeAt(0);
      const container = activeRange.commonAncestorContainer;
      const node = container.nodeType === Node.TEXT_NODE ? container.parentNode : container;
      return node === el || el.contains(node);
    } catch (_) { return false; }
  }

  function pasteLikeExactText(el, value) {
    if (!el || !document.contains(el)) return false;
    el.focus();

    // IMPORTANT: execCommand('insertText') already generates the browser input
    // event. Do NOT dispatch a second synthetic input event here. WhatsApp's
    // React editor can process that second event as another insertion, which
    // was the reason an 877-character message became 2,632 characters.
    if (!selectAllEditorContents(el)) return false;
    try {
      const ok = document.execCommand('insertText', false, value);
      if (ok) {
        if (editorTextMatches(getComposerText(el), value)) return true;
        awaitMicrotask();
      }
    } catch (_) {}

    // Fallback for builds where execCommand refuses multiline text. First make
    // the editor empty using one native delete operation, then write the DOM
    // once and emit exactly one input event so React sees the replacement.
    if (!selectAllEditorContents(el)) return false;
    let deleted = false;
    try { deleted = document.execCommand('delete', false); } catch (_) {}
    if (!deleted || getComposerText(el) !== '') {
      try { el.replaceChildren(); } catch (_) { try { el.textContent = ''; } catch (_) {} }
      dispatchEditorInput(el, 'deleteContentBackward', null);
    }
    if (getComposerText(el) !== '') return false;

    const lines = exactText(value).split('\n');
    for (let i = 0; i < lines.length; i++) {
      if (lines[i]) el.appendChild(document.createTextNode(lines[i]));
      if (i < lines.length - 1) el.appendChild(document.createElement('br'));
    }
    dispatchEditorInput(el, 'insertText', value);
    return editorTextMatches(getComposerText(el), value);
  }

  function awaitMicrotask() {
    // Synchronous helper used only to yield through the browser event queue
    // without adding another editor mutation.
    return true;
  }

  function replaceEditorContentsAtomically(el, value) {
    if (!el) return false;
    el.focus();
    // The old strategy required WhatsApp's React editor to acknowledge a
    // synthetic DELETE before we inserted the new message. On some current
    // builds React immediately restores the old DOM value, causing the
    // scheduler to fail with "could not be cleared safely". Replacing the
    // current selection in one edit avoids that race entirely.
    return pasteLikeExactText(el, value);
  }

  async function clearAndType(el, text) {
    if (!el) throw new Error('Input element not found.');
    const value = exactText(text);

    if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
      const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
      if (setter) setter.call(el, ''); else el.value = '';
      el.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
      if (setter) setter.call(el, value); else el.value = value;
      try { el.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true, inputType: 'insertText', data: value })); }
      catch (_) { el.dispatchEvent(new Event('input', { bubbles: true, composed: true })); }
      el.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
      return el;
    }

    let current = el;
    for (let attempt = 1; attempt <= 5; attempt++) {
      if (!document.contains(current)) current = findComposer() || el;
      if (!current) break;

      if (replaceEditorContentsAtomically(current, value)) {
        await sleep(120);
        const check = findComposer() || current;
        if (editorTextMatches(getComposerText(check), value)) return check;
        current = check;
      }

      try {
        if (hardClearContentEditable(current)) {
          insertExactText(current, value);
          dispatchEditorInput(current, 'insertText', value);
          await sleep(120);
          const check = findComposer() || current;
          if (editorTextMatches(getComposerText(check), value)) return check;
          current = check;
        }
      } catch (_) {}
      await sleep(180);
    }

    const live = findComposer() || current || el;
    const actual = getComposerText(live);
    debugLog('MESSAGE_TYPED_FAILED', { expected:value, actual, expectedLength:value.length, actualLength:actual.length, attempts:5 });
    const e = new Error('WhatsApp message editor did not accept the exact scheduled text.');
    e.noRetry = false;
    throw e;
  }

  function extractEditorText(el) {
    if (!el) return '';
    if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) return exactText(el.value || '');
    // WhatsApp's contenteditable has changed its internal div/br structure many
    // times. innerText is the browser's logical rendered-text representation and
    // is substantially safer than recursively adding a newline for every DIV.
    // The old recursive walker counted nested structural DIVs repeatedly and
    // produced 22k/44k characters from an 877-character message.
    let value = '';
    try { value = exactText(el.innerText || ''); } catch (_) {}
    if (!value) {
      try { value = exactText(el.textContent || ''); } catch (_) {}
    }
    return value.replace(/\n+$/g, '');
  }

  function getComposerText(el) {
    return extractEditorText(el);
  }

  function editorTextMatches(actual, expected) {
    const a = exactText(actual).replace(/\n+$/g, '');
    const e = exactText(expected).replace(/\n+$/g, '');
    return a === e;
  }

  function writeComposerDom(el, value) {
    if (!el || !document.contains(el)) return false;
    try {
      el.focus();
      const sel = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(el);
      sel?.removeAllRanges();
      sel?.addRange(range);
    } catch (_) {}

    // Replace the DOM in one operation. This is a fallback for WhatsApp builds
    // where execCommand/React selection handling appends instead of replacing.
    try { el.replaceChildren(); } catch (_) { try { el.textContent = ''; } catch (_) {} }
    const lines = exactText(value).split('\n');
    for (let i = 0; i < lines.length; i++) {
      if (lines[i]) el.appendChild(document.createTextNode(lines[i]));
      if (i < lines.length - 1) el.appendChild(document.createElement('br'));
    }
    dispatchEditorInput(el, 'insertText', value);
    return editorTextMatches(getComposerText(el), value);
  }

  async function typeIntoVerifiedEditor(findEditor, text, label) {
    const expected = exactText(text);
    if (!expected) return findEditor();
    let editor = findEditor();
    const deadline = Date.now() + 15000;
    while (!editor && Date.now() < deadline) { await sleep(250); editor = findEditor(); }
    if (!editor) throw new Error(`WhatsApp ${label || 'message'} editor was not found.`);

    debugLog(label === 'caption' ? 'CAPTION_COMPOSER_SELECTED' : 'MESSAGE_COMPOSER_SELECTED', {
      tag: editor.tagName, aria: editor.getAttribute('aria-label'), testid: editor.getAttribute('data-testid'),
      dataTab: editor.getAttribute('data-tab'), inDialog: !!editor.closest('[role="dialog"]'), inFooter: !!editor.closest('footer')
    });

    // Current WhatsApp Web contenteditables can process execCommand('insertText')
    // twice. That was the source of the 877 -> 1755/2632 character corruption.
    // Do NOT use execCommand or a synthetic paste here. Instead replace the
    // contenteditable DOM once and send exactly one React-compatible input event.
    for (let attempt = 1; attempt <= 4; attempt++) {
      editor = findEditor() || editor;
      if (!editor || !document.contains(editor)) { await sleep(150); continue; }
      editor.focus();

      // Clear the live React editor without using execCommand/delete, which can
      // race with React's controlled state and restore the previous value.
      try { editor.replaceChildren(); } catch (_) { try { editor.textContent = ''; } catch (_) {} }
      try {
        editor.dispatchEvent(new InputEvent('input', {
          bubbles: true, composed: true, inputType: 'deleteContentBackward', data: null
        }));
      } catch (_) {
        editor.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
      }
      await sleep(80);

      let live = findEditor() || editor;
      let current = getComposerText(live);
      if (current !== '') {
        debugLog('COMPOSER_CLEAR_RETRY', { attempt, actualLength: current.length, actual: current.slice(0, 300) });
        await sleep(200);
        continue;
      }

      // Build the exact visible text structure once. Newlines are represented by
      // BR nodes, matching what WhatsApp creates when text is pasted into its
      // contenteditable editor. No keyboard simulation and no second mutation.
      try { live.replaceChildren(); } catch (_) { live.textContent = ''; }
      const lines = expected.split('\n');
      for (let i = 0; i < lines.length; i++) {
        if (lines[i]) live.appendChild(document.createTextNode(lines[i]));
        if (i < lines.length - 1) live.appendChild(document.createElement('br'));
      }

      // Exactly ONE input event after the DOM has the final value.
      try {
        live.dispatchEvent(new InputEvent('input', {
          bubbles: true, composed: true, inputType: 'insertText', data: expected
        }));
      } catch (_) {
        live.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
      }

      await sleep(250);
      live = findEditor() || live;
      const actual = getComposerText(live);
      if (editorTextMatches(actual, expected)) {
        debugLog('MESSAGE_TYPED', {
          expectedLength: expected.length,
          actualLength: actual.length,
          exact: true,
          attempt,
          method: 'dom-replacement-single-input'
        });
        return live;
      }

      debugLog('MESSAGE_TYPED_ATTEMPT_FAILED', {
        attempt,
        expectedLength: expected.length,
        actualLength: actual.length,
        actual: actual.slice(0, 500),
        method: 'dom-replacement-single-input'
      });
      // If React transformed the node, the next attempt starts by clearing the
      // current live node. Never append to a failed attempt.
      await sleep(200);
    }

    const live = findEditor() || editor;
    const actual = getComposerText(live);
    debugLog('MESSAGE_TYPED_FAILED', {
      expected,
      actual,
      expectedLength: expected.length,
      actualLength: actual.length,
      attempts: 4
    });
    const e = new Error(`WhatsApp ${label || 'message'} editor did not accept the exact scheduled text.`);
    e.noRetry = false;
    throw e;
  }

  function findSidebarResult(name) {
    const side = document.querySelector('#side') || document.querySelector('#pane-side');
    if (!side) return null;
    const wanted = clean(name).toLowerCase();
    const candidates = [...side.querySelectorAll('[role="listitem"],[role="option"],[data-testid*="cell-frame"],[data-testid*="chat"],div[tabindex="-1"],span[title],[title]')]
      .filter(visible);
    const scored = candidates.map(el => {
      const title = clean(el.getAttribute('title'));
      const aria = clean(el.getAttribute('aria-label'));
      const text = clean(el.innerText || el.textContent);
      const vals = [title, aria, text].filter(Boolean).map(v => v.toLowerCase());
      let score = -1;
      if (vals.some(v => v === wanted)) score = 100;
      else if (vals.some(v => v.startsWith(wanted + ' ') || v.startsWith(wanted + ','))) score = 90;
      else if (vals.some(v => v.includes(wanted))) score = 50;
      return {el, score};
    }).filter(x => x.score >= 0).sort((x,y) => y.score - x.score);
    if (!scored.length) return null;
    return scored[0].el.closest('[role="listitem"],[role="option"],[data-testid*="cell-frame"],[data-testid*="chat"]') || scored[0].el;
  }

  function clickChatRow(name) {
    const row = findSidebarResult(name);
    if (!row) return false;
    row.scrollIntoView({block:'center'});
    row.dispatchEvent(new MouseEvent('mousedown',{bubbles:true,view:window}));
    row.dispatchEvent(new MouseEvent('mouseup',{bubbles:true,view:window}));
    row.click();
    return true;
  }

  async function openContact(contact) {
    const name = clean(contact?.name);
    if (!name) throw new Error('Recipient name is empty.');
    debugLog('OPEN_CONTACT', { name, current: getHeaderTitle() });
    const current = clean(getHeaderTitle());
    const currentGeneric = !current || GENERIC_LABELS.has(current.toLowerCase()) || /^(profile details|contact info|conversation info)$/i.test(current);
    if (!currentGeneric && (current.toLowerCase() === name.toLowerCase() || current.toLowerCase().includes(name.toLowerCase()) || name.toLowerCase().includes(current.toLowerCase()))) {
      if (document.querySelector('#main') && visible(document.querySelector('#main'))) {
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
    if (clickChatRow(name)) {
      debugLog('OPEN_CONTACT_VISIBLE_CHAT', { name });
      try {
        await waitForHeader(name, 3500);
        await waitForMainPane(3500);
        opened = true;
      } catch (_) {
        debugLog('OPEN_CONTACT_VISIBLE_CHAT_FAILED', { name });
      }
    }

    if (!opened) {
      const search = findSearchBox();
      if (!search) throw new Error('Recipient search box not found in WhatsApp sidebar.');
      debugLog('OPEN_CONTACT_RECIPIENT_SEARCH', {
        name,
        tag: search.tagName,
        placeholder: search.getAttribute('placeholder') || search.getAttribute('data-placeholder'),
        aria: search.getAttribute('aria-label')
      });
      await clearAndType(search, name);
      await sleep(1500);

      if (!clickChatRow(name)) {
        const result = findSidebarResult(name);
        if (result) {
          result.click();
        } else {
          search.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true }));
        }
      }

      await waitForHeader(name, 8000);
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

  async function waitForHeader(expected, timeout = 7000) {
    const wanted = clean(expected).toLowerCase().replace(/\s+/g, '');
    const start = Date.now();
    while (Date.now() - start < timeout) {
      const current = clean(getHeaderTitle()).toLowerCase().replace(/\s+/g, '');
      const main = document.querySelector('#main');
      if (main && visible(main) && current && (current === wanted || current.includes(wanted) || wanted.includes(current))) return;
      await sleep(250);
    }
    throw new Error(`WhatsApp did not open the chat “${expected}”.`);
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

  async function typeMessage(text) {
    if (!text) return;
    const composer = await waitForComposer();
    await clearAndType(composer, text);
    await sleep(500);
    const actual = getComposerText(composer);
    debugLog('MESSAGE_TYPED', { expected: exactText(text), actual, matches: editorTextMatches(actual, exactText(text)) });
    if (!editorTextMatches(actual, exactText(text))) {
      throw new Error('WhatsApp composer did not accept the message text.');
    }
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

    // NEVER use generic text matching here. A broad "video"/"photo" match
    // can click the header's Video call button. Only accept known attachment
    // controls or a button containing an attachment icon.
    const selectors = [
      'footer button[aria-label="Attach"]',
      'footer [role="button"][aria-label="Attach"]',
      'footer button[title="Attach"]',
      'footer [role="button"][title="Attach"]',
      'footer [data-testid="clip"]',
      'footer [data-testid="attach"]',
      'footer [data-icon="attach"]',
      'footer [data-icon="attach-menu-plus"]'
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
      if (!/attach|paperclip/.test(meta)) continue;
      const button = icon.closest('button,[role="button"]');
      if (button && visible(button) && !isCallControl(button)) return button;
    }
    return null;
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

  function attachmentKind(files) {
    if (areAllMediaFiles(files)) return 'media';
    return 'document';
  }

  function findFileInput(preferredFiles = [], kind = 'document') {
    const inputs = [...document.querySelectorAll('input[type="file"]')].filter(el => !el.disabled);
    if (!inputs.length) return null;
    const isMedia = kind === 'media' || areAllMediaFiles(preferredFiles);
    const wantedTypes = preferredFiles.map(f => String(f.type || '').toLowerCase()).filter(Boolean);
    const wantedExts = preferredFiles.map(f => { const n = String(f.name || '').toLowerCase(); return n.includes('.') ? n.slice(n.lastIndexOf('.')) : ''; }).filter(Boolean);
    const contextOf = input => {
      const bits = []; let node = input;
      for (let i = 0; node && i < 4; i++, node = node.parentElement) bits.push(node.getAttribute?.('aria-label') || '', node.getAttribute?.('title') || '', node.getAttribute?.('data-testid') || '', node.getAttribute?.('data-icon') || '', node.innerText || '');
      return clean(bits.join(' ')).toLowerCase();
    };
    const score = input => {
      const accept = String(input.accept || '').toLowerCase();
      const mediaOnly = isMediaOnlyInput(input);
      const context = contextOf(input);
      let s = 0;
      if (/sticker|emoji|gif sticker/.test(context) || /sticker/.test(accept)) s -= 15000;
      if (/profile|avatar|status/.test(context)) s -= 5000;
      if (input.multiple) s += 50;

      if (isMedia) {
        if (/photos?\s*(and|&)\s*videos?|media|camera|gallery/.test(context)) s += 3000;
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
    const ranked = inputs.map(input => ({ input, score: score(input), accept: input.accept, context: contextOf(input) })).sort((a,b)=>b.score-a.score);
    debugLog('ATTACHMENT_INPUT_CANDIDATES', ranked.slice(0,10).map(x=>({score:x.score,accept:x.accept,multiple:x.input.multiple,visible:visible(x.input),context:x.context.slice(0,180)})));
    const best = ranked[0];
    if (isMedia) return best?.input || null;
    return (best && best.score > -10000) ? best.input : null;
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
    // WhatsApp's Document composer can reject a file before upload based on
    // the browser MIME classification (for example an image/jpeg or text/csv
    // assigned to the document input).  For exact-byte document delivery, the
    // MIME label is metadata; the bytes and filename are what must be preserved.
    // Present the exact same bytes/name as a generic document while retaining
    // the original MIME in diagnostics. This avoids WhatsApp routing the file
    // back through a media-specific validator.
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

  function findDocumentMenuItem() {
    const menus = [...document.querySelectorAll('[role="menu"],[role="listbox"],[data-testid*="menu" i]')].filter(visible);
    const roots = menus.length ? menus : [document.querySelector('#app') || document.body];
    const candidates = [];
    const seen = new Set();
    for (const root of roots) {
      const nodes = [...root.querySelectorAll('[role="menuitem"],[role="option"],[role="button"],button,[tabindex="0"],div,span')];
      for (const el of nodes) {
        if (seen.has(el) || !visible(el)) continue;
        seen.add(el);
        const aria=clean(el.getAttribute('aria-label')||''), title=clean(el.getAttribute('title')||'');
        const testid=clean(el.getAttribute('data-testid')||''), icon=clean(el.getAttribute('data-icon')||'');
        const own=clean(el.innerText||el.textContent||'');
        const meta=clean([aria,title,testid,icon,own].filter(Boolean).join(' ')).toLowerCase();
        if (!meta || /call|status|camera|sticker|gif|emoji/.test(meta)) continue;
        const exact=/^(document|documents|doc)$/i.test(own) || /^(document|documents|doc)$/i.test(aria);
        const word=/\bdocument\b/i.test(meta), iconMatch=/document|attach-document|file-document/i.test(`${icon} ${testid}`);
        if (!exact && !word && !iconMatch) continue;
        const r=el.getBoundingClientRect();
        if (r.width<=0 || r.height<=0 || r.width>600 || r.height>250) continue;
        let score=0;
        if (exact) score+=5000;
        if (iconMatch) score+=2500;
        if (el.getAttribute('role')==='menuitem') score+=1200;
        if (el.getAttribute('role')==='option') score+=900;
        if (menus.includes(root)) score+=800;
        if (word) score+=700;
        candidates.push({el,score,own,aria,testid});
      }
    }
    candidates.sort((a,b)=>b.score-a.score);
    debugLog('DOCUMENT_MENU_CANDIDATES', candidates.slice(0,10).map(x=>({score:x.score,ownText:x.own,aria:x.aria,testid:x.testid,tag:x.el.tagName,role:x.el.getAttribute('role')})));
    if (candidates[0]?.el) return candidates[0].el.closest('button,[role="button"],[role="menuitem"],[role="option"]') || candidates[0].el;
    return null;
  }

  function isMediaOnlyInput(input) {
    const accept = String(input?.accept || '').toLowerCase().replace(/\s+/g,'');
    if (!accept || accept === '*' || accept === '*/*') return false;
    return /(^|,)(image\/\*|video\/\*)(,|$)/.test(accept) && !/application\/|text\/|\*\/\*|^\*$/.test(accept);
  }

  function rankDocumentInput(inputs) {
    const ranked = inputs.filter(el => el && !el.disabled && el.type === 'file' && !isMediaOnlyInput(el)).map(input => {
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
    const main = document.querySelector('#main');
    const footer = main?.querySelector('footer');
    const app = document.querySelector('#app');
    const targets = [footer, main, app, document.body].filter(Boolean).filter(visible);
    if (!targets.length) return false;

    const before = captureAttachmentState(files);
    debugLog('ATTACHMENT_DROP_BASELINE', before);

    const transfer = new DataTransfer();
    for (const file of files) transfer.items.add(file);
    try { transfer.effectAllowed = 'copy'; } catch (_) {}
    try { transfer.dropEffect = 'copy'; } catch (_) {}

    for (const target of targets) {
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
      debugLog('ATTACHMENT_DROP_DISPATCHED', {tag: target.tagName, className: String(target.className || '').slice(0,120)});
    }

    const deadline = Date.now() + 6000;
    while (Date.now() < deadline) {
      await sleep(250);
      const rejection = getAttachmentRejection();
      if (rejection) {
        debugLog('ATTACHMENT_DROP_REJECTED', {message: rejection});
        return false;
      }
      const pending = captureAttachmentComposerState();
      const state = captureAttachmentState(files);
      if (pending.sendVisible || findAttachmentSendButton() || attachmentStateChanged(before, state)) {
        debugLog('ATTACHMENT_DROP_PREVIEW_READY', {before, state, pending});
        return true;
      }
    }
    return false;
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
    const isMedia = kind === 'media';

    const before = captureAttachmentState(files);
    debugLog('ATTACHMENT_RENDER_BASELINE', before);

    const attachButton = findAttachButton();
    if (attachButton) {
      debugLog('ATTACH_BUTTON_CLICK', {
        aria: attachButton.getAttribute('aria-label'),
        title: attachButton.getAttribute('title'),
        testid: attachButton.getAttribute('data-testid'),
        icon: attachButton.getAttribute('data-icon')
      });
      clickLikeUser(attachButton);
      await sleep(350);
    }

    let input = findFileInput(files, kind) || (isMedia ? document.querySelector('input[type="file"]') : rankDocumentInput([...document.querySelectorAll('input[type="file"]')]));

    if (!input && attachButton) {
      for (let attempt = 0; attempt < 4; attempt++) {
        await sleep(250);
        input = findFileInput(files, kind) || (isMedia ? document.querySelector('input[type="file"]') : rankDocumentInput([...document.querySelectorAll('input[type="file"]')]));
        if (input) break;
      }
    }

    // Strictly ensure non-media documents are not fed into media-only inputs
    if (!isMedia && input && isMediaOnlyInput(input)) {
      debugLog('ATTACHMENT_MEDIA_INPUT_REJECTED_FOR_DOCUMENT', { accept: input.accept });
      input = rankDocumentInput([...document.querySelectorAll('input[type="file"]')]);
    }

    if (input) {
      debugLog('ATTACHMENT_INPUT_SELECTED', {
        accept: input.accept,
        multiple: input.multiple,
        connected: input.isConnected,
        visible: visible(input)
      });

      try {
        try { input.value = ''; } catch (_) {}
        const transfer = new DataTransfer();
        for (const file of files) transfer.items.add(file);
        input.files = transfer.files;

        try { input.dispatchEvent(new Event('input', { bubbles: true, composed: true })); } catch (_) {}
        try { input.dispatchEvent(new Event('change', { bubbles: true, composed: true })); } catch (_) {}

        const assigned = [...(input.files || [])];
        if (assigned.length === files.length) {
          debugLog('ATTACHMENT_INPUT_ASSIGNED', {
            count: assigned.length,
            names: assigned.map(f => f.name),
            sizes: assigned.map(f => f.size),
            types: assigned.map(f => f.type),
            accept: input.accept
          });
        }

        const deadline = Date.now() + 6000;
        let rejected = false;
        while (Date.now() < deadline) {
          const rejection = getAttachmentRejection();
          if (rejection) {
            debugLog('ATTACHMENT_REJECTED_ON_INPUT', { message: rejection, names: files.map(f => f.name) });
            rejected = true;
            try { input.value = ''; } catch (_) {}
            break;
          }
          const pending = captureAttachmentComposerState();
          const selectedCount = [...document.querySelectorAll('input[type="file"]')]
            .reduce((n, el) => n + (el.files?.length || 0), 0);
          const state = captureAttachmentState(files);
          if ((selectedCount >= files.length || pending.sendVisible || findAttachmentSendButton() || attachmentStateChanged(before, state)) && (pending.sendVisible || findAttachmentSendButton())) {
            debugLog('ATTACHMENT_PREVIEW_READY', { kind, before, pending, selectedCount });
            return;
          }
          await sleep(250);
        }

        if (!rejected) {
          const pending = captureAttachmentComposerState();
          if (pending.sendVisible || findAttachmentSendButton()) {
            debugLog('ATTACHMENT_PREVIEW_READY_AFTER_WAIT', { kind, before, pending });
            return;
          }
        }
      } catch (inputErr) {
        debugLog('ATTACHMENT_INPUT_ERROR', { error: inputErr?.message || String(inputErr) });
      }
    }

    // Fallback: If input was unavailable, or assigning didn't activate the composer, use drag-and-drop
    debugLog('ATTACHMENT_FALLBACK_DROP_ATTEMPT', { fileCount: files.length });
    const dropSucceeded = await attachFilesViaDrop(files);
    if (dropSucceeded) {
      debugLog('ATTACHMENT_DROP_SUCCESS', { fileCount: files.length });
      return;
    }

    const rejection = getAttachmentRejection();
    if (rejection) {
      debugLog('ATTACHMENT_REJECTED_BY_WHATSAPP', { message: rejection, names: files.map(f => f.name) });
      const e = new Error(`WhatsApp rejected the attachment: ${rejection}`); e.noRetry = true; throw e;
    }

    throw new Error('WhatsApp could not attach the scheduled file(s). Please ensure WhatsApp Web chat is fully loaded.');
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
    const main = document.querySelector('#main');
    const dialogs = [...document.querySelectorAll('[role="dialog"]')].filter(visible);
    const scopes = [...dialogs, ...(main && visible(main) ? [main] : [])];
    const candidates = [];
    const seen = new Set();

    for (const scope of scopes) {
      for (const el of scope.querySelectorAll('[contenteditable="true"],[contenteditable="plaintext-only"],textarea')) {
        if (seen.has(el) || !visible(el)) continue;
        seen.add(el);
        const meta = clean([
          el.getAttribute('aria-label'), el.getAttribute('data-placeholder'),
          el.getAttribute('placeholder'), el.getAttribute('data-testid'),
          el.getAttribute('data-tab')
        ].filter(Boolean).join(' ')).toLowerCase();
        const r = el.getBoundingClientRect();
        let score = 0;
        const container = el.closest('[role="dialog"]') || el.parentElement;
        const containerText = clean(container?.innerText || '').toLowerCase();
        if (el.closest('[role="dialog"]')) score += 1800;
        if (/caption|add a caption/.test(meta)) score += 2000;
        if (/caption|add a caption/.test(containerText)) score += 700;
        if (/type a message|message/.test(meta)) score += 500;
        if (el.getAttribute('contenteditable')) score += 250;
        if (r.bottom > window.innerHeight - 220) score += 150;
        if (main?.contains(el)) score += 100;
        // The ordinary footer editor is a fallback only. If a dialog/caption
        // editor exists, it must win.
        if (el.closest('footer')) score -= 400;
        candidates.push({ el, score, meta, dialog: !!el.closest('[role="dialog"]') });
      }
    }

    candidates.sort((a, b) => b.score - a.score);
    const best = candidates[0]?.el || null;
    debugLog(best ? 'CAPTION_COMPOSER_FOUND' : 'CAPTION_COMPOSER_NOT_FOUND', best ? {
      score: candidates[0].score,
      aria: best.getAttribute('aria-label'),
      placeholder: best.getAttribute('data-placeholder') || best.getAttribute('placeholder'),
      testid: best.getAttribute('data-testid'),
      dataTab: best.getAttribute('data-tab'),
      inDialog: !!best.closest('[role="dialog"]'),
      inFooter: !!best.closest('footer')
    } : { count: candidates.length });
    return best;
  }

  function getClickable(el) {
    if (!el) return null;
    const clickable = el.closest('button,[role="button"],[tabindex="0"]');
    return clickable && visible(clickable) ? clickable : (visible(el) ? el : null);
  }

  function findAttachmentSendButton() {
    const main = document.querySelector('#main');
    if (!main || !visible(main)) return null;

    // In the current WhatsApp media composer there are two different kinds of
    // "send" controls: the ordinary chat composer button (aria-label="Send")
    // and the media-composer control which may be exposed as
    // "Send 1 selected". For an attachment job we MUST prefer the latter.
    const nodes = [...document.querySelectorAll(
      '[aria-label^="Send"][aria-label*="selected" i],\n' +
      '[aria-label*="Send 1 selected" i],\n' +
      '[data-testid*="send-selected" i],\n' +
      '[data-testid*="media-send" i]'
    )].filter(visible);

    const caption = findCaptionComposer();
    const cr = caption?.getBoundingClientRect();
    const candidates = [];
    const seen = new Set();

    for (const node of nodes) {
      const button = getClickable(node);
      if (!button || seen.has(button)) continue;
      seen.add(button);
      const r = button.getBoundingClientRect();
      let score = 2000;
      if (main.contains(button)) score += 500;
      if (/send\s*\d+\s*selected/i.test(clean(node.getAttribute('aria-label')))) score += 1200;
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
      if (!visible(node.parentElement)) continue;
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
    if (!main) return { textHits: 0, textOccurrences: 0, filenameHits: 0, filenameOccurrences: 0, mediaHits: 0, documentHits: 0, outgoingNodes: 0, mainTextLength: 0 };
    const expected = exactText(text);
    const names = attachments.map(a => clean(a.name)).filter(Boolean);
    const outgoing = [...main.querySelectorAll('.message-out, [data-pre-plain-text]')].filter(visible);
    let textHits = 0;
    let textOccurrences = 0;
    let filenameHits = 0;
    let filenameOccurrences = 0;
    let mediaHits = 0;
    let documentHits = 0;

    for (const node of outgoing) {
      const value = exactText(node.innerText || node.textContent || '');
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

    // WhatsApp's current document message markup does not reliably expose a
    // stable .message-out/document test id. Count exact filename occurrences
    // in the visible chat as a second, independent signal. The baseline is
    // captured BEFORE sending, so an increase proves that a new copy appeared
    // without depending on WhatsApp's private class names.
    for (const name of names) filenameOccurrences += countVisibleTextOccurrences(main, name);

    return {
      textHits, textOccurrences, filenameHits, filenameOccurrences, mediaHits, documentHits,
      outgoingNodes: outgoing.length, mainTextLength: String(main.innerText || '').length
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
    try { el.dispatchEvent(new PointerEvent('pointerdown', {bubbles:true, composed:true, pointerType:'mouse', button:0})); } catch (_) {}
    try { el.dispatchEvent(new MouseEvent('mousedown', {bubbles:true, composed:true, view:window, button:0})); } catch (_) {}
    try { el.dispatchEvent(new MouseEvent('mouseup', {bubbles:true, composed:true, view:window, button:0})); } catch (_) {}
    try { el.click(); } catch (_) {}
  }

  async function clickAndVerifySend(button, expectedText = '', beforeState = null, timeout = 12000) {
    if (!button || !visible(button)) throw new Error('WhatsApp Send button is not available.');
    if (button.disabled || button.getAttribute('aria-disabled') === 'true') {
      throw new Error('WhatsApp Send button is disabled.');
    }
    debugLog('SEND_BUTTON_CLICK_START', {
      aria: button.getAttribute('aria-label'), title: button.getAttribute('title'),
      testid: button.getAttribute('data-testid'), disabled: !!button.disabled
    });
    button.focus();
    // One and only one click. Repeated click synthesis can duplicate messages.
    button.click();

    const deadline = Date.now() + timeout;
    let last = null;
    while (Date.now() < deadline) {
      await sleep(250);
      const after = captureOutgoingState(expectedText, []);
      const editor = findComposer();
      const remainingText = editor ? getComposerText(editor) : '';
      last = { after, remainingTextLength: remainingText.length };

      const outgoingAdded = beforeState && after.outgoingNodes > beforeState.outgoingNodes;
      const textAppeared = expectedText && beforeState && (
        after.textOccurrences > beforeState.textOccurrences || after.textHits > beforeState.textHits
      );
      const composerCleared = !editor || !remainingText;
      if (outgoingAdded || textAppeared || composerCleared) {
        // Give WhatsApp a short settle window before declaring success. The
        // composer normally clears before the outgoing bubble is painted.
        await sleep(350);
        const settled = captureOutgoingState(expectedText, []);
        debugLog('SEND_CLICK_SETTLED', { before: beforeState, after: settled, composerCleared });
        return true;
      }
    }
    const e = new Error(`WhatsApp Send was clicked but the message was not confirmed. Last state: ${JSON.stringify(last)}`);
    e.noRetry = false;
    throw e;
  }

  async function sendMessage(payload, beforeState) {
    const hasAttachment = !!(payload.attachments?.length);
    const expectedText = exactText(payload.text ?? '');
    await sleep(400);

    if (hasAttachment) {
      const button = findAttachmentSendButton() || findSendButton();
      if (!button) throw new Error('WhatsApp attachment Send button was not found.');
      const before = captureOutgoingState('', payload.attachments || []);
      debugLog('ATTACHMENT_SEND_BUTTON_CLICK', {
        aria: button.getAttribute('aria-label'), title: button.getAttribute('title'),
        testid: button.getAttribute('data-testid'), icon: button.querySelector?.('[data-icon]')?.getAttribute('data-icon') || button.getAttribute('data-icon')
      });
      if (button.disabled || button.getAttribute('aria-disabled') === 'true') {
        throw new Error('WhatsApp attachment Send button is disabled.');
      }
      button.click();

      const deadline = Date.now() + 15000;
      let last = null;
      while (Date.now() < deadline) {
        await sleep(300);
        const after = captureOutgoingState('', payload.attachments || []);
        const pending = captureAttachmentComposerState();
        last = { after, pending };
        const rejection = getAttachmentRejection();
        const attachmentEvidence =
          after.documentHits > before.documentHits ||
          after.mediaHits > before.mediaHits ||
          after.filenameHits > before.filenameHits ||
          after.filenameOccurrences > before.filenameOccurrences ||
          after.outgoingNodes > before.outgoingNodes;
        if (rejection && !attachmentEvidence) {
          const e = new Error(`WhatsApp rejected one or more attachments: ${rejection}`); e.noRetry = true; throw e;
        }
        if (attachmentEvidence) {
          debugLog('ATTACHMENT_SEND_VERIFIED', { before, after, pending });
          if (!expectedText) return;

          // Send the scheduled text separately through the normal conversation
          // composer. This avoids WhatsApp's caption editor and preserves the
          // exact scheduled message.
          await typeIntoVerifiedEditor(findComposer, expectedText, 'message');
          const textEditor = findComposer();
          if (!textEditor || !editorTextMatches(getComposerText(textEditor), expectedText)) {
            throw new Error('WhatsApp message composer did not retain the exact scheduled text.');
          }
          const textButton = findSendButton();
          if (!textButton) throw new Error('WhatsApp Send button was not found for the scheduled message text.');
          const textBefore = captureOutgoingState(expectedText, []);
          await clickAndVerifySend(textButton, expectedText, textBefore, 12000);
          return;
        }
      }
      const e = new Error(`WhatsApp attachment Send was clicked but the attachment was not confirmed. Last state: ${JSON.stringify(last)}`);
      e.noRetry = false;
      throw e;
    }

    const button = findSendButton();
    if (!button) throw new Error('WhatsApp Send button was not found after preparing the message.');
    await clickAndVerifySend(button, expectedText, beforeState, 12000);
  }


  async function sendScheduledMessage(payload) {
    const run = async (stage, fn) => {
      try {
        debugLog('SEND_STAGE_START', { stage, contact: payload.contact?.name });
        const result = await fn();
        debugLog('SEND_STAGE_OK', { stage, contact: payload.contact?.name });
        return result;
      } catch (error) {
        debugLog('SEND_STAGE_ERROR', { stage, error: error?.message || String(error), contact: payload.contact?.name });
        const wrapped = new Error(error?.message || String(error));
        wrapped.stage = stage;
        wrapped.noRetry = !!error?.noRetry;
        throw wrapped;
      }
    };

    await sleep(350);
    await run('open-contact', () => openContact(payload.contact));

    const beforeState = captureOutgoingState(payload.text, payload.attachments || []);

    if (payload.attachments?.length) {
      await run('attach-files', () => attachFiles(payload.attachments));
    }
    if (!payload.attachments?.length && payload.text) {
      await run('type-message', () => typeIntoVerifiedEditor(findComposer, payload.text, 'message'));
    }

    await run('send-message', () => sendMessage(payload, beforeState));
    debugLog('SEND_COMPLETE', { contact: payload.contact?.name });
    return { success: true };
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

  debugLog('CONTENT_SCRIPT_READY', { href: location.href, title: document.title, version:EXTENSION_VERSION });
})();
