'use strict';

/**
 * One Key — renderer.
 *
 * Holds no secrets of its own: the entry list arrives with passwords stripped,
 * and a plaintext password only crosses the bridge when the user explicitly
 * reveals, copies, or edits one.
 */

const api = window.oneKey;
const strength = window.OneKeyStrength;

const $ = (id) => document.getElementById(id);

const state = {
  entries: [],
  view: 'all', // 'all' | 'favorites' | 'weak' | 'folder:<name>'
  search: '',
  selectedId: null,
  settings: { autoLockMinutes: 5 },
  vaultPath: '',
  revealedId: null, // only ever one password on screen at a time
  revealedValue: '',
  revealTimer: null,
  editingId: null,
  bulkSelected: new Set(), // ids checked for a bulk action, independent of selectedId
};

// ---------------------------------------------------------------------- screens

function showScreen(name) {
  for (const id of ['screen-setup', 'screen-unlock', 'screen-app']) {
    $(id).hidden = id !== `screen-${name}`;
  }
}

async function boot() {
  wireGlobalUi();

  const res = await api.vault.status();
  if (!res.ok) return toast(res.error.message, 'bad');

  state.vaultPath = res.value.path;
  if (res.value.exists) {
    showScreen('unlock');
    $('unlock-password').focus();
  } else {
    showScreen('setup');
    $('setup-password').focus();
  }
}

// ------------------------------------------------------------------ gate: setup

$('form-setup').addEventListener('submit', async (event) => {
  event.preventDefault();
  const pw = $('setup-password').value;
  const confirm = $('setup-confirm').value;
  const err = $('setup-error');

  if (pw.length < 8) return showError(err, 'Your master password must be at least 8 characters.');
  if (pw !== confirm) return showError(err, 'The two passwords do not match.');

  const btn = $('setup-submit');
  btn.disabled = true;
  btn.textContent = 'Encrypting vault…';
  hideError(err);

  const res = await api.vault.create(pw);
  btn.disabled = false;
  btn.textContent = 'Create vault';

  if (!res.ok) return showError(err, res.error.message);

  $('setup-password').value = '';
  $('setup-confirm').value = '';
  state.settings = res.value.settings;
  await enterVault();
  toast('Vault created. Add your first password.');
});

$('setup-password').addEventListener('input', (event) => {
  paintStrength($('setup-strength'), event.target.value, 'Use at least 12 characters');
});

// ----------------------------------------------------------------- gate: unlock

$('form-unlock').addEventListener('submit', async (event) => {
  event.preventDefault();
  const input = $('unlock-password');
  const err = $('unlock-error');
  const btn = $('unlock-submit');

  if (!input.value) return showError(err, 'Enter your master password.');

  btn.disabled = true;
  btn.textContent = 'Unlocking…';
  hideError(err);

  const res = await api.vault.unlock(input.value);
  btn.disabled = false;
  btn.textContent = 'Unlock';

  if (!res.ok) {
    input.select();
    return showError(err, res.error.message);
  }

  input.value = '';
  state.settings = res.value.settings;
  await enterVault();
});

async function enterVault() {
  showScreen('app');
  $('vault-path').textContent = state.vaultPath;
  $('set-autolock').value = String(state.settings.autoLockMinutes ?? 5);
  state.view = 'all';
  state.selectedId = null;
  await refresh();
  resetIdleTimer();
  $('search').focus();
}

// --------------------------------------------------------------------- locking

api.onLocked(({ reason }) => {
  clearRevealTimer();
  state.entries = [];
  state.selectedId = null;
  state.revealedId = null;
  state.bulkSelected.clear();
  state.search = '';
  $('search').value = '';
  closeModal('modal-editor');
  closeModal('modal-settings');
  closeModal('modal-transfer');
  closeModal('modal-portability');
  closeModal('modal-generator');
  closeModal('modal-confirm');
  $('detail-body').hidden = true;
  $('detail-placeholder').hidden = false;

  const messages = {
    idle: 'Locked after inactivity. Enter your master password to continue.',
    manual: 'Vault locked. Enter your master password to unlock.',
  };
  $('unlock-reason').textContent =
    messages[reason] || 'Enter your master password to unlock your vault.';
  hideError($('unlock-error'));
  showScreen('unlock');
  $('unlock-password').focus();
});

/**
 * The sidebar button and Ctrl+L both land here, and both are easy to trigger
 * by mistake — the button sits right below Settings/About in the sidebar
 * footer, and Ctrl+L is close enough to other bindings to catch a stray
 * keystroke. Confirming first means a mistake costs a click, not a forced
 * re-entry of the master password.
 *
 * The tray icon's and the app menu's own "Lock vault" stay instant on
 * purpose — that path exists as a fast, no-friction panic button (walking
 * away from the machine, someone at the door), and asking "are you sure?"
 * there would work against the one thing it's for.
 */
async function lockNow() {
  // Ctrl+L deliberately still works with a dialog open (Settings, most often —
  // this is the exact case being fixed here), so the confirm prompt has to be
  // able to stack on top of it. modal-confirm sits last in MODALS, so it
  // becomes the interactive one and whatever was open stays backgrounded
  // rather than being torn down — Cancel returns focus and interactivity to
  // it, which is what "cancel and go back to Settings" actually means here.
  const confirmed = await confirmDialog({
    title: 'Lock vault',
    message: 'Lock your vault now?',
    detail: "You'll need your master password to unlock it again.",
    confirmLabel: 'Lock',
    tone: 'lock',
  });
  if (!confirmed) return;
  await api.vault.lock();
}

/**
 * Every browser fill and save is announced here. A password manager that hands
 * out credentials silently gives you no way to notice one you didn't ask for.
 */
api.onBrowserActivity(({ kind, name }) => {
  const label = name || 'a login';
  if (kind === 'fill') toast(`Filled ${label} in your browser`);
  else if (kind === 'created') toast(`Saved ${label} from your browser`);
  else if (kind === 'updated') toast(`Updated ${label}'s password from your browser`);

  // The idle timer only ever watched mouse/keyboard on this window, so a vault
  // used exclusively through the Chrome extension would auto-lock — and take
  // the browser bridge down with it — while genuinely still in active use.
  resetIdleTimer();

  // Saves change the vault, so bring the list back in step.
  if (kind === 'created' || kind === 'updated') refresh();
});

// ----------------------------------------------------------------- data + views

async function refresh() {
  const res = await api.entries.list();
  if (!res.ok) {
    if (res.error.code !== 'LOCKED') toast(res.error.message, 'bad');
    return;
  }
  state.entries = res.value;

  // Drop any bulk-selected id the vault no longer has — deleted by this same
  // action, by the Chrome extension, or from another window — so the bar's
  // count and the header checkbox never reflect a phantom selection.
  const known = new Set(state.entries.map((e) => e.id));
  for (const id of state.bulkSelected) {
    if (!known.has(id)) state.bulkSelected.delete(id);
  }

  renderSidebar();
  renderList();
  renderDetail();
  renderFolderOptions();
  renderBulkBar();
}

