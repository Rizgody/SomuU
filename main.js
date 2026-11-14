'use strict';
const { app, BrowserWindow, ipcMain, dialog, shell, session, nativeImage, Menu } = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { spawn } = require('child_process');

let win = null;

/* ------------------------------------------------------------------ */
/* Storage                                                             */
/* ------------------------------------------------------------------ */
const userDir = () => app.getPath('userData');
const cfgFile = () => path.join(userDir(), 'config.json');
const coversDir = () => {
  const d = path.join(userDir(), 'covers');
  fs.mkdirSync(d, { recursive: true });
  return d;
};

function readConfig() {
  try {
    return JSON.parse(fs.readFileSync(cfgFile(), 'utf8'));
  } catch (_) {
    return { settings: {}, items: [], history: [] };
  }
}

function writeConfig(cfg) {
  fs.mkdirSync(userDir(), { recursive: true });
  const tmp = cfgFile() + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2), 'utf8');
  fs.renameSync(tmp, cfgFile());
}

function copyIntoCovers(src, prefix) {
  const ext = path.extname(src).toLowerCase() || '.png';
  const dest = path.join(coversDir(), `${prefix}-${crypto.randomUUID()}${ext}`);
  fs.copyFileSync(src, dest);
  return dest;
}

/* ------------------------------------------------------------------ */
/* Game detection                                                      */
/* ------------------------------------------------------------------ */
const PC_EXT = new Set(['.exe', '.bat', '.lnk']);
const WIIU_EXT = new Set(['.wux', '.wud', '.rpx', '.wua']);
const JUNK_EXE = /(unins|uninstall|setup|install|redist|vcredist|dxsetup|dotnet|crashhandler|crashpad|crashreport|updater|update|helper|diagnostic|config(?:ure)?tool|7z|notification_helper|unitycrash|launcherhelper|cefprocess|webview2)/i;
const SKIP_DIRS = new Set(['node_modules', '$recycle.bin', 'system volume information', 'windows', '.git', '__pycache__', 'redist', '_commonredist', 'directx', 'vcredist']);

function cleanName(s) {
  return String(s || '')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/<!\[CDATA\[|\]\]>/g, '')
    .replace(/\s+/g, ' ').trim();
}

function baseName(file) {
  return path.basename(file, path.extname(file)).replace(/[_]+/g, ' ').trim();
}

/* Targa decoder (types 2 and 10, 24/32 bit) -> PNG file via nativeImage */
function decodeTGA(buf) {
  const idLen = buf[0];
  const cmType = buf[1];
  const type = buf[2];
  const cmLen = buf.readUInt16LE(5);
  const cmBits = buf[7];
  const w = buf.readUInt16LE(12);
  const h = buf.readUInt16LE(14);
  const bpp = buf[16];
  const desc = buf[17];
  if ((type !== 2 && type !== 10) || (bpp !== 24 && bpp !== 32) || !w || !h) {
    throw new Error('Unsupported TGA');
  }
  const bytes = bpp / 8;
  let off = 18 + idLen + (cmType ? cmLen * Math.ceil(cmBits / 8) : 0);
  const size = w * h * 4;
  const px = Buffer.alloc(size);
  let p = 0;
  const put = (so) => {
    px[p] = buf[so];
    px[p + 1] = buf[so + 1];
    px[p + 2] = buf[so + 2];
    px[p + 3] = bytes === 4 ? buf[so + 3] : 255;
    p += 4;
  };
  if (type === 2) {
    while (p < size && off + bytes <= buf.length) { put(off); off += bytes; }
  } else {
    while (p < size && off < buf.length) {
      const head = buf[off++];
      const count = (head & 127) + 1;
      if (head & 128) {
        const so = off; off += bytes;
        for (let k = 0; k < count && p < size; k++) put(so);
      } else {
        for (let k = 0; k < count && p < size; k++) { put(off); off += bytes; }
      }
    }
  }
  if (!(desc & 0x20)) {
    const row = w * 4;
    const tmp = Buffer.alloc(row);
    for (let y = 0; y < (h >> 1); y++) {
      const a = y * row, b = (h - 1 - y) * row;
      px.copy(tmp, 0, a, a + row);
      px.copy(px, a, b, b + row);
      tmp.copy(px, b, 0, row);
    }
  }
  return { w, h, px };
}

function iconFromTga(tgaPath, key) {
  try {
    const out = path.join(coversDir(), 'icon-' + crypto.createHash('md5').update(key).digest('hex') + '.png');
    if (fs.existsSync(out)) return out;
    const { w, h, px } = decodeTGA(fs.readFileSync(tgaPath));
    const img = nativeImage.createFromBitmap(px, { width: w, height: h });
    fs.writeFileSync(out, img.toPNG());
    return out;
  } catch (_) {
    return null;
  }
}

