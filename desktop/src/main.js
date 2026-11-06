'use strict';

/**
 * One Key — Electron main process.
 *
 * All crypto, file I/O and plaintext secrets live here. The renderer is
 * sandboxed with context isolation and can only reach this side through the
 * narrow, explicitly-listed channels in preload.js.
 */

const {
  app,
  BrowserWindow,
  ipcMain,
  clipboard,
  shell,
  Menu,
  dialog,
  Tray,
  nativeImage,
} = require('electron');
const path = require('path');
const os = require('os');
const fs = require('fs');

const fsp = require('fs/promises');

const { Vault, VaultError } = require('./vault');
const { generatePassword } = require('./crypto');
const { Bridge } = require('./bridge');
const { BACKUP_FORMAT, makeBackup, readBackup } = require('./portability');
const { AppError } = require('./errors');

const vault = new Vault(path.join(app.getPath('userData'), 'vault'));

let mainWindow = null;
let clipboardClearTimer = null;
let clipboardToken = null;

// Closing the window hides it to the notification area instead of quitting, so
// the vault stays available to the Chrome extension without a window in the way.
// Only an explicit Quit ends the process.
let tray = null;
let isQuitting = false;
let trayHintShown = false;

// A file chosen for import, held between "inspect" and "apply" so the renderer
// never has to carry the file's contents — or a backup's decrypted entries.
let pendingImport = null;

// ------------------------------------------------------------------ browser bridge

const bridge = new Bridge({
  dir: vault.dir,
  handlers: {
    status: () => ({ state: 'unlocked', itemCount: vault.listEntries().length }),
    match: (url) => vault.matchEntriesForUrl(url),
    credential: (id, url) => vault.credentialFor(id, url),
    checkSave: (input) => vault.classifySave(input),
    save: (input) => vault.applySave(input),
    // Generation touches no stored data, so this reveals nothing. It is here so
    // the extension can offer a strong password on a signup form without the
    // user leaving the page.
    generate: (options) => generatePassword(options || {}),
  },
  onActivity: (kind, detail) => notifyBrowserActivity(kind, detail),
});

/**
 * The bridge is only listening while the vault is unlocked and the user has
 * browser integration switched on, so "locked" needs no separate check — the
 * pipe simply isn't there.
 */
async function syncBridge() {
  const wanted = vault.isUnlocked && vault.getSettings().browserIntegration !== false;
  try {
    if (wanted && !bridge.isRunning) await bridge.start();
    else if (!wanted && bridge.isRunning) await bridge.stop();
  } catch (err) {
    console.error('[one-key] could not change bridge state:', err.message);
  }
  updateTray();
}

/** Surface every browser-driven read or write in the app, so none of it is silent. */
function notifyBrowserActivity(kind, detail) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('browser:activity', { kind, ...detail });
  }
}

