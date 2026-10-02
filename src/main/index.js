const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
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

let mainWindow = null;

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

  mainWindow.webContents.once('did-finish-load', () => {
    homeserver.start();
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

function registerGlobalShortcuts() {
  if (keyboardListener) return;
  
  try {
    keyboardListener = new GlobalKeyboardListener();
    
    keyboardListener.addListener((e, down) => {
      if (!mainWindow || mainWindow.isDestroyed() || mainWindow.isFocused()) {
        // Don't send global events if window is focused (let renderer handle it)
        return;
      }
      
      const keyName = e.name;
      const eventType = down['LEFT ALT'] || down['RIGHT ALT'] || 
                        down['LEFT CTRL'] || down['RIGHT CTRL'] ||
                        down['LEFT SHIFT'] || down['RIGHT SHIFT'] ? null : 
                        (e.state === 'DOWN' ? 'keydown' : 'keyup');
      
      if (!eventType) return;
      
      // Handle V, T, and Delete keys
      if (keyName === 'V' || keyName === 'T' || keyName === 'DELETE') {
        const key = keyName === 'DELETE' ? 'Delete' : keyName.toLowerCase();
        mainWindow.webContents.send(`global-hotkey:${eventType}`, key);
      }
    });
    
    console.log('Global keyboard listener started for V, T, Delete');
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
}

app.whenReady().then(async () => {
  await soundboard.init();
  homeserver.onStatus((state) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('homeserver:status', state);
    }
  });
  createWindow();
  
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

app.on('window-all-closed', async () => {
  unregisterGlobalShortcuts();
  await bot.logout();
  app.quit();
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

ipcMain.handle('remote:generateQR', async (_e, url) => {
  try {
    const qrCode = await remote.generateQRCode(url);
    return { qrCode };
  } catch (err) {
    console.error('Failed to generate QR code:', err);
    throw err;
  }
});