function isWeak(entry) {
  return entry.reused || !entry.hasPassword || (entry.strength && entry.strength.score <= 1);
}

function entriesForView(view) {
  if (view === 'favorites') return state.entries.filter((e) => e.favorite);
  if (view === 'weak') return state.entries.filter(isWeak);
  if (view.startsWith('folder:')) {
    const folder = view.slice(7);
    return state.entries.filter((e) => e.folder === folder);
  }
  return state.entries;
}

function visibleEntries() {
  const q = state.search.trim().toLowerCase();
  let list = entriesForView(state.view);
  if (q) {
    list = list.filter((e) =>
      [e.name, e.username, e.url, e.folder, e.notes]
        .filter(Boolean)
        .some((v) => v.toLowerCase().includes(q))
    );
  }
  return list;
}

function viewTitle() {
  if (state.view === 'favorites') return 'Favorites';
  if (state.view === 'weak') return 'Weak & reused';
  if (state.view.startsWith('folder:')) return state.view.slice(7);
  return 'All items';
}

// -------------------------------------------------------------------- rendering

function renderSidebar() {
  $('nav').querySelector('[data-count="all"]').textContent = state.entries.length;
  $('nav').querySelector('[data-count="favorites"]').textContent = entriesForView('favorites').length;
  $('nav').querySelector('[data-count="weak"]').textContent = entriesForView('weak').length;

  for (const btn of $('nav').querySelectorAll('.nav__item')) {
    btn.classList.toggle('is-active', state.view === btn.dataset.view);
  }

  const holder = $('nav-folders');
  holder.replaceChildren();

  const folders = [...new Set(state.entries.map((e) => e.folder).filter(Boolean))].sort((a, b) =>
    a.localeCompare(b, undefined, { sensitivity: 'base' })
  );

  if (folders.length === 0) {
    const p = document.createElement('p');
    p.className = 'nav__empty';
    p.textContent = 'No folders yet';
    holder.append(p);
    return;
  }

  for (const folder of folders) {
    const view = `folder:${folder}`;
    const btn = document.createElement('button');
    btn.className = 'nav__item' + (state.view === view ? ' is-active' : '');
    btn.dataset.view = view;

    btn.append(
      svgIcon('<path d="M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2z"/>'),
      textSpan(folder),
      countSpan(state.entries.filter((e) => e.folder === folder).length)
    );
    btn.addEventListener('click', () => setView(view));
    holder.append(btn);
  }
}

function renderList() {
  const list = $('list');
  const items = visibleEntries();

  $('list-title').textContent = viewTitle();
  $('list-count').textContent = items.length
    ? `${items.length} item${items.length === 1 ? '' : 's'}`
    : '';

  const checkedVisible = items.filter((e) => state.bulkSelected.has(e.id)).length;
  const selectAll = $('select-all');
  selectAll.checked = items.length > 0 && checkedVisible === items.length;
  selectAll.indeterminate = checkedVisible > 0 && checkedVisible < items.length;

  list.replaceChildren();

  if (items.length === 0) {
    $('list-empty').hidden = false;
    const empty = $('list-empty');
    const searching = Boolean(state.search.trim());
    empty.querySelector('.empty__title').textContent = searching
      ? 'No matches'
      : 'Nothing here yet';
    empty.querySelector('.empty__text').textContent = searching
      ? `Nothing in ${viewTitle().toLowerCase()} matches “${state.search.trim()}”.`
      : 'Add your first password to get started.';
    return;
  }
  $('list-empty').hidden = true;

  for (const entry of items) {
    list.append(buildRow(entry));
  }
}

function buildRow(entry) {
  const checked = state.bulkSelected.has(entry.id);
  const row = document.createElement('div');
  row.className =
    'row' +
    (entry.id === state.selectedId ? ' is-selected' : '') +
    (checked ? ' is-checked' : '');
  row.setAttribute('role', 'listitem');
  row.tabIndex = 0;

  const check = document.createElement('input');
  check.type = 'checkbox';
  check.className = 'rowcheck row__check';
  check.checked = checked;
  check.setAttribute('aria-label', `Select ${entry.name} for a bulk action`);
  check.addEventListener('click', (event) => event.stopPropagation());
  check.addEventListener('change', () => toggleBulkSelected(entry.id));
  row.append(check);

  row.append(buildAvatar(entry.name, 'row__avatar'));

  const text = document.createElement('div');
  text.className = 'row__text';

  const name = document.createElement('div');
  name.className = 'row__name';
  name.append(document.createTextNode(entry.name));
  if (entry.favorite) {
    const star = document.createElement('span');
    star.className = 'row__star';
    star.textContent = '★';
    star.title = 'Favorite';
    name.append(star);
  }

  const sub = document.createElement('div');
  sub.className = 'row__sub';
  sub.textContent = entry.username || hostOf(entry.url) || '—';

  text.append(name, sub);
  row.append(text);

  const actions = document.createElement('div');
  actions.className = 'row__actions';

  if (entry.username) {
    actions.append(
      actionButton(
        'Copy username',
        '<path d="M9 9h10v10a2 2 0 01-2 2H9a2 2 0 01-2-2z"/><path d="M15 5H7a2 2 0 00-2 2v8"/>',
        (event) => {
          event.stopPropagation();
          copyField(entry.id, 'username');
        }
      )
    );
  }
  if (entry.hasPassword) {
    actions.append(
      actionButton(
        'Copy password',
        '<rect x="4" y="10" width="16" height="11" rx="2"/><path d="M8 10V7a4 4 0 018 0v3"/>',
        (event) => {
          event.stopPropagation();
          copyField(entry.id, 'password');
        }
      )
    );
  }
  if (entry.url) {
    actions.append(
      actionButton(
        'Open website',
        '<path d="M14 4h6v6"/><path d="M20 4l-9 9"/><path d="M19 14v4a2 2 0 01-2 2H6a2 2 0 01-2-2V7a2 2 0 012-2h4"/>',
        (event) => {
          event.stopPropagation();
          openUrl(entry.url);
        }
      )
    );
  }
  row.append(actions);

  row.addEventListener('click', (event) => {
    if (event.target === check) return; // the checkbox's own handler covers this
    select(entry.id);
  });
  row.addEventListener('dblclick', (event) => {
    if (event.target === check) return;
    openEditor(entry.id);
  });
  row.addEventListener('keydown', (event) => {
    // A Space toggling the checkbox bubbles here too; without this guard it
    // would also open the item, which is not what pressing Space on a
    // checkbox should do.
    if (event.target !== row) return;
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      select(entry.id);
    }
  });

  return row;
}