// Single instance only — two windows sharing one vault file would race on write.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    // Launching again while hidden in the tray should bring the window back,
    // which needs show() as well as focus().
    showWindow();
  });
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1180,
    height: 760,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: '#14161c',
    title: 'One Key',
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  });

  mainWindow.once('ready-to-show', () => mainWindow.show());
  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  // Never let the renderer navigate away or spawn new windows.
  mainWindow.webContents.on('will-navigate', (event) => event.preventDefault());
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    openExternal(url);
    return { action: 'deny' };
  });

  // Closing hides to the tray. The vault, and therefore the browser bridge,
  // stays alive — which is the point of running in the background.
  mainWindow.on('close', (event) => {
    if (isQuitting) return;
    event.preventDefault();
    mainWindow.hide();

    if (!trayHintShown && tray && !tray.isDestroyed()) {
      trayHintShown = true;
      try {
        tray.displayBalloon({
          title: 'One Key is still running',
          content:
            'Your vault stays available to Chrome. Use the tray icon to reopen, lock, or quit.',
        });
      } catch {
        // Balloons are best-effort on Windows; the tray icon is the real signal.
      }
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

// ---------------------------------------------------------------- tray icon

function showWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    createWindow();
    return;
  }
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

function quitForReal() {
  isQuitting = true;
  app.quit();
}

function buildTrayMenu() {
  return Menu.buildFromTemplate([
    { label: vault.isUnlocked ? 'Vault unlocked' : 'Vault locked', enabled: false },
    { type: 'separator' },
    { label: 'Open One Key', click: showWindow },
    {
      label: 'Lock vault',
      enabled: vault.isUnlocked,
      click: () => lockAndNotify('manual'),
    },
    { type: 'separator' },
    { label: 'Quit One Key', click: quitForReal },
  ]);
}

const TRAY_ICONS = {
  unlocked: loadTrayIcon('tray-unlocked.ico'),
  locked: loadTrayIcon('tray-locked.ico'),
};

function loadTrayIcon(filename) {
  const image = nativeImage.createFromPath(path.join(__dirname, 'assets', filename));
  return image.isEmpty() ? nativeImage.createEmpty() : image;
}

/**
 * Keep the icon, tooltip, and menu in step with the lock state.
 *
 * The icon swap is the important part: the tooltip and menu only tell you the
 * state if you already thought to hover or right-click, but a locked vault
 * being indistinguishable from an unlocked one at a glance is exactly the kind
 * of thing that leads to trusting a vault is closed when it isn't.
 */
function updateTray() {
  if (!tray || tray.isDestroyed()) return;
  tray.setImage(vault.isUnlocked ? TRAY_ICONS.unlocked : TRAY_ICONS.locked);
  tray.setToolTip(vault.isUnlocked ? 'One Key — unlocked' : 'One Key — locked');
  tray.setContextMenu(buildTrayMenu());
}

function createTray() {
  if (tray && !tray.isDestroyed()) return;

  tray = new Tray(TRAY_ICONS.locked); // the vault always starts locked
  tray.on('click', showWindow);
  tray.on('double-click', showWindow);
  updateTray();
}

/** Only ever hand http/https links to the OS browser. */
function openExternal(rawUrl) {
  try {
    const parsed = new URL(rawUrl);
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
      shell.openExternal(parsed.toString());
      return true;
    }
  } catch {
    /* not a URL — ignore */
  }
  return false;
}

function lockAndNotify(reason) {
  if (!vault.isUnlocked) return;
  vault.lock();
  // Tear the pipe down before anything else: a locked vault must not be
  // reachable from the browser even for a moment.
  bridge.stop().catch(() => {});
  clearClipboardNow();
  // Drop any half-finished import. The envelope it holds is encrypted, but it
  // has no business outliving the unlocked session that chose it.
  pendingImport = null;
  updateTray();
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('vault:locked', { reason });
  }
}

/** Put text on the clipboard and schedule the wipe. Shared by both copy paths. */
function putOnClipboard(text, clearAfterSeconds) {
  if (!text) return { copied: false, clearAfterSeconds: 0 };

  clearClipboardNow();
  clipboard.writeText(text);
  clipboardToken = text;

  const seconds = Math.max(0, Math.min(300, Number(clearAfterSeconds) || 0));
  if (seconds > 0) {
    clipboardClearTimer = setTimeout(clearClipboardNow, seconds * 1000);
  }
  return { copied: true, clearAfterSeconds: seconds };
}

function clearClipboardNow() {
  if (clipboardClearTimer) {
    clearTimeout(clipboardClearTimer);
    clipboardClearTimer = null;
  }
  // Only wipe if what's on the clipboard is still what we put there, so we
  // don't clobber something the user copied themselves in the meantime.
  if (clipboardToken !== null && clipboard.readText() === clipboardToken) {
    clipboard.clear();
  }
  clipboardToken = null;
}

/**
 * Wrap a handler so intended failures reach the UI with their own message, while
 * anything unexpected is reported generically — an unplanned error can carry a
 * stack or a file path, which has no place in the interface.
 */
function handle(channel, fn) {
  ipcMain.handle(channel, async (_event, ...args) => {
    try {
      return { ok: true, value: await fn(...args) };
    } catch (err) {
      // AppError covers VaultError too, since VaultError extends it. Portability
      // failures (wrong backup password, not a backup) come through this way as
      // well; before they did, a mistyped backup password surfaced as
      // "Something went wrong", which told the user nothing.
      const isKnown = err instanceof AppError;
      if (!isKnown) console.error(`[one-key] ${channel} failed:`, err);
      return {
        ok: false,
        error: {
          code: isKnown ? err.code : 'UNEXPECTED',
          message: isKnown ? err.message : 'Something went wrong. Please try again.',
        },
      };
    }
  });
}

// ------------------------------------------------------------------- IPC: vault

