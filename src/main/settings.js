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
  cache = { ...DEFAULTS, ...settings };
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