function renderDetail() {
  const body = $('detail-body');
  const entry = state.entries.find((e) => e.id === state.selectedId);

  if (!entry) {
    body.hidden = true;
    body.replaceChildren();
    $('detail-placeholder').hidden = false;
    return;
  }

  $('detail-placeholder').hidden = true;
  body.hidden = false;
  body.replaceChildren();

  // ---- header
  const head = document.createElement('div');
  head.className = 'dhead';
  head.append(buildAvatar(entry.name, 'dhead__avatar'));

  const htext = document.createElement('div');
  htext.className = 'dhead__text';
  const h1 = document.createElement('h2');
  h1.className = 'dhead__name';
  h1.textContent = entry.name;
  const hsub = document.createElement('p');
  hsub.className = 'dhead__sub';
  hsub.textContent = hostOf(entry.url) || entry.username || 'No website';
  htext.append(h1, hsub);
  head.append(htext);

  const fav = document.createElement('button');
  fav.className = 'dhead__fav' + (entry.favorite ? ' is-on' : '');
  fav.textContent = entry.favorite ? '★' : '☆';
  fav.title = entry.favorite ? 'Remove from favorites' : 'Add to favorites';
  fav.addEventListener('click', () => toggleFavorite(entry));
  head.append(fav);
  body.append(head);

  // ---- badges
  const badges = document.createElement('div');
  badges.className = 'dbadges';
  if (entry.folder) badges.append(badge(entry.folder, 'badge--folder'));
  if (entry.hasPassword) {
    const score = entry.strength ? entry.strength.score : 0;
    const tone = score <= 1 ? 'badge--bad' : score === 2 ? 'badge--warn' : 'badge--good';
    badges.append(badge(`${entry.strength ? entry.strength.label : 'Unknown'} password`, tone));
  } else {
    badges.append(badge('No password saved', 'badge--warn'));
  }
  if (entry.reused) badges.append(badge('Reused elsewhere', 'badge--bad'));
  if (badges.childElementCount) body.append(badges);

  // ---- username
  if (entry.username) {
    body.append(
      detailField('Username', (value) => {
        const span = document.createElement('span');
        span.textContent = entry.username;
        value.append(
          span,
          smallButton('Copy', () => copyField(entry.id, 'username'))
        );
      })
    );
  }

  // ---- password
  body.append(
    detailField('Password', (value) => {
      const span = document.createElement('span');
      const revealed = state.revealedId === entry.id;

      if (!entry.hasPassword) {
        span.className = 'secret secret--masked';
        span.textContent = '— none —';
        value.append(span);
        return;
      }

      span.className = revealed ? 'secret' : 'secret secret--masked';
      span.textContent = revealed
        ? state.revealedValue
        : '•'.repeat(Math.min(entry.passwordLength || 10, 24));
      value.append(
        span,
        smallButton(revealed ? 'Hide' : 'Reveal', () => toggleReveal(entry.id)),
        smallButton('Copy', () => copyField(entry.id, 'password'))
      );
    })
  );

  // ---- website
  if (entry.url) {
    body.append(
      detailField('Website', (value) => {
        const link = document.createElement('a');
        link.textContent = entry.url;
        link.addEventListener('click', (event) => {
          event.preventDefault();
          openUrl(entry.url);
        });
        value.append(
          link,
          smallButton('Copy', () => copyField(entry.id, 'url'))
        );
      })
    );
  }

  // ---- notes
  if (entry.notes) {
    body.append(
      detailField('Notes', (value) => {
        const pre = document.createElement('pre');
        pre.className = 'dnotes';
        pre.textContent = entry.notes;
        value.append(
          pre,
          smallButton('Copy', () => copyField(entry.id, 'notes'))
        );
      })
    );
  }

  // ---- meta
  const meta = document.createElement('div');
  meta.className = 'dmeta';
  meta.append(
    metaSpan(`Created ${formatDate(entry.createdAt)}`),
    metaSpan(`Modified ${formatDate(entry.updatedAt)}`)
  );
  if (entry.hasPassword) {
    meta.append(metaSpan(`Password changed ${formatDate(entry.passwordUpdatedAt)}`));
  }
  body.append(meta);

  // ---- actions
  const actions = document.createElement('div');
  actions.className = 'dactions';

  const edit = document.createElement('button');
  edit.className = 'btn btn--ghost';
  edit.textContent = 'Edit';
  edit.addEventListener('click', () => openEditor(entry.id));

  const del = document.createElement('button');
  del.className = 'btn btn--danger';
  del.textContent = 'Delete';
  del.addEventListener('click', () => deleteEntry(entry));

  actions.append(edit, del);
  body.append(actions);
}

// ------------------------------------------------------------------- selection

function select(id) {
  if (state.selectedId !== id) {
    clearRevealTimer();
    state.revealedId = null;
    state.revealedValue = '';
  }
  state.selectedId = id;
  for (const row of $('list').children) row.classList.remove('is-selected');
  renderList();
  renderDetail();
}

function setView(view) {
  state.view = view;
  state.selectedId = null;
  // A bulk selection tied to items that are about to scroll out of view (a
  // different folder, Favorites, Weak & reused) would leave the bar reporting
  // a count with nothing checked on screen to explain it. Searching within the
  // current view deliberately does NOT clear this — narrowing the list to add
  // one more item to an existing batch is a real workflow.
  state.bulkSelected.clear();
  renderSidebar();
  renderList();
  renderDetail();
  renderBulkBar();
}

// ------------------------------------------------------------ reveal + clipboard

function clearRevealTimer() {
  if (state.revealTimer) {
    clearTimeout(state.revealTimer);
    state.revealTimer = null;
  }
}

async function toggleReveal(id) {
  if (state.revealedId === id) {
    clearRevealTimer();
    state.revealedId = null;
    state.revealedValue = '';
    renderDetail();
    return;
  }

  const res = await api.entries.reveal(id);
  if (!res.ok) return toast(res.error.message, 'bad');

  state.revealedId = id;
  state.revealedValue = res.value;
  renderDetail();

  // Re-mask on its own so a revealed password does not sit on screen forever.
  clearRevealTimer();
  state.revealTimer = setTimeout(() => {
    state.revealedId = null;
    state.revealedValue = '';
    renderDetail();
  }, 30000);
}

const FIELD_LABEL = { username: 'Username', password: 'Password', url: 'Website', notes: 'Notes' };

// Notes get the same auto-clear treatment as passwords: entries are a natural
// place to stash a recovery code or a TOTP seed, so what lands there deserves
// the same "don't sit in the clipboard forever" handling.
const AUTO_CLEAR_FIELDS = new Set(['password', 'notes']);

async function copyField(id, field) {
  const res = await api.clipboard.copyField(id, field, AUTO_CLEAR_FIELDS.has(field) ? 30 : 0);
  if (!res.ok) return toast(res.error.message, 'bad');
  if (!res.value.copied) return toast('Nothing to copy.', 'bad');

  const label = FIELD_LABEL[field] || 'Value';
  toast(
    res.value.clearAfterSeconds
      ? `${label} copied — clipboard clears in ${res.value.clearAfterSeconds}s`
      : `${label} copied`
  );
}

