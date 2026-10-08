(() => {
  if (window.__WA_SCHED_HOOK__) return;
  window.__WA_SCHED_HOOK__ = true;

  let armed = null;
  const origClick = HTMLInputElement.prototype.click;
  const filesSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'files').set;
  const say = (type, detail) => window.postMessage({ source: 'wa-sched-main', type, ...detail }, '*');

  window.addEventListener('message', (e) => {
    const d = e.data;
    if (e.source !== window || !d || d.source !== 'wa-sched-content') return;
    if (d.type === 'ARM') armed = { token: d.token, files: d.files, expiresAt: Date.now() + (d.ttl || 15000) };
    if (d.type === 'DISARM') armed = null;
  });

  HTMLInputElement.prototype.click = function (...args) {
    if (this.type === 'file' && armed && Date.now() < armed.expiresAt) {
      const a = armed;
      armed = null; // one-shot: the second chooser call falls through harmlessly
      const input = this;
      setTimeout(() => {
        try {
          const dt = new DataTransfer();
          a.files.forEach(f => dt.items.add(f));
          filesSetter.call(input, dt.files);
          input.dispatchEvent(new Event('input', { bubbles: true }));
          input.dispatchEvent(new Event('change', { bubbles: true }));
          say('ASSIGNED', { token: a.token, count: dt.files.length, accept: input.accept,
                            multiple: input.multiple, connected: input.isConnected });
        } catch (err) {
          say('ERROR', { token: a.token, message: String(err && err.message || err) });
        }
      }, 0);
      return; // suppress the blocked native chooser
    }
    return origClick.apply(this, args);
  };
})();