function wiiuDirRpx(dir) {
  try {
    const code = path.join(dir, 'code');
    const rpx = fs.readdirSync(code).find((f) => /\.rpx$/i.test(f));
    if (!rpx) return null;
    const meta = path.join(dir, 'meta');
    const ok = fs.existsSync(path.join(meta, 'meta.xml')) || fs.existsSync(path.join(meta, 'iconTex.tga'));
    return ok ? path.join(code, rpx) : null;
  } catch (_) {
    return null;
  }
}

function makeWiiUFolderItem(dir, rpx) {
  let name = path.basename(dir);
  try {
    const xml = fs.readFileSync(path.join(dir, 'meta', 'meta.xml'), 'utf8');
    const m = xml.match(/<longname_en[^>]*>([\s\S]*?)<\/longname_en>/i) || xml.match(/<shortname_en[^>]*>([\s\S]*?)<\/shortname_en>/i);
    if (m && cleanName(m[1])) name = cleanName(m[1]);
  } catch (_) { /* no xml */ }
  const tga = path.join(dir, 'meta', 'iconTex.tga');
  const cover = fs.existsSync(tga) ? iconFromTga(tga, dir) : null;
  return { id: crypto.randomUUID(), type: 'wiiu', kind: 'folder', name, path: rpx, dir, cover, border: 'default' };
}

function scanDir(root) {
  const out = [];
  const walk = (dir, depth) => {
    if (depth > 8 || out.length >= 800) return;
    const rpx = wiiuDirRpx(dir);
    if (rpx) { out.push(makeWiiUFolderItem(dir, rpx)); return; }
    let ents;
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
    const inCode = path.basename(dir).toLowerCase() === 'code';
    for (const e of ents) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name.toLowerCase())) walk(full, depth + 1);
      } else if (e.isFile()) {
        const ext = path.extname(e.name).toLowerCase();
        if (PC_EXT.has(ext)) {
          if (!JUNK_EXE.test(e.name)) {
            out.push({ id: crypto.randomUUID(), type: 'pc', name: baseName(full), path: full, cover: null, border: 'default' });
          }
        } else if (WIIU_EXT.has(ext)) {
          if (ext === '.rpx' && inCode) continue;
          out.push({ id: crypto.randomUUID(), type: 'wiiu', kind: 'file', name: baseName(full), path: full, cover: null, border: 'default' });
        }
      }
    }
  };
  walk(root, 0);
  return out;
}

/* ------------------------------------------------------------------ */
/* Launching                                                           */
/* ------------------------------------------------------------------ */
function launch(item, cemu) {
  return new Promise((resolve) => {
    try {
      if (!item || !item.path || !fs.existsSync(item.path)) {
        return resolve({ ok: false, error: 'File not found: ' + (item && item.path) });
      }
      const ext = path.extname(item.path).toLowerCase();
      let cmd, args, cwd, opts = {};
      if (item.type === 'wiiu') {
        if (!cemu || !fs.existsSync(cemu)) {
          return resolve({ ok: false, needCemu: true, error: 'Set the Cemu.exe path in System Settings first.' });
        }
        cmd = cemu;
        args = ['-g', item.path, '-f'];
        cwd = path.dirname(cemu);
      } else if (ext === '.lnk') {
        shell.openPath(item.path).then((err) => resolve(err ? { ok: false, error: err } : { ok: true }));
        return;
      } else if (ext === '.bat') {
        cmd = process.env.ComSpec || 'cmd.exe';
        args = ['/c', '"' + item.path + '"'];
        cwd = path.dirname(item.path);
        opts = { windowsVerbatimArguments: true };
      } else {
        cmd = item.path;
        args = [];
        cwd = path.dirname(item.path);
      }
      const child = spawn(cmd, args, Object.assign({ cwd, detached: true, stdio: 'ignore' }, opts));
      child.once('error', (e) => resolve({ ok: false, error: e.message }));
      child.once('spawn', () => { child.unref(); resolve({ ok: true }); });
    } catch (e) {
      resolve({ ok: false, error: String((e && e.message) || e) });
    }
  });
}

