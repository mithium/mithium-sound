const { app, BrowserWindow, ipcMain, dialog, shell, Tray, Menu, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');
const { autoUpdater } = require('electron-updater');
const { GlobalKeyboardListener } = require('node-global-key-listener');

// Setup FFmpeg for prism-media / @discordjs/voice
// ffmpeg-static checks process.env.FFMPEG_BIN, so set it before requiring anything
function setupFFmpeg() {
  let ffmpegPath;
  
  if (app.isPackaged) {
    // Production: use bundled ffmpeg.exe from extraResources (resources/bin/)
    ffmpegPath = path.join(process.resourcesPath, 'bin', 'ffmpeg.exe');
    console.log('Using bundled ffmpeg.exe:', ffmpegPath);
  } else {
    // Development: try ffmpeg-static first, then fallback to extracted binary
    try {
      ffmpegPath = require('ffmpeg-static');
      console.log('Using ffmpeg-static in dev mode:', ffmpegPath);
    } catch (err) {
      // Fallback to extracted binary in dev
      const devPath = path.join(__dirname, '..', '..', 'bin', 'win', 'ffmpeg.exe');
      if (fs.existsSync(devPath)) {
        ffmpegPath = devPath;
        console.log('Using extracted ffmpeg at:', ffmpegPath);
      } else {
        console.error('ffmpeg-static not found and no extracted binary:', err.message);
        return;
      }
    }
  }
  
  // Verify ffmpeg exists
  if (!fs.existsSync(ffmpegPath)) {
    console.error('FFmpeg binary not found at:', ffmpegPath);
    return;
  }
  
  // Set FFMPEG_BIN env var so ffmpeg-static module exports our bundled path
  // When prism-media calls require('ffmpeg-static'), it will get this path
  process.env.FFMPEG_BIN = ffmpegPath;
  console.log('Set FFMPEG_BIN:', process.env.FFMPEG_BIN);
  
  // Verify prism-media can find it via ffmpeg-static
  try {
    // Clear require cache for ffmpeg-static to pick up the env var
    delete require.cache[require.resolve('ffmpeg-static')];
    const prism = require('prism-media');
    const info = prism.FFmpeg.getInfo(true);
    console.log('prism-media FFmpeg verified:', info.command);
  } catch (err) {
    console.error('prism-media FFmpeg.getInfo() failed:', err.message);
  }
}
setupFFmpeg();

const bot = require('./bot');
const soundboard = require('./soundboard');
const youtube = require('./youtube');
const settings = require('./settings');
const remote = require('./remote');
const homeserver = require('./homeserver');
const loadedClip = require('./loadedClip');
const { createWinKeyHold } = require('./winKeyHold');
const { classifyGlobalEvent } = require('./loadedClipControl');

let mainWindow = null;
let tray = null;
let keyHold = null;
app.isQuitting = false;

// --- Auto-updater configuration ---
autoUpdater.autoDownload = false;
autoUpdater.autoInstallOnAppQuit = true;

autoUpdater.on('error', (err) => {
  console.error('Auto-updater error:', err);
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('update:error', err.message);
  }
});

autoUpdater.on('checking-for-update', () => {
  console.log('Checking for updates...');
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('update:checking');
  }
});

autoUpdater.on('update-available', (info) => {
  console.log('Update available:', info.version);
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('update:available', info);
  }
});

autoUpdater.on('update-not-available', (info) => {
  console.log('No updates available');
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('update:not-available', info);
  }
});

autoUpdater.on('download-progress', (progress) => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('update:progress', progress);
  }
});

autoUpdater.on('update-downloaded', (info) => {
  console.log('Update downloaded:', info.version);
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('update:downloaded', info);
  }
});

// Resolve a bundled binary to its full path (for yt-dlp, etc.)
function resolveBin(name) {
  // For yt-dlp, check if it's in PATH or settings
  return name;
}

function resolveYtdlpPath() {
  return settings.get('ytdlpPath') || 'yt-dlp';
}

