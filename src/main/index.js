const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs');

// Resolve bundled bin directory and add to PATH before loading anything
let bundledBinDir = null;
function setupBundledBinPath() {
  const candidates = [
    path.join(process.resourcesPath, 'bin'),             // packaged app
    path.join(__dirname, '..', '..', 'bin', 'win'),      // dev mode
  ];
  for (const dir of candidates) {
    if (fs.existsSync(dir)) {
      bundledBinDir = dir;
      const sep = process.platform === 'win32' ? ';' : ':';
      process.env.PATH = dir + sep + (process.env.PATH || '');
      console.log('Bundled bin dir:', dir);
      console.log('Contents:', fs.readdirSync(dir));
      break;
    }
  }
}
setupBundledBinPath();

// Force prism-media to find our bundled FFmpeg before anything uses it
try {
  const prism = require('prism-media');
  const info = prism.FFmpeg.getInfo(true);
  console.log('FFmpeg found by prism-media:', info.command);
} catch (err) {
  console.error('prism-media FFmpeg detection failed:', err.message);
  // Monkey-patch prism-media to use our bundled ffmpeg directly
  if (bundledBinDir) {
    const prism = require('prism-media');
    const ffmpegExe = path.join(bundledBinDir, process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg');
    const cp = require('child_process');
    const result = cp.spawnSync(ffmpegExe, ['-h'], { windowsHide: true });
    if (!result.error) {
      const origGetInfo = prism.FFmpeg.getInfo.bind(prism.FFmpeg);
      prism.FFmpeg.getInfo = function(force) {
        try { return origGetInfo(force); } catch {
          return {
            command: ffmpegExe,
            output: Buffer.concat(result.output.filter(Boolean)).toString(),
            get version() { return this.output.match(/version (\S+)/)?.[1] ?? 'unknown'; },
          };
        }
      };
      console.log('Patched prism-media to use bundled FFmpeg:', ffmpegExe);
    } else {
      console.error('Bundled FFmpeg also failed:', result.error.message);
    }
  }
}

const bot = require('./bot');
const soundboard = require('./soundboard');
const youtube = require('./youtube');
const settings = require('./settings');

let mainWindow = null;

// Resolve a bundled binary to its full path
function resolveBin(name) {
  if (bundledBinDir) {
    const full = path.join(bundledBinDir, name);
    if (fs.existsSync(full)) return full;
  }
  return name; // fallback to PATH lookup
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

app.whenReady().then(async () => {
  await soundboard.init();
  createWindow();
});

app.on('window-all-closed', async () => {
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

// --- Sound IPC ---
ipcMain.handle('sound:getAll', () => soundboard.getAllSounds());

ipcMain.handle('sound:play', (_e, id) => {
  const sounds = soundboard.getAllSounds();
  const sound = sounds.find((s) => s.id === id);
  if (!sound) throw new Error('Sound not found');
  const filePath = soundboard.getFilePath(sound.filename);
  const vol = (settings.get('volume') || 100) / 100;
  bot.playSound(filePath, vol);
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
  return imported;
});

ipcMain.handle('sound:delete', (_e, id) => {
  soundboard.deleteSound(id);
});

ipcMain.handle('sound:rename', (_e, id, name) => {
  soundboard.renameSound(id, name);
});

// --- YouTube IPC ---
ipcMain.handle('youtube:extract', async (_e, opts) => {
  const { url, start, end, name } = opts;
  const filename = `${Date.now()}-yt-${name.replace(/[^a-zA-Z0-9_-]/g, '_')}.mp3`;
  const outputPath = path.join(soundboard.getSoundsDir(), filename);
  // Use full paths to bundled binaries; settings can override
  const ytdlpPath = settings.get('ytdlpPath') || resolveBin('yt-dlp.exe');
  const ffmpegDir = bundledBinDir || '';

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

  return { id, name, filename };
});

// --- Shell IPC ---
ipcMain.handle('shell:openExternal', (_e, url) => {
  const allowed = ['https://discord.com/developers/applications'];
  if (allowed.some((prefix) => url.startsWith(prefix))) {
    shell.openExternal(url);
  }
});

// --- Settings IPC ---
ipcMain.handle('settings:get', () => settings.load());

ipcMain.handle('settings:save', (_e, data) => {
  return settings.save(data);
});