handle('vault:status', () => ({
  exists: vault.exists(),
  unlocked: vault.isUnlocked,
  path: vault.file,
}));

handle('vault:create', async (masterPassword) => {
  await vault.create(masterPassword);
  await syncBridge();
  return { settings: vault.getSettings() };
});

handle('vault:unlock', async (masterPassword) => {
  await vault.unlock(masterPassword);
  await syncBridge();
  return { settings: vault.getSettings() };
});

handle('vault:lock', () => {
  lockAndNotify('manual');
  return true;
});

handle('vault:changeMaster', async ({ currentPassword, newPassword }) => {
  await vault.changeMasterPassword(currentPassword, newPassword);
  return true;
});

// ----------------------------------------------------------------- IPC: entries

handle('entries:list', () => vault.listEntries());
handle('entries:add', (input) => vault.addEntry(input));
handle('entries:update', ({ id, patch }) => vault.updateEntry(id, patch));
handle('entries:delete', (id) => vault.deleteEntry(id));
handle('entries:reveal', (id) => vault.revealPassword(id));
handle('entries:bulkDelete', (ids) => vault.deleteEntries(ids));
handle('entries:bulkMove', ({ ids, folder }) => vault.moveEntriesToFolder(ids, folder));

// ---------------------------------------------------------------- IPC: settings

handle('settings:get', () => vault.getSettings());

handle('settings:update', async (patch) => {
  const settings = await vault.updateSettings(patch);
  await syncBridge();
  return settings;
});

handle('bridge:status', () => ({
  running: bridge.isRunning,
  enabled: vault.isUnlocked ? vault.getSettings().browserIntegration !== false : null,
  extensionId: 'nofckpbcfemncfcodiedbngfgobfkgok',
}));

// ------------------------------------------------------------------ IPC: misc

/**
 * Copy a field to the clipboard. The renderer names a field rather than
 * sending the secret, so passwords never round-trip through the UI just to be
 * copied.
 */
handle('clipboard:copyField', ({ id, field, clearAfterSeconds = 30 }) => {
  let text;
  if (field === 'password') {
    text = vault.revealPassword(id);
  } else {
    const entry = vault.listEntries().find((e) => e.id === id);
    if (!entry) throw new VaultError('NOT_FOUND', 'That entry no longer exists.');
    // listEntries() only ever strips the password, so username/url/notes are
    // all already present on the redacted entry.
    text = { username: entry.username, url: entry.url, notes: entry.notes }[field] || '';
  }
  return putOnClipboard(text, clearAfterSeconds);
});

/**
 * Copy text the renderer already holds — a freshly generated password, which
 * exists only in the generator until the user does something with it.
 */
handle('clipboard:copyText', ({ text, clearAfterSeconds = 30 }) =>
  putOnClipboard(String(text || ''), clearAfterSeconds)
);

handle('clipboard:clear', () => {
  clearClipboardNow();
  return true;
});

// -------------------------------------------------------- IPC: import / export

/**
 * Finds a synced Google Drive Desktop folder, if one is installed, so the
 * export dialog can default there. Only ever offered as the dialog's starting
 * point — the user still picks and confirms the exact save location.
 */
function findGoogleDriveFolder() {
  const home = os.homedir();
  const candidates = [
    path.join(home, 'My Drive'), // Drive for desktop, mirrored under the user profile
    path.join(home, 'Google Drive', 'My Drive'),
    path.join(home, 'Google Drive'), // legacy Backup and Sync
  ];
  for (let code = 67; code <= 90; code++) {
    candidates.push(`${String.fromCharCode(code)}:\\My Drive`); // Drive for desktop's own drive letter
  }
  for (const candidate of candidates) {
    try {
      if (fs.statSync(candidate).isDirectory()) return candidate;
    } catch {
      /* not this one */
    }
  }
  return null;
}

/**
 * Encrypted backup. Written under a password the user picks, so a backup can be
 * kept anywhere without exposing anything.
 */
handle('vault:exportBackup', async ({ password }) => {
  const entries = vault.exportEntries();
  const envelope = await makeBackup(entries, password, new Date().toISOString());

  const stamp = new Date().toISOString().slice(0, 10);
  const fileName = `one-key-backup-${stamp}.onekey`;
  const driveFolder = findGoogleDriveFolder();
  const { canceled, filePath } = await dialog.showSaveDialog(mainWindow, {
    title: 'Save encrypted backup',
    defaultPath: driveFolder ? path.join(driveFolder, fileName) : fileName,
    filters: [{ name: 'One Key backup', extensions: ['onekey'] }],
  });
  if (canceled || !filePath) return { saved: false };

  await fsp.writeFile(filePath, JSON.stringify(envelope, null, 2), 'utf8');
  return { saved: true, path: filePath, count: entries.length };
});