async function openUrl(url) {
  const withScheme = /^https?:\/\//i.test(url) ? url : `https://${url}`;
  const res = await api.openExternal(withScheme);
  if (!res.ok || res.value !== true) toast('That does not look like a web address.', 'bad');
}

async function toggleFavorite(entry) {
  const res = await api.entries.update(entry.id, { favorite: !entry.favorite });
  if (!res.ok) return toast(res.error.message, 'bad');
  await refresh();
}

/**
 * In-app confirmation, styled like the rest of One Key rather than the OS's own
 * message box. Resolves true only on an explicit confirm click — closing by
 * any other route (Cancel, backdrop, ×, Escape, the vault locking underneath
 * it) resolves false, so the caller's action simply doesn't happen.
 *
 * Shared by every yes/no confirmation in the app — single delete, bulk
 * delete, and locking — which differ only in wording, icon, and how
 * strongly the primary button should read. One Key's whole palette is a
 * single accent colour (danger and brand share the same red), so `tone`
 * mainly changes the icon glyph and the button's semantic class; see the
 * comment on .confirm__icon for why it doesn't also recolour anything.
 */
const CONFIRM_ICONS = {
  danger: '<path d="M12 3l9 16H3z"/><path d="M12 9v5M12 17h.01"/>',
  lock: '<rect x="4" y="10" width="16" height="11" rx="2"/><path d="M8 10V7a4 4 0 018 0v3"/>',
};

function confirmDialog({ title, message, detail = '', confirmLabel = 'Delete', tone = 'danger' }) {
  return new Promise((resolve) => {
    $('confirm-title').textContent = title;
    $('confirm-message').textContent = message;
    $('confirm-detail').textContent = detail;

    const icon = $('confirm-icon');
    icon.replaceChildren(svgIcon(CONFIRM_ICONS[tone] || CONFIRM_ICONS.danger));

    const btn = $('confirm-ok-btn');
    btn.textContent = confirmLabel;
    btn.className = `btn ${tone === 'danger' ? 'btn--danger-solid' : 'btn--primary'}`;

    pendingConfirmResolve = resolve;
    openModal('modal-confirm');
    btn.focus();
  });
}

const DEFAULT_CONFIRM_DETAIL = 'This permanently removes the item from your vault. It cannot be undone.';

let pendingConfirmResolve = null;

function settleConfirm(result) {
  if (pendingConfirmResolve) {
    const resolve = pendingConfirmResolve;
    pendingConfirmResolve = null;
    resolve(result);
  }
}

$('confirm-ok-btn').addEventListener('click', () => {
  settleConfirm(true);
  closeModal('modal-confirm');
});

async function deleteEntry(entry) {
  const confirmed = await confirmDialog({
    title: 'Delete item',
    message: `Delete “${entry.name}”?`,
    detail: DEFAULT_CONFIRM_DETAIL,
    confirmLabel: 'Delete',
    tone: 'danger',
  });
  if (!confirmed) return;

  const res = await api.entries.remove(entry.id);
  if (!res.ok) return toast(res.error.message, 'bad');

  state.selectedId = null;
  await refresh();
  toast(`“${entry.name}” deleted`);
}

// -------------------------------------------------------------------- bulk ops

/** Ids currently checked that still exist in the vault as of the last refresh. */
function liveBulkSelection() {
  const known = new Set(state.entries.map((e) => e.id));
  return [...state.bulkSelected].filter((id) => known.has(id));
}

function clearBulkSelection() {
  state.bulkSelected.clear();
  renderList();
  renderBulkBar();
}

function toggleBulkSelected(id) {
  if (state.bulkSelected.has(id)) state.bulkSelected.delete(id);
  else state.bulkSelected.add(id);
  renderList();
  renderBulkBar();
}

function renderBulkBar() {
  const count = state.bulkSelected.size;
  const bar = $('bulkbar');
  bar.hidden = count === 0;
  if (count === 0) {
    // Start clean next time a selection begins, rather than showing whatever
    // folder name was left typed in from a previous batch.
    $('bulkbar-folder').value = '';
    return;
  }
  $('bulkbar-count').textContent = `${count} selected`;
}

$('select-all').addEventListener('change', () => {
  const ids = visibleEntries().map((e) => e.id);
  const allSelected = ids.length > 0 && ids.every((id) => state.bulkSelected.has(id));

  if (allSelected) {
    for (const id of ids) state.bulkSelected.delete(id);
  } else {
    for (const id of ids) state.bulkSelected.add(id);
  }
  renderList();
  renderBulkBar();
});

$('bulkbar-clear-btn').addEventListener('click', clearBulkSelection);

$('bulkbar-delete-btn').addEventListener('click', async () => {
  const ids = liveBulkSelection();
  if (ids.length === 0) return;

  const confirmed = await confirmDialog({
    title: 'Delete item',
    message: `Delete ${ids.length} item${ids.length === 1 ? '' : 's'}?`,
    detail: `This permanently removes ${ids.length === 1 ? 'it' : 'them'} from your vault. It cannot be undone.`,
    confirmLabel: 'Delete',
    tone: 'danger',
  });
  if (!confirmed) return;

  const res = await api.entries.bulkRemove(ids);
  if (!res.ok) return toast(res.error.message, 'bad');

  state.selectedId = null;
  state.bulkSelected.clear();
  await refresh();
  toast(`${res.value.deleted} item${res.value.deleted === 1 ? '' : 's'} deleted`);
});

$('bulkbar-move-btn').addEventListener('click', async () => {
  const ids = liveBulkSelection();
  if (ids.length === 0) return;

  const folder = $('bulkbar-folder').value.trim();
  const res = await api.entries.bulkMove(ids, folder);
  if (!res.ok) return toast(res.error.message, 'bad');

  state.bulkSelected.clear();
  await refresh();

  const { moved } = res.value;
  const destination = folder || 'no folder';
  if (moved === 0) {
    toast(`Already in ${destination}`);
  } else {
    const skipped = ids.length - moved;
    toast(
      `Moved ${moved} item${moved === 1 ? '' : 's'} to ${destination}` +
        (skipped ? ` (${skipped} already there)` : '')
    );
  }
});

// ----------------------------------------------------------------- editor modal

