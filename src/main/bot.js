const { Client, GatewayIntentBits } = require('discord.js');
const {
  joinVoiceChannel,
  createAudioPlayer,
  createAudioResource,
  AudioPlayerStatus,
  VoiceConnectionStatus,
  entersState,
  generateDependencyReport,
} = require('@discordjs/voice');
const path = require('path');

// Verify encryption lib is loaded (stablelib is synchronous, no init needed)
try {
  require('@stablelib/xchacha20poly1305');
  console.log('Encryption: @stablelib/xchacha20poly1305 loaded');
  console.log(generateDependencyReport());
} catch (err) {
  console.error('Encryption library not found:', err.message);
}

let client = null;
let connection = null;
let player = null;
let currentGuildId = null;
let statusCallback = null;

function onStatus(cb) {
  statusCallback = cb;
}

function sendStatus(status) {
  if (statusCallback) statusCallback(status);
}

async function login(token) {
  if (client) await logout();
  client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates],
  });
  await client.login(token);
  await new Promise((resolve) => {
    if (client.isReady()) return resolve();
    client.once('ready', resolve);
  });
  sendStatus({ event: 'login', user: client.user.tag });
  return { user: client.user.tag };
}

async function logout() {
  leaveChannel();
  if (client) {
    client.destroy();
    client = null;
  }
  sendStatus({ event: 'logout' });
}

function getGuilds() {
  if (!client) return [];
  return client.guilds.cache.map((g) => ({ id: g.id, name: g.name }));
}

function getVoiceChannels(guildId) {
  if (!client) return [];
  const guild = client.guilds.cache.get(guildId);
  if (!guild) return [];
  return guild.channels.cache
    .filter((c) => c.type === 2) // GuildVoice
    .map((c) => ({ id: c.id, name: c.name }));
}

async function joinChannel(channelId) {
  if (!client) throw new Error('Bot not logged in');
  const channel = client.channels.cache.get(channelId);
  if (!channel) throw new Error('Channel not found');

  connection = joinVoiceChannel({
    channelId: channel.id,
    guildId: channel.guild.id,
    adapterCreator: channel.guild.voiceAdapterCreator,
    debug: true,
  });

  // Log ALL voice connection state changes
  connection.on('stateChange', (oldState, newState) => {
    console.log(`Voice: ${oldState.status} -> ${newState.status}`);
  });

  connection.on('debug', (msg) => {
    console.log('Voice debug:', msg);
  });

  connection.on('error', (err) => {
    console.error('Voice connection error:', err);
  });

  player = createAudioPlayer();
  connection.subscribe(player);
  currentGuildId = channel.guild.id;

  player.on(AudioPlayerStatus.Idle, () => {
    sendStatus({ event: 'playback', state: 'idle' });
  });

  player.on('error', (err) => {
    console.error('AudioPlayer error:', err);
    sendStatus({ event: 'error', message: err.message });
  });

  player.on('stateChange', (oldState, newState) => {
    console.log(`Player: ${oldState.status} -> ${newState.status}`);
  });

  // Handle disconnects (e.g. moved by admin, network issues)
  connection.on(VoiceConnectionStatus.Disconnected, async () => {
    console.log('Voice disconnected, attempting recovery...');
    try {
      await Promise.race([
        entersState(connection, VoiceConnectionStatus.Signalling, 5_000),
        entersState(connection, VoiceConnectionStatus.Connecting, 5_000),
      ]);
    } catch {
      connection.destroy();
      connection = null;
      player = null;
      sendStatus({ event: 'left' });
    }
  });

  try {
    await entersState(connection, VoiceConnectionStatus.Ready, 30_000);
  } catch {
    console.error('Voice connection final state:', connection.state.status);
    connection.destroy();
    connection = null;
    throw new Error('Failed to join voice channel within 30 seconds');
  }

  sendStatus({ event: 'joined', channel: channel.name, channelId: channel.id });
  return { channel: channel.name };
}

function leaveChannel() {
  if (player) {
    player.stop(true);
    player = null;
  }
  if (connection) {
    connection.destroy();
    connection = null;
  }
  currentGuildId = null;
  sendStatus({ event: 'left' });
}

function playSound(filePath, volume = 1.0) {
  if (!player || !connection) throw new Error('Not connected to a voice channel');
  const fs = require('fs');
  if (!fs.existsSync(filePath)) throw new Error(`Sound file not found: ${filePath}`);
  console.log('Playing sound:', filePath);
  const resource = createAudioResource(filePath, { inlineVolume: true });
  resource.volume.setVolume(volume);
  player.play(resource);
  sendStatus({ event: 'playback', state: 'playing', file: path.basename(filePath) });
}

function stopSound() {
  if (player) player.stop(true);
}

function isLoggedIn() {
  return client !== null && client.isReady();
}

function isInChannel() {
  return connection !== null;
}

module.exports = {
  login,
  logout,
  getGuilds,
  getVoiceChannels,
  joinChannel,
  leaveChannel,
  playSound,
  stopSound,
  isLoggedIn,
  isInChannel,
  onStatus,
};
