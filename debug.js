const $ = id => document.getElementById(id);

async function load() {
  $('out').textContent = 'Loading diagnostic data…';
  try {
    const res = await chrome.runtime.sendMessage({ type: 'GET_DIAGNOSTICS' });
    if (!res || !res.success) {
      $('statusDot').className = 'status-dot bad';
      $('statusText').textContent = res?.error || 'Could not communicate with background service worker';
      $('out').textContent = JSON.stringify(res || { error: 'No response from service worker' }, null, 2);
      return;
    }

    const { tab, page, messages = [], logs = [] } = res;

    // Session Status
    if (tab) {
      $('tabStatus').textContent = `Tab #${tab.id} (${tab.title || 'WhatsApp'})`;
      $('statusDot').className = 'status-dot good';
      $('statusText').textContent = 'Connected to WhatsApp Web';
    } else {
      $('tabStatus').textContent = 'Not Found (Open web.whatsapp.com)';
      $('statusDot').className = 'status-dot bad';
      $('statusText').textContent = 'WhatsApp Web not open';
    }

    if (page?.success) {
      $('currentChat').textContent = page.current?.name || (page.current?.isChatOpen ? 'Active (No Name)' : 'No Chat Open');
      $('mainStatus').textContent = page.main ? 'Yes (Ready)' : 'No (Loading)';
      $('composerStatus').textContent = (page.contentEditables > 0) ? `Yes (${page.contentEditables} editable area)` : 'No';
    } else {
      $('currentChat').textContent = page?.error ? `Error: ${page.error}` : '-';
      $('mainStatus').textContent = '-';
      $('composerStatus').textContent = '-';
    }

    // Queue & Messages
    $('jobCount').textContent = messages.length;
    const pending = messages.filter(m => m.status === 'pending' || m.status === 'retrying');
    $('pendingCount').textContent = pending.length;
    $('logCount').textContent = logs.length;
    $('lastUpdated').textContent = new Date().toLocaleTimeString();

    // Raw/Structured Log View
    if (!logs.length && !messages.length) {
      $('out').textContent = JSON.stringify({ tab, page, messages, logs: 'No events logged yet.' }, null, 2);
    } else {
      $('out').textContent = JSON.stringify({
        session: { tab, page },
        scheduledMessages: messages,
        recentLogs: logs.slice(-50)
      }, null, 2);
    }
  } catch (err) {
    $('statusDot').className = 'status-dot bad';
    $('statusText').textContent = 'Extension Error';
    $('out').textContent = `Error loading diagnostics: ${err?.message || String(err)}`;
  }
}

$('refresh').onclick = () => load();
$('clear').onclick = async () => {
  if (confirm('Clear all stored diagnostic logs?')) {
    await chrome.runtime.sendMessage({ type: 'CLEAR_DEBUG_LOGS' });
    load();
  }
};

document.addEventListener('DOMContentLoaded', load);
load();