async function openEditor(id = null) {
  state.editingId = id;
  hideError($('editor-error'));

  const nameEl = $('entry-name');
  const userEl = $('entry-username');
  const passEl = $('entry-password');
  const urlEl = $('entry-url');
  const folderEl = $('entry-folder');
  const notesEl = $('entry-notes');
  const favEl = $('entry-favorite');

  if (id) {
    const entry = state.entries.find((e) => e.id === id);
    if (!entry) return;

    $('editor-title').textContent = 'Edit item';
    $('editor-save').textContent = 'Save changes';
    nameEl.value = entry.name;
    userEl.value = entry.username;
    urlEl.value = entry.url;
    folderEl.value = entry.folder;
    notesEl.value = entry.notes;
    favEl.checked = entry.favorite;

    const res = await api.entries.reveal(id);
    passEl.value = res.ok ? res.value : '';
  } else {
    $('editor-title').textContent = 'Add item';
    $('editor-save').textContent = 'Save item';
    nameEl.value = '';
    userEl.value = '';
    passEl.value = '';
    urlEl.value = '';
    folderEl.value = state.view.startsWith('folder:') ? state.view.slice(7) : '';
    notesEl.value = '';
    favEl.checked = false;
  }

  resetPeek('entry-password');
  paintStrength($('entry-strength'), passEl.value, '');
  $('genopts').open = false;
  openModal('modal-editor');
  nameEl.focus();
}

$('form-editor').addEventListener('submit', async (event) => {
  event.preventDefault();
  const err = $('editor-error');
  const name = $('entry-name').value.trim();
  if (!name) return showError(err, 'Give the item a name so you can find it later.');
  hideError(err);

  const payload = {
    name,
    username: $('entry-username').value,
    password: $('entry-password').value,
    url: $('entry-url').value,
    folder: $('entry-folder').value,
    notes: $('entry-notes').value,
    favorite: $('entry-favorite').checked,
  };

  // Read before closing: closeModal('modal-editor') zeroes state.editingId as
  // part of clearing the dialog's secrets, so anything below that needs to know
  // "was this an edit or a new item" has to capture it first. Reading it after
  // close previously meant every edit reported "added" instead of "saved".
  const wasEditing = Boolean(state.editingId);

  const btn = $('editor-save');
  btn.disabled = true;
  btn.textContent = 'Saving…';

  const res = wasEditing
    ? await api.entries.update(state.editingId, payload)
    : await api.entries.add(payload);

  btn.disabled = false;
  btn.textContent = wasEditing ? 'Save changes' : 'Save item';

  if (!res.ok) return showError(err, res.error.message);

  const savedId = wasEditing ? state.editingId : res.value.id;
  clearEditorSecrets();
  closeModal('modal-editor');

  state.selectedId = savedId;
  clearRevealTimer();
  state.revealedId = null;
  await refresh();
  toast(wasEditing ? 'Changes saved' : `“${name}” added`);
});

function clearEditorSecrets() {
  $('entry-password').value = '';
  resetPeek('entry-password');
  paintStrength($('entry-strength'), '', '');
}

$('entry-password').addEventListener('input', (event) => {
  paintStrength($('entry-strength'), event.target.value, '');
});

/**
 * Read generator options from a set of controls. The editor and the standalone
 * generator have identical controls under different id prefixes, so they share
 * this rather than each hand-rolling the same object.
 */
function genOptions(prefix) {
  return {
    length: Number($(`${prefix}-length`).value),
    upper: $(`${prefix}-upper`).checked,
    lower: $(`${prefix}-lower`).checked,
    digits: $(`${prefix}-digits`).checked,
    symbols: $(`${prefix}-symbols`).checked,
    avoidAmbiguous: $(`${prefix}-ambiguous`).checked,
  };
}

$('btn-generate').addEventListener('click', async () => {
  const res = await api.generatePassword(genOptions('gen'));
  if (!res.ok) return toast(res.error.message, 'bad');

  const input = $('entry-password');
  input.value = res.value;
  // Show it — a password you cannot read is one you cannot sanity-check.
  input.type = 'text';
  paintPeek(document.querySelector('[data-peek="entry-password"]'), true);
  paintStrength($('entry-strength'), res.value, '');
  $('genopts').open = true;
});

$('gen-length').addEventListener('input', (event) => {
  $('gen-length-value').textContent = event.target.value;
});

// --------------------------------------------------------------- settings modal

$('btn-settings').addEventListener('click', async () => {
  const res = await api.settings.get();
  if (res.ok) {
    state.settings = res.value;
    $('set-autolock').value = String(res.value.autoLockMinutes ?? 5);
    $('set-browser').checked = res.value.browserIntegration !== false;
  }
  await paintBridgeState();
  $('master-current').value = '';
  $('master-new').value = '';
  $('master-confirm').value = '';
  hideError($('master-error'));
  $('master-ok').hidden = true;
  paintStrength($('master-strength'), '', '');
  openModal('modal-settings');
});

$('set-autolock').addEventListener('change', async (event) => {
  const minutes = Number(event.target.value);
  const res = await api.settings.update({ autoLockMinutes: minutes });
  if (!res.ok) return toast(res.error.message, 'bad');
  state.settings = res.value;
  resetIdleTimer();
  toast(minutes === 0 ? 'Auto-lock turned off' : `Auto-lock set to ${minutes} min`);
});

$('set-browser').addEventListener('change', async (event) => {
  const on = event.target.checked;
  const res = await api.settings.update({ browserIntegration: on });
  if (!res.ok) {
    event.target.checked = !on;
    return toast(res.error.message, 'bad');
  }
  state.settings = res.value;
  await paintBridgeState();
  toast(on ? 'Browser integration on' : 'Browser integration off');
});

/** Report whether Chrome can actually reach the vault right now. */
async function paintBridgeState() {
  const el = $('browser-state');
  const hint = $('browser-state-hint');
  const res = await api.bridge.status();
  if (!res.ok) {
    el.textContent = 'Could not read the integration status.';
    hint.textContent = '';
    return;
  }
  const { running, enabled } = res.value;
  if (!enabled) {
    el.textContent =
      'Off — Chrome cannot reach your vault. Nothing is listening for the extension.';
    hint.textContent = 'Off';
  } else if (running) {
    el.textContent =
      'On and listening. Chrome can fill and save logins while the vault is unlocked; ' +
      'locking stops it immediately.';
    hint.textContent = 'On';
  } else {
    el.textContent = 'On, but not listening yet — this usually means the vault just locked.';
    hint.textContent = 'On';
  }
}

$('master-new').addEventListener('input', (event) => {
  paintStrength($('master-strength'), event.target.value, '');
});

$('form-master').addEventListener('submit', async (event) => {
  event.preventDefault();
  const err = $('master-error');
  $('master-ok').hidden = true;

  const current = $('master-current').value;
  const next = $('master-new').value;
  const confirm = $('master-confirm').value;

  if (!current) return showError(err, 'Enter your current master password.');
  if (next.length < 8) return showError(err, 'The new password must be at least 8 characters.');
  if (next !== confirm) return showError(err, 'The new passwords do not match.');
  hideError(err);

  const res = await api.vault.changeMaster(current, next);
  if (!res.ok) return showError(err, res.error.message);

  $('master-current').value = '';
  $('master-new').value = '';
  $('master-confirm').value = '';
  paintStrength($('master-strength'), '', '');
  $('master-ok').hidden = false;
  toast('Master password updated');
});

