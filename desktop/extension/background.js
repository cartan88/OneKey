/**
 * One Key — extension service worker.
 *
 * Owns the single native-messaging port to the One Key app and routes requests
 * from the content scripts and the popup over it. No credential is ever cached
 * here beyond a pending save, and that lives in chrome.storage.session, which
 * is memory-only and dies with the browser.
 */

const HOST = 'com.onekey.host';
const REQUEST_TIMEOUT_MS = 9000; // generous: the first request may cold-start the app
const PENDING_TTL_MS = 5 * 60 * 1000;

/** Failures that mean "the bridge could not be reached", worth telling the user. */
const BRIDGE_FAILURES = new Set([
  'HOST_UNAVAILABLE',
  'APP_NOT_RUNNING',
  'LOCKED',
  'DISABLED',
  'TIMEOUT',
]);

let port = null;
let nextId = 0;
const inflight = new Map();

// -------------------------------------------------------------- native transport

function connect() {
  if (port) return port;

  port = chrome.runtime.connectNative(HOST);

  port.onMessage.addListener((msg) => {
    // `rid` correlates the reply; `id` is reserved for vault entry ids.
    const pending = inflight.get(msg.rid);
    if (!pending) return;
    inflight.delete(msg.rid);
    clearTimeout(pending.timer);
    pending.resolve(msg);
  });

  port.onDisconnect.addListener(() => {
    const reason = chrome.runtime.lastError?.message || 'native host disconnected';
    port = null;
    // Fail every outstanding request rather than letting callers hang.
    for (const [, pending] of inflight) {
      clearTimeout(pending.timer);
      pending.resolve({ ok: false, code: 'HOST_UNAVAILABLE', message: reason });
    }
    inflight.clear();
  });

  return port;
}

/** Send one request and resolve with the host's reply (never rejects). */
function request(payload) {
  return new Promise((resolve) => {
    let p;
    try {
      p = connect();
    } catch (err) {
      resolve({ ok: false, code: 'HOST_UNAVAILABLE', message: String(err) });
      return;
    }

    const rid = ++nextId;
    const timer = setTimeout(() => {
      inflight.delete(rid);
      resolve({ ok: false, code: 'TIMEOUT', message: 'One Key did not respond.' });
    }, REQUEST_TIMEOUT_MS);

    inflight.set(rid, { resolve, timer });

    try {
      p.postMessage({ ...payload, rid });
    } catch (err) {
      inflight.delete(rid);
      clearTimeout(timer);
      port = null;
      resolve({ ok: false, code: 'HOST_UNAVAILABLE', message: String(err) });
    }
  });
}

// ---------------------------------------------------------------- pending saves

const pendingKey = (tabId) => `pending:${tabId}`;

async function setPending(tabId, data) {
  await chrome.storage.session.set({
    [pendingKey(tabId)]: { ...data, at: Date.now() },
  });
  await paintBadge(tabId, data.kind === 'problem' ? '!' : '1');
}

async function getPending(tabId) {
  const key = pendingKey(tabId);
  const stored = (await chrome.storage.session.get(key))[key];
  if (!stored) return null;
  if (Date.now() - stored.at > PENDING_TTL_MS) {
    await clearPending(tabId);
    return null;
  }
  return stored;
}

async function clearPending(tabId) {
  await chrome.storage.session.remove(pendingKey(tabId));
  await paintBadge(tabId, '');
}

async function paintBadge(tabId, text) {
  try {
    await chrome.action.setBadgeText({ tabId, text });
    if (text) await chrome.action.setBadgeBackgroundColor({ tabId, color: '#e2504b' });
  } catch {
    // Tab closed between capture and badge paint — nothing to do.
  }
}

chrome.tabs.onRemoved.addListener((tabId) => {
  chrome.storage.session.remove(pendingKey(tabId));
});

// -------------------------------------------------------------- message routing

const HANDLERS = {
  status: () => request({ type: 'status' }),

  match: ({ url }) => request({ type: 'match', url }),

  credential: ({ id, url }) => request({ type: 'credential', id, url }),

  // Generation reads nothing from the vault; it is here so a signup form can be
  // filled with a strong password without leaving the page.
  generate: ({ options }) => request({ type: 'generate', options }),

  openApp: () => request({ type: 'openApp' }),

  /**
   * A login was submitted. Ask the app whether it's new, changed, or already
   * known — only the app can answer, since only it can read the vault.
   */
  async captured({ url, username, password }, sender) {
    if (!password) return { ok: false, code: 'NO_PASSWORD' };

    const tabId = sender?.tab?.id;
    const res = await request({ type: 'checkSave', url, username, password });

    if (!res.ok) {
      // Failing quietly here is the worst option: the user typed a password
      // expecting an offer to save it, and would get silence. Remember the
      // reason so the page can say what went wrong.
      if (tabId != null && BRIDGE_FAILURES.has(res.code)) {
        await setPending(tabId, { kind: 'problem', code: res.code, message: res.message });
      }
      return res;
    }

    if (res.action === 'known') return { ok: true, action: 'known' };

    if (tabId != null) {
      await setPending(tabId, {
        kind: 'save',
        url,
        username,
        password,
        action: res.action,
        name: res.name,
      });
    }
    return { ok: true, action: res.action, name: res.name };
  },

  async pendingSave(_payload, sender) {
    const tabId = sender?.tab?.id;
    if (tabId == null) return { ok: true, pending: null };

    const pending = await getPending(tabId);
    if (!pending) return { ok: true, pending: null };

    // The password never leaves this worker; the page only needs to know what
    // to offer, or what went wrong.
    return {
      ok: true,
      pending:
        pending.kind === 'problem'
          ? { kind: 'problem', code: pending.code, message: pending.message }
          : {
              kind: 'save',
              url: pending.url,
              username: pending.username,
              action: pending.action,
              name: pending.name,
            },
    };
  },

  async confirmSave(_payload, sender) {
    const tabId = sender?.tab?.id ?? (await activeTabId());
    if (tabId == null) return { ok: false, code: 'NO_TAB' };

    const pending = await getPending(tabId);
    if (!pending || pending.kind !== 'save') return { ok: false, code: 'NOTHING_PENDING' };

    const res = await request({
      type: 'save',
      url: pending.url,
      username: pending.username,
      password: pending.password,
      name: pending.name,
    });
    if (res.ok) await clearPending(tabId);
    return res;
  },

  async dismissSave(_payload, sender) {
    const tabId = sender?.tab?.id ?? (await activeTabId());
    if (tabId != null) await clearPending(tabId);
    return { ok: true };
  },
};

async function activeTabId() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab?.id ?? null;
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const handler = HANDLERS[msg?.type];
  if (!handler) {
    sendResponse({ ok: false, code: 'UNKNOWN_REQUEST' });
    return false;
  }
  Promise.resolve(handler(msg, sender))
    .then(sendResponse)
    .catch((err) => sendResponse({ ok: false, code: 'UNEXPECTED', message: String(err) }));
  return true; // keep the channel open for the async reply
});