function getIconPath() {
  const candidates = [
    path.join(process.resourcesPath, 'icon.png'),        // packaged
    path.join(__dirname, '..', '..', 'build', 'icon.png'), // dev mode
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  return undefined;
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 900,
    height: 700,
    minWidth: 600,
    minHeight: 500,
    title: 'Mithium Sound',
    icon: getIconPath(),
    backgroundColor: '#1e1e2e',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  mainWindow.webContents.openDevTools();

  mainWindow.on('close', (event) => {
    if (app.isQuitting) return;
    // Keep the process alive so global V/T, Delete, and mouse hooks still run.
    event.preventDefault();
    mainWindow.hide();
  });

  mainWindow.webContents.once('did-finish-load', () => {
    homeserver.start();
    const service = loadedClip.getService();
    if (service) service.emit();
  });

  bot.onStatus((status) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('status', status);
    }
  });
}

// Forward main process console to renderer DevTools
const origLog = console.log;
const origError = console.error;
console.log = (...args) => {
  origLog(...args);
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.executeJavaScript(
      `console.log('[main]', ${JSON.stringify(args.map(String).join(' '))})`
    ).catch(() => {});
  }
};
console.error = (...args) => {
  origError(...args);
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.executeJavaScript(
      `console.error('[main]', ${JSON.stringify(args.map(String).join(' '))})`
    ).catch(() => {});
  }
};

// --- Global Shortcut Management ---
let keyboardListener = null;

function sendToRenderer(channel, payload) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (payload === undefined) mainWindow.webContents.send(channel);
  else mainWindow.webContents.send(channel, payload);
}

function publishLoadedPlay(id) {
  sendToRenderer('loaded-clip:play', { id });
  remote.broadcastUpdate('playing', { id });
}

async function performHardStop({ notifyRenderer }) {
  const service = loadedClip.getService();
  if (service) await service.hardStop({ notifyRenderer });
}

async function performClipEnded() {
  const service = loadedClip.getService();
  if (service) await service.clipEnded();
  remote.broadcastUpdate('stopped', {});
}

async function performPlayFailed() {
  const service = loadedClip.getService();
  if (service) await service.playFailed();
}

function dispatchLoadedKeyDown(key, { fromRenderer } = {}) {
  const service = loadedClip.getService();
  if (!service) return { type: 'ignore' };
  const decision = service.keyDown(key);
  if (decision.type === 'play') {
    publishLoadedPlay(decision.id);
  } else if (
    decision.type === 'legacy' &&
    !fromRenderer &&
    mainWindow &&
    !mainWindow.isDestroyed() &&
    !mainWindow.isFocused()
  ) {
    sendToRenderer('global-hotkey:keydown', key);
  }
  return decision;
}

function dispatchLoadedKeyUp(key, { fromRenderer } = {}) {
  const service = loadedClip.getService();
  if (!service) return { type: 'ignore' };
  const decision = service.keyUp(key);
  if (
    decision.type === 'legacy' &&
    !fromRenderer &&
    mainWindow &&
    !mainWindow.isDestroyed() &&
    !mainWindow.isFocused()
  ) {
    sendToRenderer('global-hotkey:keyup', key);
  }
  return decision;
}

function initLoadedClip() {
  keyHold = createWinKeyHold();
  loadedClip.init({
    injector: keyHold,
    getSounds: () => soundboard.getAllSounds(),
    readSettings: () => settings.load(),
    writeSettings: (partial) => {
      settings.save({ ...settings.load(), ...partial });
    },
    hooks: {
      onState: (state) => {
        sendToRenderer('loaded-clip:state', state);
        remote.broadcastUpdate('loaded-clip', state);
      },
      onHardStop: ({ notifyRenderer }) => {
        try {
          bot.stopSound();
        } catch (err) {
          console.error('Failed to stop playback:', err);
        }
        remote.broadcastUpdate('stopped', {});
        if (notifyRenderer) sendToRenderer('loaded-clip:force-stop');
      },
    },
  });
}

function trayImage() {
  const iconPath = getIconPath();
  if (iconPath) {
    const fromFile = nativeImage.createFromPath(iconPath);
    if (!fromFile.isEmpty()) return fromFile.resize({ width: 16, height: 16 });
  }
  try {
    const b64Path = path.join(__dirname, '..', '..', 'build', 'icon-source.b64');
    const b64 = fs.readFileSync(b64Path, 'utf8').trim();
    const fromB64 = nativeImage.createFromDataURL(`data:image/png;base64,${b64}`);
    if (!fromB64.isEmpty()) return fromB64.resize({ width: 16, height: 16 });
  } catch {
    // Fall through to a 1px icon so the tray still exists.
  }
  return nativeImage.createFromDataURL(
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  );
}

function showMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