// ------------------------------------------------------------ generator modal

/**
 * A generator you can reach without creating an item first — for the times you
 * need a strong value for something One Key isn't storing, or want to see one
 * before deciding.
 *
 * The password lives only in this dialog until it is copied or saved.
 */
let generated = '';

async function regenerate() {
  const res = await api.generatePassword(genOptions('pg'));
  if (!res.ok) {
    generated = '';
    $('pg-value').textContent = '';
    return toast(res.error.message, 'bad');
  }
  generated = res.value;
  $('pg-value').textContent = generated;
  paintStrength($('pg-strength'), generated, '');
}

async function openGenerator() {
  $('pg-length-value').textContent = $('pg-length').value;
  await regenerate();
  openModal('modal-generator');
  $('pg-again').focus();
}

$('btn-generator').addEventListener('click', openGenerator);
$('pg-again').addEventListener('click', regenerate);

// Any option change produces a new password, so what's shown always matches the
// settings above it.
$('pg-length').addEventListener('input', (event) => {
  $('pg-length-value').textContent = event.target.value;
  regenerate();
});
for (const id of ['pg-upper', 'pg-lower', 'pg-digits', 'pg-symbols', 'pg-ambiguous']) {
  $(id).addEventListener('change', regenerate);
}

$('pg-copy').addEventListener('click', async () => {
  if (!generated) return;
  const res = await api.clipboard.copyText(generated, 30);
  if (!res.ok) return toast(res.error.message, 'bad');
  toast(
    res.value.clearAfterSeconds
      ? `Copied — clipboard clears in ${res.value.clearAfterSeconds}s`
      : 'Copied'
  );
});

$('pg-new-item').addEventListener('click', async () => {
  const password = generated;
  closeModal('modal-generator');
  await openEditor(null);
  if (!password) return;

  $('entry-password').value = password;
  // Show it: a password you cannot read is one you cannot check.
  $('entry-password').type = 'text';
  paintPeek(document.querySelector('[data-peek="entry-password"]'), true);
  paintStrength($('entry-strength'), password, '');
  $('entry-name').focus();
});

// ------------------------------------------------------- import / export modal

/**
 * One dialog serves three flows, because they differ only in which password is
 * being asked for and what happens on submit.
 */
const TRANSFER = {
  backup: {
    title: 'Export encrypted backup',
    lede:
      'Choose a password for the backup file. It can differ from your master password — ' +
      'but without it the backup cannot be opened, and there is no way to recover it.',
    label: 'Backup password',
    confirm: true,
    strength: true,
    submit: 'Choose location…',
  },
  restore: {
    title: 'Import from backup',
    lede: 'Enter the password this backup was saved with.',
    label: 'Backup password',
    confirm: false,
    strength: false,
    submit: 'Import',
  },
};

let transferMode = null;

function openTransfer(mode, ledeOverride) {
  transferMode = mode;
  const spec = TRANSFER[mode];

  $('transfer-title').textContent = spec.title;
  $('transfer-lede').textContent = ledeOverride || spec.lede;
  $('transfer-label-1').textContent = spec.label;
  $('transfer-field-2').hidden = !spec.confirm;
  $('transfer-strength').hidden = !spec.strength;
  $('transfer-submit').textContent = spec.submit;

  $('transfer-password').value = '';
  $('transfer-confirm').value = '';
  resetPeek('transfer-password');
  hideError($('transfer-error'));
  $('transfer-note').hidden = true;
  if (spec.strength) paintStrength($('transfer-strength'), '', '');

  openModal('modal-transfer');
  $('transfer-password').focus();
}

$('transfer-password').addEventListener('input', (event) => {
  if (transferMode && TRANSFER[transferMode].strength) {
    paintStrength($('transfer-strength'), event.target.value, '');
  }
});

$('form-transfer').addEventListener('submit', async (event) => {
  event.preventDefault();

  // Read the mode once, up front. closeModal() clears transferMode as part of
  // tidying the dialog, so anything that inspects it after closing sees null —
  // which previously sent a finished import down the export branch and reported
  // "Export cancelled" for a successful restore.
  const mode = transferMode;
  if (!mode) return;

  const spec = TRANSFER[mode];
  const err = $('transfer-error');
  const password = $('transfer-password').value;

  if (!password) return showError(err, `Enter your ${spec.label.toLowerCase()}.`);
  if (spec.confirm) {
    if (password.length < 8) return showError(err, 'Use at least 8 characters.');
    if (password !== $('transfer-confirm').value) {
      return showError(err, 'The two passwords do not match.');
    }
  }
  hideError(err);

  const btn = $('transfer-submit');
  btn.disabled = true;
  btn.textContent = 'Working…';

  const res =
    mode === 'backup'
      ? await api.transfer.exportBackup(password)
      : await api.transfer.applyImport(password);

  btn.disabled = false;
  btn.textContent = spec.submit;

  // Leave the dialog open on failure so the password can be corrected.
  if (!res.ok) return showError(err, res.error.message);

  $('transfer-password').value = '';
  $('transfer-confirm').value = '';
  // Clearing the mode first stops closeModal from cancelling an import that has
  // already been applied.
  transferMode = null;
  closeModal('modal-transfer');

  if (mode === 'restore') {
    await refresh();
    toast(describeImport(res.value));
    return;
  }

  toast(
    res.value.saved
      ? `Exported ${res.value.count} item${res.value.count === 1 ? '' : 's'}`
      : 'Export cancelled'
  );
});

function describeImport({ added, duplicates }) {
  if (added === 0) {
    return duplicates
      ? `Nothing new — all ${duplicates} already in your vault`
      : 'Nothing to import';
  }
  const parts = [`Imported ${added} item${added === 1 ? '' : 's'}`];
  if (duplicates) parts.push(`${duplicates} already present`);
  return parts.join(' · ');
}

$('btn-export-backup').addEventListener('click', () => openTransfer('backup'));

$('btn-import').addEventListener('click', async () => {
  const res = await api.transfer.inspectImport();
  if (!res.ok) return toast(res.error.message, 'bad');
  if (!res.value.chosen) return;

  // Only encrypted backups are accepted, so the next step is always its password.
  openTransfer('restore');
});

// ------------------------------------------------------------------ about modal

/**
 * Populated from the main process rather than hardcoded, so the version shown
 * is always the one that actually shipped.
 */
async function openAbout() {
  const res = await api.appInfo();
  if (res.ok) {
    const info = res.value;
    $('about-name').textContent = info.name;
    $('about-version').textContent = `Version ${info.version}`;
    $('about-creator').textContent = info.creator;
    $('about-platform').textContent = info.platform;
    $('about-electron').textContent = info.electron;
    $('about-chromium').textContent = info.chrome;
    $('about-node').textContent = info.node;
    $('about-copyright').textContent = `© ${info.copyrightYear} ${info.creator}`;
  }
  openModal('modal-about');
}

// ---------------------------------------------------------------------- modals

