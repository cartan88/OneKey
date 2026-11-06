'use strict';

/**
 * The only bridge between the sandboxed renderer and the main process.
 * Every channel is listed explicitly — the renderer cannot invoke anything else.
 */

const { contextBridge, ipcRenderer } = require('electron');

const invoke = (channel, payload) => ipcRenderer.invoke(channel, payload);

contextBridge.exposeInMainWorld('oneKey', {
  vault: {
    status: () => invoke('vault:status'),
    create: (masterPassword) => invoke('vault:create', masterPassword),
    unlock: (masterPassword) => invoke('vault:unlock', masterPassword),
    lock: () => invoke('vault:lock'),
    changeMaster: (currentPassword, newPassword) =>
      invoke('vault:changeMaster', { currentPassword, newPassword }),
  },

  entries: {
    list: () => invoke('entries:list'),
    add: (input) => invoke('entries:add', input),
    update: (id, patch) => invoke('entries:update', { id, patch }),
    remove: (id) => invoke('entries:delete', id),
    reveal: (id) => invoke('entries:reveal', id),
    bulkRemove: (ids) => invoke('entries:bulkDelete', ids),
    bulkMove: (ids, folder) => invoke('entries:bulkMove', { ids, folder }),
  },

  settings: {
    get: () => invoke('settings:get'),
    update: (patch) => invoke('settings:update', patch),
  },

  bridge: {
    status: () => invoke('bridge:status'),
  },

  transfer: {
    exportBackup: (password) => invoke('vault:exportBackup', { password }),
    inspectImport: () => invoke('vault:inspectImport'),
    applyImport: (password) => invoke('vault:applyImport', { password }),
    cancelImport: () => invoke('vault:cancelImport'),
  },

  clipboard: {
    copyField: (id, field, clearAfterSeconds) =>
      invoke('clipboard:copyField', { id, field, clearAfterSeconds }),
    copyText: (text, clearAfterSeconds) =>
      invoke('clipboard:copyText', { text, clearAfterSeconds }),
    clear: () => invoke('clipboard:clear'),
  },

  generatePassword: (opts) => invoke('password:generate', opts),
  openExternal: (url) => invoke('shell:openExternal', url),
  idleLock: () => invoke('app:idleLock'),
  appInfo: () => invoke('app:info'),

  /** Fires when About is chosen from the application menu. */
  onShowAbout: (callback) => {
    const listener = () => callback();
    ipcRenderer.on('app:showAbout', listener);
    return () => ipcRenderer.removeListener('app:showAbout', listener);
  },

  /** Fires when the browser fills a credential or saves one through the bridge. */
  onBrowserActivity: (callback) => {
    const listener = (_event, info) => callback(info);
    ipcRenderer.on('browser:activity', listener);
    return () => ipcRenderer.removeListener('browser:activity', listener);
  },

  /** Fires when the main process locks the vault (idle, minimize, manual). */
  onLocked: (callback) => {
    const listener = (_event, info) => callback(info);
    ipcRenderer.on('vault:locked', listener);
    return () => ipcRenderer.removeListener('vault:locked', listener);
  },
});
