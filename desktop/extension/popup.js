/**
 * One Key — popup. Lists the logins the app says match the current tab and asks
 * the page's content script to do the actual filling.
 */

const $ = (id) => document.getElementById(id);

const send = (type, payload = {}) =>
  new Promise((resolve) => {
    chrome.runtime.sendMessage({ type, ...payload }, (res) => {
      if (chrome.runtime.lastError) {
        resolve({ ok: false, code: 'DISCONNECTED', message: chrome.runtime.lastError.message });
        return;
      }
      resolve(res || { ok: false, code: 'NO_RESPONSE' });
    });
  });

function setState(text, tone = '') {
  const el = $('state');
  el.textContent = text;
  el.className = 'head__state' + (tone ? ` is-${tone}` : '');
}

/**
 * `html` is a fixed string; `detail` is the underlying error, shown small and
 * muted. Without it a failed bridge is indistinguishable from a locked vault,
 * which leaves no way to tell a missing registration from a refused extension id.
 */
function message(html, detail) {
  const p = document.createElement('p');
  p.className = 'msg';
  p.innerHTML = html; // fixed strings only, never page or vault data
  const nodes = [p];

  if (detail) {
    const d = document.createElement('p');
    d.className = 'detail';
    d.textContent = detail; // textContent: this can carry arbitrary text
    nodes.push(d);
  }
  $('body').replaceChildren(...nodes);
}

/**
 * The reason behind a failure, for the muted second line — in plain words, not
 * the internal SCREAMING_SNAKE_CASE code (HOST_UNAVAILABLE, APP_NOT_RUNNING,
 * …) that code exists for main.js/background.js to branch on, not for a user
 * to read. `res.message` is already a full English sentence everywhere it's
 * set — Chrome's own wording for a connection failure, or ours for anything
 * app-side — so showing it alone is enough.
 */
function detailOf(res) {
  if (!res || res.ok || !res.message) return '';
  return res.message;
}

function describe(res) {
  switch (res.code) {
    case 'LOCKED':
      return { state: ['Locked', 'bad'], body: '<b>Your vault is locked.</b><br>Unlock One Key to fill logins.' };
    case 'APP_NOT_RUNNING':
    case 'HOST_UNAVAILABLE':
      // Locking removes the bridge, so from here a locked vault and a closed app
      // are indistinguishable. Name both possibilities.
      return {
        state: ['Locked or closed', 'bad'],
        body: '<b>One Key is locked or not running.</b><br>Open it and unlock your vault.',
      };
    case 'DISABLED':
      return {
        state: ['Integration off', 'bad'],
        body: '<b>Browser integration is turned off.</b><br>Enable it in One Key → Settings.',
      };
    case 'TIMEOUT':
      return { state: ['No response', 'bad'], body: 'One Key did not respond in time.' };
    default:
      return { state: ['Unavailable', 'bad'], body: res.message || 'One Key could not be reached.' };
  }
}

async function currentTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab || null;
}

async function fill(tab, item) {
  const res = await new Promise((resolve) => {
    chrome.tabs.sendMessage(tab.id, { type: 'fillFromPopup', id: item.id }, (r) => {
      if (chrome.runtime.lastError) {
        const raw = chrome.runtime.lastError.message || '';
        // Two different situations arrive as one opaque failure here. Frames with
        // no password field stay silent on purpose (so a frame that has one can
        // answer), and Chrome reports that silence as "message port closed" —
        // which means "no login form", not a fault. A missing receiver instead
        // means no content script is running on this page yet.
        resolve({
          ok: false,
          code: /Receiving end does not exist/i.test(raw) ? 'NO_CONTENT_SCRIPT' : 'NO_FORM',
        });
        return;
      }
      resolve(r || { ok: false, code: 'NO_FORM' });
    });
  });

  if (res.ok) {
    window.close();
    return;
  }

  if (res.code === 'NO_FORM') {
    message(
      '<b>No login form on this page.</b><br>Open the site’s sign-in page, then click Fill.'
    );
    return;
  }
  if (res.code === 'NO_CONTENT_SCRIPT') {
    message('<b>One Key isn’t active on this page yet.</b><br>Reload the page and try again.');
    return;
  }
  message(describe(res).body, detailOf(res));
}

async function render() {
  const tab = await currentTab();
  const url = tab?.url || '';

  if (!/^https?:/i.test(url)) {
    setState('No page to fill');
    message('Open a website to use One Key here.');
    return;
  }

  const host = new URL(url).hostname;

  const status = await send('status');
  if (!status.ok) {
    const d = describe(status);
    setState(...d.state);
    message(d.body, detailOf(status));
    return;
  }
  setState(`Unlocked · ${status.itemCount} item${status.itemCount === 1 ? '' : 's'}`, 'good');

  const res = await send('match', { url });
  if (!res.ok) {
    const d = describe(res);
    setState(...d.state);
    message(d.body, detailOf(res));
    return;
  }

  if (!res.items || res.items.length === 0) {
    message(
      `No saved logins for <b>${host.replace(/[<>&]/g, '')}</b>.<br>Sign in normally and One Key will offer to save it.`
    );
    return;
  }

  const body = $('body');
  body.replaceChildren();

  const group = document.createElement('div');
  group.className = 'group';
  group.textContent = `${res.items.length} login${res.items.length === 1 ? '' : 's'} for ${host}`;
  body.append(group);

  for (const item of res.items) {
    const btn = document.createElement('button');
    btn.className = 'item';
    btn.type = 'button';

    const av = document.createElement('span');
    av.className = 'item__av';
    av.textContent = (item.name || '?').trim().charAt(0).toUpperCase();

    const txt = document.createElement('span');
    txt.className = 'item__txt';
    const name = document.createElement('span');
    name.className = 'item__name';
    name.textContent = item.name;
    const sub = document.createElement('span');
    sub.className = 'item__sub';
    sub.textContent = item.username || 'no username';
    txt.append(name, sub);

    const go = document.createElement('span');
    go.className = 'item__go';
    go.textContent = 'Fill';

    btn.append(av, txt, go);
    btn.addEventListener('click', () => fill(tab, item));
    body.append(btn);
  }
}

$('open-app').addEventListener('click', async () => {
  await send('openApp');
  window.close();
});

render();