// Element that had focus just before each currently-open modal was opened, so
// closing it can hand focus back rather than dropping it onto <body>.
const modalPreviousFocus = new Map();

function openModal(id) {
  modalPreviousFocus.set(id, document.activeElement);
  $(id).hidden = false;
  syncModalInertness();

  // Several callers immediately follow this with their own more specific
  // .focus() on a particular field, which simply overrides this a moment
  // later — but callers that don't (Settings, About, Import & export) would
  // otherwise leave focus wherever the browser's fixup logic puts it once the
  // previously-focused button becomes inert, which is not guaranteed to be
  // inside the dialog at all. Guarantee a sane baseline here instead of
  // depending on that.
  const panel = $(id);
  if (!panel.contains(document.activeElement)) {
    const focusable = panel.querySelector(
      'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
    );
    if (focusable) focusable.focus();
  }
}

function closeModal(id) {
  $(id).hidden = true;
  if (id === 'modal-editor') {
    clearEditorSecrets();
    state.editingId = null;
  }
  if (id === 'modal-confirm') {
    // Any close that isn't the Delete button's own handler (Cancel, backdrop,
    // ×, Escape, or the vault locking underneath it) means "don't delete".
    settleConfirm(false);
  }
  if (id === 'modal-generator') {
    // Don't leave a generated password on screen behind a closed dialog.
    generated = '';
    $('pg-value').textContent = '';
  }
  if (id === 'modal-transfer') {
    // Don't leave a typed password sitting in the field, and drop any file the
    // main process is holding for an import that was abandoned.
    $('transfer-password').value = '';
    $('transfer-confirm').value = '';
    resetPeek('transfer-password');
    if (transferMode === 'restore') api.transfer.cancelImport();
    transferMode = null;
  }
  if (id === 'modal-settings') {
    // Every other secret-bearing dialog wipes its fields on close, but this one
    // only cleared on open or on a successful submit — so a new master password
    // typed and then dismissed via Escape/backdrop/× (or an auto-lock firing
    // underneath it) was left sitting in the DOM indefinitely.
    $('master-current').value = '';
    $('master-new').value = '';
    $('master-confirm').value = '';
    resetPeek('master-new');
    paintStrength($('master-strength'), '', '');
    hideError($('master-error'));
    $('master-ok').hidden = true;
  }

  syncModalInertness();

  // Hand focus back to whatever had it before this modal opened — usually the
  // button that opened it — rather than dropping focus onto <body>, which is
  // what happens by default once the focused element inside the modal becomes
  // inert. Skipped if that element is gone (e.g. the row it belonged to was
  // deleted) or has itself become inert (a modal closing out from under
  // another one that's still open).
  const previous = modalPreviousFocus.get(id);
  modalPreviousFocus.delete(id);
  if (previous && document.contains(previous) && !previous.closest('[inert]')) {
    previous.focus();
  }
}

/**
 * Keep exactly one surface interactive at a time: the topmost open modal, or
 * the app shell itself if none are open.
 *
 * `inert` (native, no polyfill needed) removes an entire subtree from the tab
 * order, from click/pointer handling, and from the accessibility tree in one
 * step — a plain Tab-key handler would only have covered the keyboard case,
 * leaving the sidebar/list still clickable through a modal's backdrop and
 * still exposed to screen readers as if the dialog weren't there.
 *
 * MODALS is already ordered by stacking priority for closeTopModal's sake
 * (last entry = topmost when more than one happens to be open), so the same
 * order decides which single modal stays interactive here.
 */
function syncModalInertness() {
  const open = MODALS.filter((id) => !$(id).hidden);
  const topmost = open[open.length - 1] || null;

  $('screen-app').inert = open.length > 0;

  for (const id of MODALS) {
    const el = $(id);
    if (el.hidden) continue; // already outside the tab order; nothing to do
    el.inert = id !== topmost;
  }
}

// Order matters: closeTopModal walks this backwards, so a dialog that can open
// on top of another must come later. The password prompt opens over the
// import/export dialog, so it sits last.
const MODALS = [
  'modal-editor',
  'modal-settings',
  'modal-about',
  'modal-generator',
  'modal-portability',
  'modal-transfer',
  'modal-confirm',
];

function anyModalOpen() {
  return MODALS.some((id) => !$(id).hidden);
}

/** Topmost-first, so Escape closes only the dialog the user is looking at. */
function closeTopModal() {
  const open = [...MODALS].reverse().find((id) => !$(id).hidden);
  if (open) closeModal(open);
  return Boolean(open);
}

// ------------------------------------------------------------------- global UI

function wireGlobalUi() {
  // Reveal/hide toggles on every password field.
  for (const btn of document.querySelectorAll('[data-peek]')) {
    paintPeek(btn, false);
    btn.addEventListener('click', () => {
      const input = $(btn.dataset.peek);
      const showing = input.type === 'text';
      input.type = showing ? 'password' : 'text';
      paintPeek(btn, !showing);
    });
  }

  for (const el of document.querySelectorAll('[data-close]')) {
    el.addEventListener('click', () => closeModal(el.dataset.close));
  }

  for (const btn of $('nav').querySelectorAll('.nav__item')) {
    btn.addEventListener('click', () => setView(btn.dataset.view));
  }

  $('btn-add').addEventListener('click', () => openEditor(null));
  $('btn-transfer').addEventListener('click', () => openModal('modal-portability'));
  $('btn-about').addEventListener('click', openAbout);
  $('btn-lock').addEventListener('click', lockNow);

  // The menu item works on any screen, including while locked.
  api.onShowAbout(openAbout);

  const search = $('search');
  search.addEventListener('input', () => {
    state.search = search.value;
    $('search-clear').hidden = search.value === '';
    state.selectedId = null;
    renderList();
    renderDetail();
  });
  $('search-clear').addEventListener('click', () => {
    search.value = '';
    state.search = '';
    $('search-clear').hidden = true;
    renderList();
    renderDetail();
    search.focus();
  });

  document.addEventListener('keydown', onGlobalKey);

  for (const evt of ['mousemove', 'mousedown', 'keydown', 'wheel']) {
    window.addEventListener(evt, markActivity, { passive: true });
  }
  setInterval(checkIdle, 15000);
}