function createTray() {
  if (tray) return;
  tray = new Tray(trayImage());
  tray.setToolTip('Mithium Sound is still running so V and T work. Quit from this menu to exit.');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Show Mithium Sound', click: showMainWindow },
    { type: 'separator' },
    {
      label: 'Quit',
      click: () => {
        app.isQuitting = true;
        app.quit();
      },
    },
  ]));
  tray.on('click', showMainWindow);
}

function registerGlobalShortcuts() {
  if (keyboardListener) return;
  
  try {
    keyboardListener = new GlobalKeyboardListener();
    
    // Same low-level hook used since global V/T/Delete (v1.8.10+).
    // It receives keys and mouse buttons while the window is hidden, minimized,
    // or unfocused (including a fullscreen game). The hook dies if the process
    // is quit; closing the window hides to the tray instead.
    //
    // Mouse double-click: two DOWN events for the same button, MOUSE LEFT
    // (VK 0x01) or MOUSE RIGHT (VK 0x02), within 500ms. See loadedClipControl.
    keyboardListener.addListener((e, down) => {
      if (!mainWindow || mainWindow.isDestroyed()) return;

      const classified = classifyGlobalEvent(e);
      if (!classified) return;

      if (classified.kind === 'mouse') {
        if (!classified.down) return;
        const service = loadedClip.getService();
        if (!service) return;
        const click = service.mouseDown(classified.button, Date.now());
        if (click.doubleClick) performHardStop({ notifyRenderer: true });
        return;
      }

      const modified = down['LEFT ALT'] || down['RIGHT ALT'] ||
        down['LEFT CTRL'] || down['RIGHT CTRL'] ||
        down['LEFT SHIFT'] || down['RIGHT SHIFT'];
      if (modified) return;

      // Focused window: renderer handles V/T/Delete so text fields still work.
      // Unfocused / tray: this hook is the only path.
      if (mainWindow.isFocused()) return;

      if (classified.down) {
        if (classified.key === 'Delete') {
          performHardStop({ notifyRenderer: true });
          return;
        }
        dispatchLoadedKeyDown(classified.key, { fromRenderer: false });
      } else if (classified.key !== 'Delete') {
        dispatchLoadedKeyUp(classified.key, { fromRenderer: false });
      }
    });
    
    console.log('Global keyboard listener started for V, T, Delete, and mouse double-click');
  } catch (err) {
    console.error('Failed to start global keyboard listener:', err);
  }
}

function unregisterGlobalShortcuts() {
  if (!keyboardListener) return;
  
  try {
    keyboardListener.kill();
    keyboardListener = null;
    console.log('Global keyboard listener stopped');
  } catch (err) {
    console.error('Failed to stop global keyboard listener:', err);
  }
}

function libraryMutated() {
  remote.notifyLibraryUpdate();
  homeserver.onLocalChange();
  const service = loadedClip.getService();
  if (service) service.onLibraryChanged();
}

app.whenReady().then(async () => {
  await soundboard.init();
  initLoadedClip();
  homeserver.onStatus((state) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('homeserver:status', state);
    }
  });
  createWindow();
  createTray();
  
  // Register global shortcuts after window is created
  registerGlobalShortcuts();
  
  // Check for updates 5 seconds after launch (gives window time to open)
  if (!app.isPackaged) {
    console.log('Dev mode: skipping auto-update check');
  } else {
    setTimeout(() => {
      autoUpdater.checkForUpdates().catch(err => {
        console.error('Auto-update check failed:', err);
      });
    }, 5000);
  }
});

let quitReleaseStarted = false;
app.on('before-quit', (event) => {
  app.isQuitting = true;
  if (quitReleaseStarted) return;
  const service = loadedClip.getService();
  if (!service || !service.publicState().simulating) return;
  event.preventDefault();
  quitReleaseStarted = true;
  const release = service.shutdown().catch((err) => {
    console.error('Failed to release simulated key on quit:', err);
  });
  const timeout = new Promise((resolve) => setTimeout(resolve, 800));
  Promise.race([release, timeout]).finally(() => {
    if (keyHold) keyHold.dispose();
    app.quit();
  });
});

app.on('window-all-closed', async () => {
  if (!app.isQuitting) return;
  unregisterGlobalShortcuts();
  await bot.logout();
});

