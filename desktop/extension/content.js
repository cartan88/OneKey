/**
 * One Key — content script.
 *
 * Three jobs: find login fields, fill them on an explicit user click, and offer
 * to save a login after it's submitted.
 *
 * Deliberately no autofill on page load. A hidden or off-screen form could
 * otherwise harvest a credential without the user ever seeing it, so every fill
 * starts with a click on the One Key chip.
 */

(() => {
  if (window.__oneKeyLoaded) return;
  window.__oneKeyLoaded = true;

  const isTopFrame = window.top === window;

  // ------------------------------------------------------------------ messaging

  function send(type, payload = {}) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage({ type, ...payload }, (res) => {
          // lastError must be read or Chrome logs it as unchecked.
          if (chrome.runtime.lastError) {
            resolve({ ok: false, code: 'DISCONNECTED', message: chrome.runtime.lastError.message });
            return;
          }
          resolve(res || { ok: false, code: 'NO_RESPONSE' });
        });
      } catch (err) {
        resolve({ ok: false, code: 'DISCONNECTED', message: String(err) });
      }
    });
  }

  // ------------------------------------------------------------- field plumbing

  function visible(el) {
    if (!el || el.disabled || el.readOnly) return false;
    if (el.type === 'hidden') return false;
    const rect = el.getBoundingClientRect();
    if (rect.width < 24 || rect.height < 8) return false;
    const style = getComputedStyle(el);
    return style.visibility !== 'hidden' && style.display !== 'none' && Number(style.opacity) > 0.05;
  }

  /**
   * Collect matches from the document and from any *open* shadow roots.
   *
   * Component frameworks put their inputs inside shadow roots, where a plain
   * querySelectorAll cannot see them. Only attempted when the cheap query finds
   * nothing, since walking every element is not free. Closed shadow roots stay
   * out of reach — nothing can be done about those.
   */
  function deepQueryAll(selector) {
    const found = [...document.querySelectorAll(selector)];
    if (found.length) return found;

    const out = [];
    const walk = (root) => {
      out.push(...root.querySelectorAll(selector));
      for (const el of root.querySelectorAll('*')) {
        if (el.shadowRoot) walk(el.shadowRoot);
      }
    };
    walk(document);
    return out;
  }

  const passwordFields = () => deepQueryAll('input[type="password"]').filter(visible);

  const USERNAME_TYPES = new Set(['text', 'email', 'tel', 'search', '']);

  const USERNAME_HINT = /user(name)?|e-?mail|login|account|phone|mobile|identifier/i;

  /**
   * Fields that look like an identifier. Needed for two-step logins, where the
   * first screen asks only for an email and the password box does not exist yet —
   * requiring a password field before offering anything meant One Key stayed
   * invisible on exactly the screen where it should help.
   */
  function usernameFields() {
    return deepQueryAll('input').filter((el) => {
      if (!visible(el)) return false;
      if (!USERNAME_TYPES.has((el.type || '').toLowerCase())) return false;
      if (/username|email/i.test(el.getAttribute('autocomplete') || '')) return true;
      if ((el.type || '').toLowerCase() === 'email') return true;
      const label = [
        el.name,
        el.id,
        el.placeholder,
        el.getAttribute('aria-label') || '',
        el.getAttribute('data-testid') || '',
      ].join(' ');
      return USERNAME_HINT.test(label);
    });
  }

  /** Best guess at the username input that belongs to a given password input. */
  function usernameFor(passwordEl) {
    const scope =
      passwordEl.form ||
      passwordEl.closest('form, [role="form"], section, div') ||
      passwordEl.getRootNode() ||
      document.body;

    let candidates = [...scope.querySelectorAll('input')].filter(
      (el) => visible(el) && USERNAME_TYPES.has((el.type || '').toLowerCase())
    );
    // The identifier may sit outside the password field's container entirely.
    if (candidates.length === 0) candidates = usernameFields();
    if (candidates.length === 0) return null;

    // An explicit autocomplete hint beats any positional guess.
    const hinted = candidates.find((el) =>
      /username|email/i.test(el.getAttribute('autocomplete') || '')
    );
    if (hinted) return hinted;

    // Otherwise the nearest candidate *above* the password field, which is how
    // login forms are laid out essentially everywhere.
    const before = candidates.filter(
      (el) => el.compareDocumentPosition(passwordEl) & Node.DOCUMENT_POSITION_FOLLOWING
    );
    return before.length ? before[before.length - 1] : candidates[0];
  }

  const SIGNUP_HINT = /sign[\s-]?up|register|registration|create[\s-](an[\s-])?account|new account|join/i;
  const CONFIRM_HINT = /confirm|repeat|again|retype|verify|match/i;

  const describe = (el) =>
    [el.name, el.id, el.placeholder, el.getAttribute('aria-label') || '', el.getAttribute('autocomplete') || ''].join(' ');

  /**
   * Is this password box for a password being *created*, rather than one being
   * entered to sign in? That is when offering to generate one is useful.
   *
   * Three signals, cheapest first: the autocomplete hint the page declares, the
   * presence of a second password box (a confirm field), and signup wording in
   * the surrounding form.
   */
  function isNewPasswordField(el) {
    if (!el || el.type !== 'password') return false;
    if (/new-password/i.test(el.getAttribute('autocomplete') || '')) return true;
    if (CONFIRM_HINT.test(describe(el))) return true;
    if (passwordFields().length >= 2) return true;

    const form = el.form || el.closest('form, [role="form"], section');
    if (form && SIGNUP_HINT.test((form.textContent || '').slice(0, 400))) return true;
    return false;
  }

  /**
   * The "confirm password" boxes that should receive the same value.
   *
   * Deliberately not "every password field": a change-password form has a
   * *current* password box too, and filling that with the new value would be
   * actively harmful.
   */
  function confirmFieldsFor(target) {
    return passwordFields().filter(
      (el) =>
        el !== target &&
        (/new-password/i.test(el.getAttribute('autocomplete') || '') || CONFIRM_HINT.test(describe(el)))
    );
  }

  /**
   * Set a value the way a user would. Frameworks that track their own state
   * (React especially) ignore a plain `el.value = x`, so go through the native
   * setter and then fire the events they listen for.
   */
  function setValue(el, value) {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    el.focus();
    if (setter) setter.call(el, value);
    else el.value = value;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }

  function fillPair(username, password, pair) {
    if (pair.username && username) setValue(pair.username, username);
    if (pair.password) setValue(pair.password, password);
    pair.password?.blur();
  }

  function currentPair(target) {
    const pws = passwordFields();
    if (pws.length) {
      const password =
        (target && target.type === 'password' && pws.includes(target) && target) ||
        pws.find((pw) => usernameFor(pw) === target) ||
        pws[0];
      return { password, username: usernameFor(password) };
    }

    // Two-step login: only the identifier exists so far. Fill that, and the
    // password on the next screen when its field appears.
    const users = usernameFields();
    if (users.length === 0) return null;
    return {
      password: null,
      username: target && users.includes(target) ? target : users[0],
    };
  }

  // -------------------------------------------------------------------- shadow UI

  const CSS = `
    :host { all: initial; }
    * { box-sizing: border-box; font-family: "Segoe UI", system-ui, sans-serif; }
    .chip {
      position: fixed; z-index: 2147483646;
      width: 22px; height: 22px; padding: 0;
      display: grid; place-items: center;
      border: 0; border-radius: 6px; cursor: pointer;
      background: linear-gradient(145deg, #ef625d, #b8332f);
      box-shadow: 0 2px 6px rgba(0,0,0,.35);
    }
    .chip svg { width: 14px; height: 14px; stroke: #fff; }
    .panel {
      position: fixed; z-index: 2147483647;
      width: 268px; max-height: 320px; overflow-y: auto;
      padding: 6px; border-radius: 10px;
      background: #1a1f28; border: 1px solid #2a3140;
      box-shadow: 0 16px 40px rgba(0,0,0,.5);
      color: #e8ebf1; font-size: 13px;
    }
    .panel__head {
      padding: 6px 8px 8px; color: #6b7686; font-size: 10.5px;
      font-weight: 700; letter-spacing: .5px; text-transform: uppercase;
    }
    .item {
      display: flex; align-items: center; gap: 9px; width: 100%;
      padding: 7px 8px; border: 0; border-radius: 7px;
      background: none; color: inherit; text-align: left; cursor: pointer;
    }
    .item:hover { background: #232936; }
    .item__av {
      width: 26px; height: 26px; flex: none; border-radius: 7px;
      display: grid; place-items: center; color: #fff;
      font: 700 11px/1 "Segoe UI", sans-serif;
      background: linear-gradient(145deg, #ef625d, #b8332f);
    }
    .item__txt { min-width: 0; flex: 1; }
    .item__name { display: block; font-weight: 550; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .item__sub { display: block; color: #6b7686; font-size: 11.5px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .gen { padding: 0 2px 8px; border-bottom: 1px solid #222836; margin-bottom: 6px; }
    .gen__value {
      margin: 0 6px 9px; padding: 9px 10px;
      border: 1px solid #2a3140; border-radius: 7px; background: #12161d;
      font-family: Consolas, ui-monospace, monospace; font-size: 13px;
      line-height: 1.5; overflow-wrap: anywhere; color: #e8ebf1; user-select: all;
    }
    .gen__row { display: flex; gap: 7px; margin: 0 6px; }
    .gen__row .btn { flex: 1; padding: 7px 10px; border-radius: 7px; font-size: 12.5px; font-weight: 600; border: 1px solid transparent; cursor: pointer; }
    .gen__row .btn:disabled { opacity: .55; cursor: default; }

    .msg { padding: 10px 9px; color: #9aa4b5; font-size: 12.5px; line-height: 1.5; }
    .msg b { color: #e8ebf1; font-weight: 600; }
    .link {
      margin-top: 8px; padding: 7px 10px; width: 100%;
      border: 1px solid #2a3140; border-radius: 7px;
      background: #232936; color: #e8ebf1; font-size: 12.5px; cursor: pointer;
    }
    .link:hover { border-color: #39424f; }

    .bar {
      position: fixed; top: 14px; right: 14px; z-index: 2147483647;
      width: 330px; padding: 14px 15px;
      border-radius: 12px; background: #1a1f28; border: 1px solid #2a3140;
      box-shadow: 0 18px 48px rgba(0,0,0,.55); color: #e8ebf1;
    }
    .bar__row { display: flex; align-items: center; gap: 10px; }
    .bar__mark {
      width: 28px; height: 28px; flex: none; border-radius: 8px;
      display: grid; place-items: center;
      background: linear-gradient(145deg, #ef625d, #b8332f);
    }
    .bar__mark svg { width: 17px; height: 17px; stroke: #fff; }
    .bar__title { margin: 0; font-size: 13.5px; font-weight: 600; }
    .bar__sub { margin: 3px 0 0; color: #9aa4b5; font-size: 12px; overflow-wrap: anywhere; }
    /* A sentence for a person, not a code dump — plain UI font, not monospace. */
    .bar__detail {
      margin: 11px 0 0; padding: 7px 9px;
      border: 1px solid #222836; border-radius: 6px; background: #12161d;
      color: #6b7686; font-size: 11.5px; line-height: 1.5; overflow-wrap: anywhere;
    }
    .bar__actions { display: flex; gap: 8px; margin-top: 13px; }
    .btn {
      flex: 1; padding: 8px 12px; border-radius: 7px; cursor: pointer;
      font-size: 12.5px; font-weight: 600; border: 1px solid transparent;
    }
    .btn--go { background: #e2504b; color: #fff; }
    .btn--go:hover { background: #ef625d; }
    .btn--no { background: transparent; border-color: #2a3140; color: #9aa4b5; }
    .btn--no:hover { color: #e8ebf1; background: #232936; }
  `;

  const KEY_SVG =
    '<svg viewBox="0 0 24 24" fill="none" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round">' +
    '<circle cx="8" cy="12" r="4"/><path d="M12 12h9M17.5 12v4M21 12v3"/></svg>';

  let shadow = null;

  function ui() {
    if (shadow) return shadow;
    const host = document.createElement('div');
    host.id = 'one-key-ui';
    host.style.cssText = 'all:initial;position:static';
    (document.body || document.documentElement).appendChild(host);
    shadow = host.attachShadow({ mode: 'closed' });
    const style = document.createElement('style');
    style.textContent = CSS;
    shadow.append(style);
    return shadow;
  }

  function clear(selector) {
    shadow?.querySelectorAll(selector).forEach((el) => el.remove());
  }

  // ------------------------------------------------------------------- the chip

  let chipFor = null;

  function positionChip(chip, field) {
    const r = field.getBoundingClientRect();
    chip.style.left = `${Math.max(2, r.right - 27)}px`;
    chip.style.top = `${r.top + (r.height - 22) / 2}px`;
  }

  function showChip(field) {
    clear('.chip');
    const root = ui();
    const chip = document.createElement('button');
    chip.className = 'chip';
    chip.type = 'button';
    chip.title = 'Fill from One Key';
    chip.innerHTML = KEY_SVG;
    chip.addEventListener('mousedown', (e) => e.preventDefault()); // keep focus in the field
    chip.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      openPanel(field);
    });
    root.append(chip);
    chipFor = field;
    positionChip(chip, field);
  }

  function hideChip() {
    clear('.chip');
    chipFor = null;
  }

  function reflow() {
    const chip = shadow?.querySelector('.chip');
    if (chip && chipFor) {
      if (!visible(chipFor)) return hideChip();
      positionChip(chip, chipFor);
    }
    const panel = shadow?.querySelector('.panel');
    if (panel && chipFor) positionPanel(panel, chipFor);
  }

  // ------------------------------------------------------------------ the panel

  function positionPanel(panel, field) {
    const r = field.getBoundingClientRect();
    const width = 268;
    panel.style.left = `${Math.min(Math.max(6, r.left), window.innerWidth - width - 6)}px`;
    const below = r.bottom + 6;
    panel.style.top = `${below + 320 > window.innerHeight ? Math.max(6, r.top - 326) : below}px`;
  }

  async function openPanel(field) {
    if (shadow?.querySelector('.panel')) return clear('.panel');

    const root = ui();
    const panel = document.createElement('div');
    panel.className = 'panel';
    panel.innerHTML = '<div class="msg">Asking One Key…</div>';
    root.append(panel);
    positionPanel(panel, field);

    const res = await send('match', { url: location.href });
    panel.replaceChildren();

    if (!res.ok) {
      panel.append(problem(res));
      return;
    }

    // On a signup form, offering a strong password is the point — put it first,
    // above any saved logins for the site.
    const suggesting = isNewPasswordField(field);
    if (suggesting) panel.append(await buildGenerator(field, panel));
    if (!res.items || res.items.length === 0) {
      // With a suggestion already on screen, "no saved logins" is noise — of
      // course there are none; that is why you are signing up.
      if (!suggesting) {
        const msg = document.createElement('div');
        msg.className = 'msg';
        msg.textContent = `No saved logins for ${location.hostname}. Sign in normally and One Key will offer to save it.`;
        panel.append(msg);
      }
      return;
    }

    const head = document.createElement('div');
    head.className = 'panel__head';
    head.textContent = `${res.items.length} login${res.items.length === 1 ? '' : 's'} for ${location.hostname}`;
    panel.append(head);

    const pair = currentPair(field) || {};
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

      btn.append(av, txt);
      btn.addEventListener('click', async () => {
        panel.replaceChildren(Object.assign(document.createElement('div'), {
          className: 'msg',
          textContent: 'Filling…',
        }));

        const cred = await send('credential', { id: item.id, url: location.href });
        if (!cred.ok) {
          clear('.panel');
          return void toastProblem(cred);
        }

        const target = pair.password ? pair : currentPair(field) || {};
        fillPair(cred.username, cred.password, target);

        // On a two-step login there is no password box yet. Say so, rather than
        // vanishing and leaving the user wondering if it worked.
        if (!target.password) {
          panel.replaceChildren(
            Object.assign(document.createElement('div'), {
              className: 'msg',
              innerHTML: '<b>Username filled.</b><br>Continue, then click One Key again on the password step.',
            })
          );
          setTimeout(() => clear('.panel'), 5000);
          return;
        }
        clear('.panel');
      });
      panel.append(btn);
    }
  }

  /**
   * The suggested-password block shown on signup forms: the value, a way to ask
   * for another, and a button that fills it into the form.
   */
  async function buildGenerator(field, panel) {
    const wrap = document.createElement('div');
    wrap.className = 'gen';

    const head = document.createElement('div');
    head.className = 'panel__head';
    head.textContent = 'Suggested password';

    const value = document.createElement('div');
    value.className = 'gen__value';
    value.textContent = 'Generating…';

    const row = document.createElement('div');
    row.className = 'gen__row';

    const use = document.createElement('button');
    use.className = 'btn btn--go';
    use.type = 'button';
    use.textContent = 'Use it';

    const again = document.createElement('button');
    again.className = 'btn btn--no';
    again.type = 'button';
    again.textContent = 'Another';

    row.append(use, again);
    wrap.append(head, value, row);

    let password = '';

    const draw = async () => {
      use.disabled = true;
      value.textContent = 'Generating…';
      const res = await send('generate', { options: { length: 20 } });
      if (!res.ok || !res.password) {
        value.textContent = 'One Key could not generate a password.';
        return;
      }
      password = res.password;
      value.textContent = password;
      use.disabled = false;
    };

    again.addEventListener('click', (event) => {
      event.preventDefault();
      draw();
    });

    use.addEventListener('click', (event) => {
      event.preventDefault();
      if (!password) return;

      setValue(field, password);
      const confirms = confirmFieldsFor(field);
      for (const el of confirms) setValue(el, password);
      field.blur();

      clear('.panel');
      note(
        confirms.length
          ? 'Password filled, including the confirmation field.'
          : 'Password filled.',
        'One Key will offer to save it when you submit the form.'
      );
    });

    await draw();
    return wrap;
  }

  /** A short-lived message anchored where the panel was. */
  function note(title, detail) {
    const root = ui();
    clear('.panel');
    const panel = document.createElement('div');
    panel.className = 'panel';

    const msg = document.createElement('div');
    msg.className = 'msg';
    const strong = document.createElement('b');
    strong.textContent = title;
    msg.append(strong);
    if (detail) {
      msg.append(document.createElement('br'));
      msg.append(document.createTextNode(detail));
    }
    panel.append(msg);
    root.append(panel);
    if (chipFor) positionPanel(panel, chipFor);
    setTimeout(() => clear('.panel'), 5000);
  }

  function problem(res) {
    const wrap = document.createElement('div');
    const msg = document.createElement('div');
    msg.className = 'msg';

    if (res.code === 'LOCKED') {
      msg.innerHTML = '<b>One Key is locked.</b><br>Unlock it to fill this login.';
    } else if (res.code === 'APP_NOT_RUNNING' || res.code === 'HOST_UNAVAILABLE') {
      // A locked vault takes its pipe away entirely, so from out here "locked"
      // and "not running" look identical. Say both rather than guess.
      msg.innerHTML = '<b>One Key is locked or not running.</b><br>Open it and unlock your vault.';
    } else if (res.code === 'DISABLED') {
      msg.innerHTML = '<b>Browser integration is off.</b><br>Turn it on in One Key → Settings.';
    } else {
      msg.textContent = res.message || 'One Key could not be reached.';
    }
    wrap.append(msg);

    const open = document.createElement('button');
    open.className = 'link';
    open.type = 'button';
    open.textContent = 'Open One Key';
    open.addEventListener('click', () => send('openApp'));
    wrap.append(open);
    return wrap;
  }

  function toastProblem(res) {
    const root = ui();
    clear('.panel');
    const panel = document.createElement('div');
    panel.className = 'panel';
    panel.append(problem(res));
    root.append(panel);
    if (chipFor) positionPanel(panel, chipFor);
    setTimeout(() => clear('.panel'), 6000);
  }

  // ------------------------------------------------------------- the save prompt

  function showSaveBar(pending) {
    if (!isTopFrame) return;
    clear('.bar');
    const root = ui();

    const bar = document.createElement('div');
    bar.className = 'bar';

    const row = document.createElement('div');
    row.className = 'bar__row';
    const mark = document.createElement('span');
    mark.className = 'bar__mark';
    mark.innerHTML = KEY_SVG;

    const text = document.createElement('div');
    const title = document.createElement('p');
    title.className = 'bar__title';
    title.textContent =
      pending.action === 'update' ? 'Update this password in One Key?' : 'Save this login to One Key?';
    const sub = document.createElement('p');
    sub.className = 'bar__sub';
    sub.textContent = pending.username
      ? `${pending.username} · ${hostOf(pending.url)}`
      : hostOf(pending.url);
    text.append(title, sub);
    row.append(mark, text);

    const actions = document.createElement('div');
    actions.className = 'bar__actions';

    const save = document.createElement('button');
    save.className = 'btn btn--go';
    save.type = 'button';
    save.textContent = pending.action === 'update' ? 'Update' : 'Save';
    save.addEventListener('click', async () => {
      save.disabled = true;
      save.textContent = 'Saving…';
      const res = await send('confirmSave');
      clear('.bar');
      if (!res.ok) toastProblem(res);
    });

    const no = document.createElement('button');
    no.className = 'btn btn--no';
    no.type = 'button';
    no.textContent = 'Not now';
    no.addEventListener('click', async () => {
      clear('.bar');
      await send('dismissSave');
    });

    actions.append(save, no);
    bar.append(row, actions);
    root.append(bar);
  }

  /**
   * Shown when a login was submitted but One Key could not be asked about it.
   * Without this the user gets silence and no way to know a save was missed.
   */
  function showNoticeBar(problem) {
    if (!isTopFrame) return;
    clear('.bar');
    const root = ui();

    const bar = document.createElement('div');
    bar.className = 'bar';

    const row = document.createElement('div');
    row.className = 'bar__row';
    const mark = document.createElement('span');
    mark.className = 'bar__mark';
    mark.innerHTML = KEY_SVG;

    const text = document.createElement('div');
    const title = document.createElement('p');
    title.className = 'bar__title';
    title.textContent = 'One Key could not save this login';
    const sub = document.createElement('p');
    sub.className = 'bar__sub';
    sub.textContent =
      problem.code === 'LOCKED' || problem.code === 'APP_NOT_RUNNING'
        ? 'Your vault is locked or One Key is closed. Unlock it, then sign in again to save.'
        : problem.code === 'DISABLED'
          ? 'Browser integration is turned off in One Key → Settings.'
          : 'One Key could not be reached. Restarting Chrome usually fixes this.';
    text.append(title, sub);
    row.append(mark, text);

    // problem.message is already a full sentence everywhere it's set — Chrome's
    // own wording for a connection failure, or ours for anything app-side — so
    // it's shown alone. The internal code (HOST_UNAVAILABLE, APP_NOT_RUNNING,
    // …) exists for background.js to branch on, not for a user to read.
    const detail = document.createElement('p');
    detail.className = 'bar__detail';
    detail.textContent = problem.message || '';
    detail.hidden = !problem.message;

    const actions = document.createElement('div');
    actions.className = 'bar__actions';

    const open = document.createElement('button');
    open.className = 'btn btn--go';
    open.type = 'button';
    open.textContent = 'Open One Key';
    open.addEventListener('click', async () => {
      await send('openApp');
      clear('.bar');
      await send('dismissSave');
    });

    const no = document.createElement('button');
    no.className = 'btn btn--no';
    no.type = 'button';
    no.textContent = 'Dismiss';
    no.addEventListener('click', async () => {
      clear('.bar');
      await send('dismissSave');
    });

    actions.append(open, no);
    bar.append(row, detail, actions);
    root.append(bar);
  }

  function hostOf(url) {
    try {
      return new URL(url).hostname;
    } catch {
      return url;
    }
  }

  // ----------------------------------------------------------------- capturing

  let lastCapture = 0;
  let lastUsername = '';

  /**
   * Remember the last identifier the user typed. On a two-step login the email
   * field is gone by the time the password is submitted, so without this the
   * login would be saved with no username at all.
   *
   * Uses `change` rather than `input`: it fires once on leaving the field, so
   * this costs nothing per keystroke.
   */
  document.addEventListener(
    'change',
    (event) => {
      const el = event.target;
      if (!(el instanceof HTMLInputElement)) return;
      if ((el.type || '').toLowerCase() === 'password') return;
      if (!USERNAME_TYPES.has((el.type || '').toLowerCase())) return;
      const value = (el.value || '').trim();
      if (value.length > 2) lastUsername = value;
    },
    true
  );

  async function capture(reason) {
    const pw = passwordFields().find((el) => el.value);
    if (!pw) return;
    if (Date.now() - lastCapture < 800) return; // submit + click often both fire
    lastCapture = Date.now();

    const user = usernameFor(pw);
    const payload = {
      url: location.href,
      username: (user && user.value) || lastUsername || '',
      password: pw.value,
    };

    const res = await send('captured', payload);
    const delay = reason === 'submit' ? 1200 : 400;

    // If the page navigates, the reloaded content script picks either of these
    // up from the background instead.
    if (!res.ok) {
      setTimeout(() => {
        if (document.visibilityState !== 'hidden') {
          showNoticeBar({ code: res.code, message: res.message });
        }
      }, delay);
      return;
    }
    if (res.action === 'known') return;

    setTimeout(() => {
      if (document.visibilityState !== 'hidden') {
        showSaveBar({ ...payload, action: res.action, name: res.name });
      }
    }, delay);
  }

  document.addEventListener('submit', () => capture('submit'), true);

  document.addEventListener(
    'click',
    (event) => {
      const el = event.target instanceof Element ? event.target.closest('button, input[type="submit"], [role="button"]') : null;
      if (!el) return;
      if (el.type === 'button' && !/log|sign|submit|continue|next|enter/i.test(el.textContent || el.value || '')) return;
      capture('click');
    },
    true
  );

  document.addEventListener(
    'keydown',
    (event) => {
      if (event.key === 'Enter' && event.target instanceof HTMLInputElement) capture('enter');
    },
    true
  );

  // ------------------------------------------------------------------- wiring up

  document.addEventListener(
    'focusin',
    (event) => {
      const el = event.target;
      if (!(el instanceof HTMLInputElement)) return;

      const pws = passwordFields();
      const isLoginField =
        el.type === 'password' ||
        pws.some((pw) => usernameFor(pw) === el) ||
        // No password box on screen yet — offer on the identifier field itself.
        (pws.length === 0 && usernameFields().includes(el));

      if (isLoginField) showChip(el);
    },
    true
  );

  document.addEventListener('mousedown', (event) => {
    const host = shadow?.host;
    if (host && event.composedPath().includes(host)) return;
    clear('.panel');
  });

  window.addEventListener('scroll', reflow, { passive: true, capture: true });
  window.addEventListener('resize', reflow, { passive: true });

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      clear('.panel');
      clear('.bar');
    }
  });

  // The popup can't touch the page itself, so it asks whichever frame actually
  // holds a login form to do the fill. Frames without one stay silent so the
  // popup gets exactly one reply.
  chrome.runtime.onMessage.addListener((msg, _sender, respond) => {
    if (msg?.type !== 'fillFromPopup') return false;
    // Stay silent when this frame has nothing to fill, so a frame that does can
    // answer instead. Username-only screens count as fillable.
    if (passwordFields().length === 0 && usernameFields().length === 0) return false;

    (async () => {
      const pair = currentPair(null);
      if (!pair || !pair.password) {
        respond({ ok: false, code: 'NO_FORM' });
        return;
      }
      const cred = await send('credential', { id: msg.id, url: location.href });
      if (!cred.ok) {
        respond(cred);
        return;
      }
      fillPair(cred.username, cred.password, pair);
      respond({ ok: true });
    })();
    return true;
  });

  /**
   * A login submitted just before navigation surfaces on the next page load.
   *
   * Asking only once on load loses a race: the app round trip is still in flight
   * while this page loads, so there is often nothing stored yet — and the offer
   * to save would be dropped silently. Ask a few times, then stop.
   */
  if (isTopFrame) {
    (async () => {
      for (const wait of [0, 700, 1500, 2500, 4000]) {
        if (wait) await new Promise((r) => setTimeout(r, wait));
        if (shadow && shadow.querySelector('.bar')) return; // already showing

        const res = await send('pendingSave');
        if (!res.ok || !res.pending) continue;

        if (res.pending.kind === 'problem') showNoticeBar(res.pending);
        else showSaveBar(res.pending);
        return;
      }
    })();
  }
})();
