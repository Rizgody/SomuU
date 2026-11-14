'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('wiiu', {
  loadConfig: () => ipcRenderer.invoke('cfg:load'),
  saveConfig: (cfg) => ipcRenderer.invoke('cfg:save', cfg),
  addPC: () => ipcRenderer.invoke('add:pc'),
  addROM: () => ipcRenderer.invoke('add:rom'),
  scanFolder: () => ipcRenderer.invoke('add:scan'),
  pickCover: () => ipcRenderer.invoke('pick:cover'),
  pickWallpaper: () => ipcRenderer.invoke('pick:wallpaper'),
  pickExe: () => ipcRenderer.invoke('pick:exe'),
  launch: (item, cemuPath) => ipcRenderer.invoke('launch', item, cemuPath),
  openExternal: (url) => ipcRenderer.invoke('open:external', url),
  setFullscreen: (on) => ipcRenderer.invoke('win:fullscreen', !!on),
  isFullscreen: () => ipcRenderer.invoke('win:isFullscreen'),
  onFullscreen: (cb) => {
    const handler = (_e, v) => cb(!!v);
    ipcRenderer.on('fullscreen:changed', handler);
    return () => ipcRenderer.removeListener('fullscreen:changed', handler);
  },
  quit: () => ipcRenderer.invoke('app:quit')
});