// --- Bot IPC ---
ipcMain.handle('bot:login', async (_e, token) => {
  const result = await bot.login(token);
  settings.set('botToken', token);
  return result;
});

ipcMain.handle('bot:logout', async () => {
  await bot.logout();
});

ipcMain.handle('bot:getGuilds', () => bot.getGuilds());

ipcMain.handle('bot:getVoiceChannels', (_e, guildId) => bot.getVoiceChannels(guildId));

ipcMain.handle('bot:joinChannel', async (_e, channelId) => {
  const result = await bot.joinChannel(channelId);
  settings.set('lastChannelId', channelId);
  return result;
});

ipcMain.handle('bot:leaveChannel', () => {
  bot.leaveChannel();
});

ipcMain.handle('bot:isInChannel', () => {
  return bot.isInChannel();
});

// --- Sound IPC ---
ipcMain.handle('sound:getAll', () => soundboard.getAllSounds());

ipcMain.handle('sound:play', (_e, id) => {
  const sounds = soundboard.getAllSounds();
  const sound = sounds.find((s) => s.id === id);
  if (!sound) throw new Error('Sound not found');
  const filePath = soundboard.getFilePath(sound.filename);
  const vol = (settings.get('volume') || 100) / 100;
  const outputMode = settings.get('outputMode') || 'discord';
  
  if (outputMode === 'discord' || outputMode === 'both') {
    bot.playSound(filePath, vol);
  }
  
  return { filePath, volume: vol, mode: outputMode };
});

ipcMain.handle('sound:stop', () => {
  bot.stopSound();
});

ipcMain.handle('sound:getFilePath', (_e, id) => {
  const sounds = soundboard.getAllSounds();
  const sound = sounds.find((s) => s.id === id);
  if (!sound) throw new Error('Sound not found');
  return soundboard.getFilePath(sound.filename);
});

ipcMain.handle('sound:import', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Import Sound Files',
    filters: [{ name: 'Audio', extensions: ['mp3', 'wav', 'ogg', 'flac', 'webm'] }],
    properties: ['openFile', 'multiSelections'],
  });
  if (result.canceled || !result.filePaths.length) return [];

  const imported = [];
  for (const srcPath of result.filePaths) {
    const ext = path.extname(srcPath);
    const baseName = path.basename(srcPath, ext);
    const filename = `${Date.now()}-${baseName}${ext}`;
    const destPath = path.join(soundboard.getSoundsDir(), filename);
    fs.copyFileSync(srcPath, destPath);
    const { id } = soundboard.addSound({ name: baseName, filename, sourceType: 'local' });
    imported.push({ id, name: baseName, filename });
  }
  
  libraryMutated();
  return imported;
});

ipcMain.handle('sound:delete', (_e, id) => {
  soundboard.deleteSound(id);
  libraryMutated();
});

ipcMain.handle('sound:rename', (_e, id, name) => {
  soundboard.renameSound(id, name);
  libraryMutated();
});

ipcMain.handle('sound:assignToGroup', (_e, soundId, groupId) => {
  soundboard.assignSoundToGroup(soundId, groupId);
  libraryMutated();
});

// --- Group IPC ---
ipcMain.handle('group:getAll', () => soundboard.getAllGroups());

ipcMain.handle('group:create', (_e, name) => {
  const result = soundboard.createGroup(name);
  libraryMutated();
  return result;
});

ipcMain.handle('group:rename', (_e, id, name) => {
  soundboard.renameGroup(id, name);
  libraryMutated();
});

ipcMain.handle('group:delete', (_e, id) => {
  soundboard.deleteGroup(id);
  libraryMutated();
});

ipcMain.handle('group:toggleCollapsed', (_e, id) => {
  return soundboard.toggleGroupCollapsed(id);
});

// --- YouTube IPC ---
ipcMain.handle('youtube:extract', async (_e, opts) => {
  const { url, start, end, name } = opts;
  const filename = `${Date.now()}-yt-${name.replace(/[^a-zA-Z0-9_-]/g, '_')}.mp3`;
  const outputPath = path.join(soundboard.getSoundsDir(), filename);
  
  // Get FFmpeg path from env var (set by setupFFmpeg at startup)
  const ffmpegPath = process.env.FFMPEG_BIN;
  if (!ffmpegPath) {
    throw new Error('FFmpeg not configured - app may not be properly initialized');
  }
  
  const ytdlpPath = resolveYtdlpPath();
  const ffmpegDir = path.dirname(ffmpegPath);

  await youtube.extractClip({
    url,
    start,
    end,
    outputPath,
    ytdlpPath,
    ffmpegDir,
    onProgress: (pct) => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('youtube:progress', pct);
      }
    },
  });

  const { id } = soundboard.addSound({
    name,
    filename,
    sourceType: 'youtube',
    youtubeUrl: url,
    youtubeStart: start,
    youtubeEnd: end,
  });

  libraryMutated();
  return { id, name, filename };
});

