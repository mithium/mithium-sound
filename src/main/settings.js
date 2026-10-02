const { app } = require('electron');
const fs = require('fs');
const path = require('path');

const SETTINGS_PATH = path.join(app.getPath('userData'), 'settings.json');

const DEFAULTS = {
  botToken: '',
  lastGuildId: '',
  lastChannelId: '',
  autoConnect: false,
  ffmpegPath: '',
  ytdlpPath: '',
  volume: 100,
  outputMode: 'discord',
  selectedDeviceId: 'default',
  holdToPlayMode: false,
  remoteEnabled: false,
  remotePort: 3000,
  remoteAuthToken: '',
  homeServerEnabled: false,
  homeServerUrl: '',
  homeServerToken: '',
  loadedClipId: null,
  loadedClipAutoHold: true,
  recordDeviceId: '',
};

let cache = null;

function load() {
  if (cache) return cache;
  try {
    const raw = fs.readFileSync(SETTINGS_PATH, 'utf-8');
    cache = { ...DEFAULTS, ...JSON.parse(raw) };
  } catch {
    cache = { ...DEFAULTS };
  }
  return cache;
}

function save(settings) {
  // Merge so a renderer save does not drop keys it does not send,
  // including the phone loaded-clip id and the V/T auto-hold toggle.
  cache = { ...DEFAULTS, ...(cache || {}), ...settings };
  fs.writeFileSync(SETTINGS_PATH, JSON.stringify(cache, null, 2));
  return cache;
}

function get(key) {
  return load()[key];
}

function set(key, value) {
  const s = load();
  s[key] = value;
  return save(s);
}

module.exports = { load, save, get, set };