function onGlobalKey(event) {
  const mod = event.ctrlKey || event.metaKey;

  if (event.key === 'Escape') {
    closeTopModal();
    return;
  }

  if ($('screen-app').hidden) return;

  if (mod && event.key.toLowerCase() === 'l') {
    event.preventDefault();
    return void lockNow();
  }
  if (anyModalOpen()) return;

  if (mod && event.key.toLowerCase() === 'f') {
    event.preventDefault();
    $('search').select();
    return;
  }
  if (mod && event.key.toLowerCase() === 'n') {
    event.preventDefault();
    return void openEditor(null);
  }
  if (mod && event.key.toLowerCase() === 'g') {
    event.preventDefault();
    return void openGenerator();
  }
  if (mod && event.key.toLowerCase() === 'c' && state.selectedId) {
    // Never steal Ctrl+C from a real copy: not from a text field, and not when
    // the user has a document selection.
    const el = document.activeElement;
    const inField = el && /^(input|textarea|select)$/i.test(el.tagName);
    if (!inField && String(window.getSelection() || '') === '') {
      event.preventDefault();
      return void copyField(state.selectedId, 'password');
    }
  }

  if ((event.key === 'ArrowDown' || event.key === 'ArrowUp') && !anyModalOpen()) {
    const items = visibleEntries();
    if (items.length === 0) return;
    event.preventDefault();
    const at = items.findIndex((e) => e.id === state.selectedId);
    const next =
      event.key === 'ArrowDown'
        ? Math.min(items.length - 1, at + 1)
        : Math.max(0, at <= 0 ? 0 : at - 1);
    select(items[next].id);
    const row = $('list').children[next];
    if (row) row.scrollIntoView({ block: 'nearest' });
  }
}

// --------------------------------------------------------------- idle auto-lock

let lastActivity = Date.now();

function markActivity() {
  lastActivity = Date.now();
}

function resetIdleTimer() {
  lastActivity = Date.now();
}

function checkIdle() {
  if ($('screen-app').hidden) return;
  const minutes = state.settings.autoLockMinutes ?? 5;
  if (!minutes) return;
  if (Date.now() - lastActivity >= minutes * 60000) {
    api.idleLock();
  }
}

// ----------------------------------------------------------------- DOM helpers

function svgIcon(inner) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', 'ico');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.8');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.innerHTML = inner; // static markup only — never user data
  return svg;
}

function textSpan(text) {
  const span = document.createElement('span');
  span.textContent = text;
  return span;
}

function countSpan(n) {
  const span = document.createElement('span');
  span.className = 'nav__count';
  span.textContent = n;
  return span;
}

function metaSpan(text) {
  const span = document.createElement('span');
  span.textContent = text;
  return span;
}

function badge(text, tone) {
  const span = document.createElement('span');
  span.className = `badge ${tone}`;
  span.textContent = text;
  return span;
}

function actionButton(title, iconMarkup, onClick) {
  const btn = document.createElement('button');
  btn.className = 'row__act';
  btn.title = title;
  btn.setAttribute('aria-label', title);
  btn.append(svgIcon(iconMarkup));
  btn.addEventListener('click', onClick);
  return btn;
}

function smallButton(label, onClick) {
  const btn = document.createElement('button');
  btn.className = 'mini-btn';
  btn.type = 'button';
  btn.textContent = label;
  btn.addEventListener('click', onClick);
  return btn;
}

function detailField(label, build) {
  const wrap = document.createElement('div');
  wrap.className = 'dfield';

  const title = document.createElement('p');
  title.className = 'dfield__label';
  title.textContent = label;

  const value = document.createElement('div');
  value.className = 'dfield__value';
  build(value);

  wrap.append(title, value);
  return wrap;
}

const AVATAR_COLORS = [
  ['#e2504b', '#b8332f'],
  ['#4b7fe2', '#2f55b8'],
  ['#3fbf8f', '#288f68'],
  ['#c46be2', '#8f3fb8'],
  ['#e2a04b', '#b8752f'],
  ['#4bc6e2', '#2f95b8'],
  ['#8f8fe2', '#5f5fb8'],
];

function buildAvatar(name, className) {
  const el = document.createElement('div');
  el.className = className;

  const letters = (name || '?')
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0].toUpperCase())
    .join('');
  el.textContent = letters || '?';

  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = (hash * 31 + name.charCodeAt(i)) >>> 0;
  const [from, to] = AVATAR_COLORS[hash % AVATAR_COLORS.length];
  el.style.background = `linear-gradient(145deg, ${from}, ${to})`;
  return el;
}

function paintStrength(container, password, emptyHint) {
  const fill = container.querySelector('.strength__fill');
  const label = container.querySelector('.strength__label');

  if (!password) {
    container.dataset.level = '0';
    fill.style.width = '0%';
    label.textContent = emptyHint || '';
    // With nothing typed and nothing to say, an empty bar just reads as a stray
    // divider — so take it out of the layout entirely.
    container.hidden = !emptyHint;
    return;
  }

  container.hidden = false;
  const est = strength.estimate(password);
  container.dataset.level = String(est.score);
  fill.style.width = `${strength.widthFor(est.score)}%`;
  label.textContent = `${est.label} · about ${est.bits} bits of entropy`;
}

const EYE = '<path d="M2 12s3.6-6.5 10-6.5S22 12 22 12s-3.6 6.5-10 6.5S2 12 2 12z"/><circle cx="12" cy="12" r="2.6"/>';
const EYE_OFF =
  '<path d="M4 4l16 16"/><path d="M9.9 5.7A10.5 10.5 0 0112 5.5c6.4 0 10 6.5 10 6.5a17 17 0 01-2.7 3.5"/>' +
  '<path d="M6.4 7.9A16.7 16.7 0 002 12s3.6 6.5 10 6.5c1.4 0 2.6-.3 3.7-.8"/><path d="M10.2 10.3a2.6 2.6 0 003.6 3.6"/>';

/** Swap the peek button's icon to match whether the password is visible. */
function paintPeek(btn, visible) {
  btn.replaceChildren(svgIcon(visible ? EYE_OFF : EYE));
  btn.classList.toggle('is-on', visible);
  btn.title = visible ? 'Hide password' : 'Show password';
  btn.setAttribute('aria-label', btn.title);
}

function resetPeek(inputId) {
  const input = $(inputId);
  input.type = 'password';
  const btn = document.querySelector(`[data-peek="${inputId}"]`);
  if (btn) paintPeek(btn, false);
}

function showError(el, message) {
  el.textContent = message;
  el.hidden = false;
}

function hideError(el) {
  el.hidden = true;
  el.textContent = '';
}

function hostOf(url) {
  if (!url) return '';
  try {
    return new URL(/^https?:\/\//i.test(url) ? url : `https://${url}`).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}

function formatDate(iso) {
  if (!iso) return 'unknown';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return 'unknown';
  return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

function renderFolderOptions() {
  const list = $('folder-options');
  list.replaceChildren();
  for (const folder of [...new Set(state.entries.map((e) => e.folder).filter(Boolean))].sort()) {
    const opt = document.createElement('option');
    opt.value = folder;
    list.append(opt);
  }
}

// --------------------------------------------------------------------- toasts

function toast(message, kind = 'ok') {
  const el = document.createElement('div');
  el.className = 'toast' + (kind === 'bad' ? ' toast--bad' : '');
  el.textContent = message;
  $('toasts').append(el);

  setTimeout(() => {
    el.classList.add('is-out');
    setTimeout(() => el.remove(), 280);
  }, 2400);
}

boot();