/* ------------------------------------------------------------------ */
/* IPC                                                                 */
/* ------------------------------------------------------------------ */
function registerIpc() {
  ipcMain.handle('cfg:load', () => readConfig());
  ipcMain.handle('cfg:save', (_e, cfg) => { writeConfig(cfg); return true; });

  ipcMain.handle('add:pc', async () => {
    const r = await dialog.showOpenDialog(win, {
      title: 'Add PC games',
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: 'Games and shortcuts', extensions: ['exe', 'bat', 'lnk'] }]
    });
    if (r.canceled) return { items: [] };
    return {
      items: r.filePaths.map((p) => ({ id: crypto.randomUUID(), type: 'pc', name: baseName(p), path: p, cover: null, border: 'default' }))
    };
  });

  ipcMain.handle('add:rom', async () => {
    const r = await dialog.showOpenDialog(win, {
      title: 'Add Wii U ROMs',
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: 'Wii U games', extensions: ['wux', 'wud', 'rpx', 'wua'] }]
    });
    if (r.canceled) return { items: [] };
    return {
      items: r.filePaths.map((p) => ({ id: crypto.randomUUID(), type: 'wiiu', kind: 'file', name: baseName(p), path: p, cover: null, border: 'default' }))
    };
  });

  ipcMain.handle('add:scan', async () => {
    const r = await dialog.showOpenDialog(win, { title: 'Scan a folder for games', properties: ['openDirectory'] });
    if (r.canceled || !r.filePaths[0]) return { items: [], dir: null };
    return { items: scanDir(r.filePaths[0]), dir: r.filePaths[0] };
  });

  ipcMain.handle('pick:cover', async () => {
    const r = await dialog.showOpenDialog(win, {
      title: 'Choose cover art',
      properties: ['openFile'],
      filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp'] }]
    });
    if (r.canceled || !r.filePaths[0]) return null;
    return copyIntoCovers(r.filePaths[0], 'cover');
  });

  ipcMain.handle('pick:wallpaper', async () => {
    const r = await dialog.showOpenDialog(win, {
      title: 'Choose a wallpaper',
      properties: ['openFile'],
      filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp'] }]
    });
    if (r.canceled || !r.filePaths[0]) return null;
    return copyIntoCovers(r.filePaths[0], 'wallpaper');
  });

  ipcMain.handle('pick:exe', async () => {
    const r = await dialog.showOpenDialog(win, {
      title: 'Locate Cemu.exe',
      properties: ['openFile'],
      filters: [{ name: 'Executable', extensions: ['exe'] }]
    });
    return r.canceled ? null : r.filePaths[0] || null;
  });

  ipcMain.handle('launch', (_e, item, cemu) => launch(item, cemu));

  ipcMain.handle('open:external', (_e, url) => {
    if (typeof url === 'string' && /^https?:\/\//i.test(url)) {
      shell.openExternal(url);
      return true;
    }
    return false;
  });

  ipcMain.handle('win:fullscreen', (_e, on) => {
    if (win) win.setFullScreen(!!on);
    return !!on;
  });
  ipcMain.handle('win:isFullscreen', () => (win ? win.isFullScreen() : false));
  ipcMain.handle('app:quit', () => { app.quit(); });
}

/* ------------------------------------------------------------------ */
/* Window                                                              */
/* ------------------------------------------------------------------ */
function setupWebSession() {
  const ses = session.fromPartition('persist:wiiu');
  const ua = ses.getUserAgent().replace(/\s?Electron\/\S+/i, '').replace(/\s?wiiu-menu\/\S+/i, '').replace(/\s?Wii U Menu\/\S+/i, '');
  ses.setUserAgent(ua);
  const allowed = new Set(['fullscreen', 'clipboard-sanitized-write']);
  ses.setPermissionRequestHandler((_wc, permission, cb) => cb(allowed.has(permission)));
}

function createWindow() {
  win = new BrowserWindow({
    width: 1280,
    height: 720,
    minWidth: 960,
    minHeight: 560,
    backgroundColor: '#f2f5f9',
    title: 'Wii U Menu',
    icon: path.join(__dirname, 'assets', 'icon.png'),
    autoHideMenuBar: true,
    show: false,
    fullscreenable: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webviewTag: true,
      spellcheck: false
    }
  });
  win.once('ready-to-show', () => win.show());
  win.loadFile(path.join(__dirname, 'index.html'));
  win.on('enter-full-screen', () => win.webContents.send('fullscreen:changed', true));
  win.on('leave-full-screen', () => win.webContents.send('fullscreen:changed', false));
  win.on('closed', () => { win = null; });
}

app.on('web-contents-created', (_e, contents) => {
  contents.on('will-attach-webview', (ev, webPreferences, params) => {
    delete webPreferences.preload;
    delete webPreferences.preloadURL;
    webPreferences.nodeIntegration = false;
    webPreferences.contextIsolation = true;
    webPreferences.sandbox = true;
    params.partition = 'persist:wiiu';
    if (!/^(https?:|about:blank$)/i.test(params.src || '')) ev.preventDefault();
  });
  if (contents.getType() === 'webview') {
    contents.setWindowOpenHandler(({ url }) => {
      if (/^https?:/i.test(url)) contents.loadURL(url);
      return { action: 'deny' };
    });
  } else {
    contents.setWindowOpenHandler(() => ({ action: 'deny' }));
    contents.on('will-navigate', (ev) => ev.preventDefault());
  }
});

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });
  app.whenReady().then(() => {
    Menu.setApplicationMenu(null);
    setupWebSession();
    registerIpc();
    createWindow();
    app.on('activate', () => { if (!BrowserWindow.getAllWindows().length) createWindow(); });
  });
  app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
}