/**
 * Pick a backup to import, without changing anything yet.
 *
 * Only One Key's own encrypted backups are accepted. Anything else is refused
 * here rather than parsed, so no plaintext credential file is ever read.
 */
handle('vault:inspectImport', async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, {
    title: 'Import from encrypted backup',
    properties: ['openFile'],
    filters: [
      { name: 'One Key backup', extensions: ['onekey'] },
      { name: 'All files', extensions: ['*'] },
    ],
  });
  if (canceled || filePaths.length === 0) return { chosen: false };

  const filePath = filePaths[0];
  const text = await fsp.readFile(filePath, 'utf8');

  let envelope = null;
  try {
    const parsed = JSON.parse(text);
    if (parsed && parsed.format === BACKUP_FORMAT) envelope = parsed;
  } catch {
    /* not JSON, so certainly not one of our backups */
  }

  if (!envelope) {
    throw new VaultError(
      'NOT_BACKUP',
      'That is not a One Key backup. Only .onekey backup files can be imported.'
    );
  }

  pendingImport = { kind: 'backup', filePath, envelope };
  return { chosen: true, path: filePath };
});

/** Apply the backup chosen by inspectImport, given its password. */
handle('vault:applyImport', async ({ password } = {}) => {
  if (!pendingImport) throw new VaultError('NOTHING_PENDING', 'Choose a backup to import first.');

  const { entries } = await readBackup(pendingImport.envelope, password || '');
  const result = await vault.importEntries(entries);
  pendingImport = null;
  return result;
});

handle('vault:cancelImport', () => {
  pendingImport = null;
  return true;
});

handle('password:generate', (opts) => generatePassword(opts || {}));

handle('shell:openExternal', (url) => openExternal(url));

const OS_NAMES = { win32: 'Windows', darwin: 'macOS', linux: 'Linux' };

/** Everything the About dialog needs. Safe to call while locked. */
handle('app:info', () => ({
  name: app.getName(),
  version: app.getVersion(),
  creator: 'One Key Team',
  copyrightYear: new Date().getFullYear(),
  electron: process.versions.electron,
  chrome: process.versions.chrome,
  node: process.versions.node,
  platform: `${OS_NAMES[process.platform] || process.platform} (${process.arch})`,
}));

handle('app:idleLock', () => {
  lockAndNotify('idle');
  return true;
});

// --------------------------------------------------------------------- app life

app.whenReady().then(() => {
  // A minimal menu: a lock accelerator, and no dev tooling. The Edit submenu is
  // macOS-only on purpose — on Windows Chromium already handles Ctrl+C/V/X in
  // text fields, and registering a Ctrl+C menu role here would swallow the
  // renderer's "copy the selected item's password" shortcut.
  const template = [
    {
      label: 'One Key',
      submenu: [
        {
          label: 'About One Key',
          click: () => {
            if (mainWindow && !mainWindow.isDestroyed()) {
              mainWindow.webContents.send('app:showAbout');
            }
          },
        },
        { type: 'separator' },
        {
          label: 'Lock Vault',
          accelerator: 'CmdOrCtrl+L',
          click: () => lockAndNotify('manual'),
        },
        { type: 'separator' },
        { role: 'quit' },
      ],
    },
  ];

  if (process.platform === 'darwin') {
    template.push({
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' },
      ],
    });
  }

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));

  createTray();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

// The tray icon means the app deliberately outlives its window; quitting is an
// explicit choice, made from the tray or the menu.
app.on('window-all-closed', () => {
  if (isQuitting) app.quit();
});

app.on('before-quit', () => {
  isQuitting = true;
  vault.lock();
  bridge.stop().catch(() => {});
  clearClipboardNow();
  if (tray && !tray.isDestroyed()) tray.destroy();
});

// Belt and braces: refuse any renderer attempt to attach a webview or navigate out.
app.on('web-contents-created', (_event, contents) => {
  contents.on('will-attach-webview', (event) => event.preventDefault());
});