ipcMain.handle('youtube:probeDuration', async (_e, url) => {
  const duration = await youtube.probeDuration({
    url,
    ytdlpPath: resolveYtdlpPath(),
  });
  return { duration };
});

// --- Shell IPC ---
ipcMain.handle('shell:openExternal', (_e, url) => {
  const allowed = [
    'https://discord.com/developers/applications',
    'https://vb-audio.com/Voicemeeter/'
  ];
  if (allowed.some((prefix) => url.startsWith(prefix))) {
    shell.openExternal(url);
  }
});

// --- Settings IPC ---
ipcMain.handle('settings:get', () => settings.load());

ipcMain.handle('settings:save', (_e, data) => {
  return settings.save(data);
});

// --- Update IPC ---
ipcMain.handle('update:check', async () => {
  try {
    const result = await autoUpdater.checkForUpdates();
    return result;
  } catch (err) {
    console.error('Check for updates failed:', err);
    throw err;
  }
});

ipcMain.handle('update:download', async () => {
  try {
    await autoUpdater.downloadUpdate();
    return { success: true };
  } catch (err) {
    console.error('Download update failed:', err);
    throw err;
  }
});

ipcMain.handle('update:install', () => {
  autoUpdater.quitAndInstall(false, true);
});

// --- Sound Library Backup IPC ---
ipcMain.handle('library:getInfo', () => {
  return soundboard.getLibraryInfo();
});

ipcMain.handle('library:backup', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Select Backup Location',
    properties: ['openDirectory', 'createDirectory'],
  });
  
  if (result.canceled || !result.filePaths.length) {
    return { canceled: true };
  }
  
  const backupDir = result.filePaths[0];
  const backupResult = await soundboard.backupLibrary(backupDir);
  return { success: true, ...backupResult };
});

ipcMain.handle('library:restore', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Select Backup Folder to Restore',
    properties: ['openDirectory'],
  });
  
  if (result.canceled || !result.filePaths.length) {
    return { canceled: true };
  }
  
  const backupPath = result.filePaths[0];
  const restoreResult = await soundboard.restoreLibrary(backupPath);
  homeserver.onLocalChange();
  return { success: true, ...restoreResult };
});

// --- Remote Server IPC ---
ipcMain.handle('remote:start', async (_e, opts) => {
  try {
    remote.startServer(opts);
    return { success: true, ...remote.getStatus() };
  } catch (err) {
    console.error('Failed to start remote server:', err);
    throw err;
  }
});

ipcMain.handle('remote:stop', () => {
  try {
    remote.stopServer();
    return { success: true };
  } catch (err) {
    console.error('Failed to stop remote server:', err);
    throw err;
  }
});

ipcMain.handle('remote:status', () => {
  return remote.getStatus();
});

ipcMain.handle('homeserver:getState', () => homeserver.getState());

ipcMain.handle('homeserver:sync', () => homeserver.syncNow());

ipcMain.handle('loaded-clip:get-state', () => loadedClip.getPublicState());

ipcMain.handle('loaded-clip:key-down', (_e, key) => {
  return dispatchLoadedKeyDown(key, { fromRenderer: true });
});

ipcMain.handle('loaded-clip:key-up', (_e, key) => {
  return dispatchLoadedKeyUp(key, { fromRenderer: true });
});

ipcMain.handle('loaded-clip:hard-stop', async () => {
  await performHardStop({ notifyRenderer: false });
  return { ok: true };
});

ipcMain.on('loaded-clip:ended', () => {
  performClipEnded();
});

ipcMain.on('loaded-clip:play-failed', () => {
  performPlayFailed();
});

ipcMain.handle('remote:generateQR', async (_e, url) => {
  try {
    const qrCode = await remote.generateQRCode(url);
    return { qrCode };
  } catch (err) {
    console.error('Failed to generate QR code:', err);
    throw err;
  }
});
