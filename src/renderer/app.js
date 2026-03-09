// --- State ---
let sounds = [];
let contextTarget = null;
let playingId = null;

// --- DOM refs ---
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

const botStatus = $('#bot-status');
const botStatusText = $('#bot-status-text');
const guildSelect = $('#guild-select');
const channelSelect = $('#channel-select');
const joinBtn = $('#join-btn');
const leaveBtn = $('#leave-btn');
const soundGrid = $('#sound-grid');
const importBtn = $('#import-btn');
const volumeSlider = $('#volume-slider');
const volumeValue = $('#volume-value');
const contextMenu = $('#context-menu');

// --- Tabs ---
$$('.tab').forEach((tab) => {
  tab.addEventListener('click', () => {
    $$('.tab').forEach((t) => t.classList.remove('active'));
    $$('.tab-content').forEach((c) => c.classList.remove('active'));
    tab.classList.add('active');
    $(`#tab-${tab.dataset.tab}`).classList.add('active');
  });
});

// --- Settings ---
async function loadSettings() {
  const s = await window.api.settingsGet();
  $('#setting-token').value = s.botToken || '';
  $('#setting-ytdlp').value = s.ytdlpPath || 'yt-dlp';
  $('#setting-ffmpeg').value = s.ffmpegPath || 'ffmpeg';
  $('#setting-autoconnect').checked = s.autoConnect || false;
  volumeSlider.value = s.volume || 100;
  volumeValue.textContent = `${volumeSlider.value}%`;
  return s;
}

$('#settings-save-btn').addEventListener('click', async () => {
  const data = {
    botToken: $('#setting-token').value,
    ytdlpPath: $('#setting-ytdlp').value,
    ffmpegPath: $('#setting-ffmpeg').value,
    autoConnect: $('#setting-autoconnect').checked,
    volume: parseInt(volumeSlider.value, 10),
  };
  await window.api.settingsSave(data);
  const status = $('#settings-status');
  status.textContent = 'Settings saved!';
  status.className = 'success-text';
  status.classList.remove('hidden');
  setTimeout(() => status.classList.add('hidden'), 2000);
});

// --- Volume ---
volumeSlider.addEventListener('input', () => {
  volumeValue.textContent = `${volumeSlider.value}%`;
});

volumeSlider.addEventListener('change', async () => {
  const s = await window.api.settingsGet();
  s.volume = parseInt(volumeSlider.value, 10);
  await window.api.settingsSave(s);
});

// --- Bot Login ---
$('#token-login-btn').addEventListener('click', async () => {
  const token = $('#setting-token').value.trim();
  if (!token) return;
  botStatusText.textContent = 'Connecting...';
  botStatus.className = 'status-dot connecting';
  try {
    const result = await window.api.botLogin(token);
    botStatusText.textContent = `Logged in as ${result.user}`;
    botStatus.className = 'status-dot online';
    $('#token-login-btn').classList.add('hidden');
    $('#token-logout-btn').classList.remove('hidden');
    await loadGuilds();
  } catch (err) {
    botStatusText.textContent = `Login failed: ${err.message}`;
    botStatus.className = 'status-dot offline';
  }
});

$('#token-logout-btn').addEventListener('click', async () => {
  await window.api.botLogout();
  botStatusText.textContent = 'Disconnected';
  botStatus.className = 'status-dot offline';
  $('#token-login-btn').classList.remove('hidden');
  $('#token-logout-btn').classList.add('hidden');
  guildSelect.innerHTML = '<option value="">Select Server</option>';
  guildSelect.disabled = true;
  channelSelect.innerHTML = '<option value="">Select Channel</option>';
  channelSelect.disabled = true;
  joinBtn.disabled = true;
  leaveBtn.classList.add('hidden');
  joinBtn.classList.remove('hidden');
});

// --- Guild / Channel Selection ---
async function loadGuilds() {
  const guilds = await window.api.botGetGuilds();
  guildSelect.innerHTML = '<option value="">Select Server</option>';
  guilds.forEach((g) => {
    const opt = document.createElement('option');
    opt.value = g.id;
    opt.textContent = g.name;
    guildSelect.appendChild(opt);
  });
  guildSelect.disabled = false;

  // Restore last guild
  const settings = await window.api.settingsGet();
  if (settings.lastGuildId) {
    guildSelect.value = settings.lastGuildId;
    await loadChannels(settings.lastGuildId);
    if (settings.lastChannelId) {
      channelSelect.value = settings.lastChannelId;
      joinBtn.disabled = false;
    }
  }
}

guildSelect.addEventListener('change', async () => {
  const guildId = guildSelect.value;
  if (!guildId) {
    channelSelect.innerHTML = '<option value="">Select Channel</option>';
    channelSelect.disabled = true;
    joinBtn.disabled = true;
    return;
  }
  const s = await window.api.settingsGet();
  s.lastGuildId = guildId;
  await window.api.settingsSave(s);
  await loadChannels(guildId);
});

async function loadChannels(guildId) {
  const channels = await window.api.botGetVoiceChannels(guildId);
  channelSelect.innerHTML = '<option value="">Select Channel</option>';
  channels.forEach((c) => {
    const opt = document.createElement('option');
    opt.value = c.id;
    opt.textContent = c.name;
    channelSelect.appendChild(opt);
  });
  channelSelect.disabled = false;
}

channelSelect.addEventListener('change', () => {
  joinBtn.disabled = !channelSelect.value;
});

joinBtn.addEventListener('click', async () => {
  const channelId = channelSelect.value;
  if (!channelId) return;
  joinBtn.disabled = true;
  try {
    await window.api.botJoinChannel(channelId);
    leaveBtn.classList.remove('hidden');
  } catch (err) {
    alert(`Failed to join: ${err.message}`);
  }
  joinBtn.disabled = false;
});

leaveBtn.addEventListener('click', async () => {
  await window.api.botLeaveChannel();
  leaveBtn.classList.add('hidden');
  joinBtn.classList.remove('hidden');
  joinBtn.disabled = false;
});

// --- Sound Grid ---
async function refreshSounds() {
  sounds = await window.api.soundGetAll();
  renderSoundGrid();
}

function renderSoundGrid() {
  if (sounds.length === 0) {
    soundGrid.innerHTML = '<p class="empty-message">No sounds yet. Import some audio files or extract from YouTube.</p>';
    return;
  }
  soundGrid.innerHTML = '';
  sounds.forEach((s) => {
    const wrapper = document.createElement('div');
    wrapper.className = 'sound-btn-wrapper';

    const btn = document.createElement('button');
    btn.className = 'sound-btn';
    if (s.id === playingId) btn.classList.add('playing');
    btn.textContent = s.name;
    btn.dataset.id = s.id;

    btn.addEventListener('click', () => playSound(s.id));
    btn.addEventListener('contextmenu', (e) => showContextMenu(e, s.id));

    if (s.source_type === 'youtube') {
      const badge = document.createElement('span');
      badge.className = 'source-badge';
      badge.textContent = 'YT';
      wrapper.appendChild(badge);
    }

    wrapper.appendChild(btn);
    soundGrid.appendChild(wrapper);
  });
}

async function playSound(id) {
  try {
    // Auto-join last channel if not connected
    const settings = await window.api.settingsGet();
    if (settings.lastChannelId && leaveBtn.classList.contains('hidden')) {
      try {
        await window.api.botJoinChannel(settings.lastChannelId);
        joinBtn.classList.add('hidden');
        leaveBtn.classList.remove('hidden');
      } catch (err) {
        alert(`Failed to auto-join channel: ${err.message}`);
        return;
      }
    }
    await window.api.soundPlay(id);
    playingId = id;
    renderSoundGrid();
  } catch (err) {
    alert(`Playback error: ${err.message}`);
  }
}

// --- Import ---
importBtn.addEventListener('click', async () => {
  await window.api.soundImport();
  await refreshSounds();
});

// --- Context Menu ---
function showContextMenu(e, soundId) {
  e.preventDefault();
  contextTarget = soundId;
  contextMenu.style.left = `${e.clientX}px`;
  contextMenu.style.top = `${e.clientY}px`;
  contextMenu.classList.remove('hidden');
}

document.addEventListener('click', () => {
  contextMenu.classList.add('hidden');
  contextTarget = null;
});

contextMenu.querySelector('[data-action="rename"]').addEventListener('click', async () => {
  if (!contextTarget) return;
  const sound = sounds.find((s) => s.id === contextTarget);
  const newName = prompt('Rename sound:', sound?.name || '');
  if (newName && newName.trim()) {
    await window.api.soundRename(contextTarget, newName.trim());
    await refreshSounds();
  }
});

contextMenu.querySelector('[data-action="delete"]').addEventListener('click', async () => {
  if (!contextTarget) return;
  const sound = sounds.find((s) => s.id === contextTarget);
  if (confirm(`Delete "${sound?.name}"?`)) {
    await window.api.soundDelete(contextTarget);
    await refreshSounds();
  }
});

// --- YouTube Extraction ---
$('#yt-extract-btn').addEventListener('click', async () => {
  const url = $('#yt-url').value.trim();
  const start = $('#yt-start').value.trim();
  const end = $('#yt-end').value.trim();
  const name = $('#yt-name').value.trim();

  const errEl = $('#yt-error');
  errEl.classList.add('hidden');

  if (!url || !start || !end || !name) {
    errEl.textContent = 'All fields are required.';
    errEl.classList.remove('hidden');
    return;
  }

  const progress = $('#yt-progress');
  const progressFill = $('#yt-progress-fill');
  const progressText = $('#yt-progress-text');
  progress.classList.remove('hidden');
  progressFill.style.width = '0%';
  progressText.textContent = '0%';
  $('#yt-extract-btn').disabled = true;

  try {
    await window.api.youtubeExtract({ url, start, end, name });
    progress.classList.add('hidden');
    $('#yt-url').value = '';
    $('#yt-start').value = '';
    $('#yt-end').value = '';
    $('#yt-name').value = '';
    await refreshSounds();
    // Switch to soundboard tab
    $$('.tab').forEach((t) => t.classList.remove('active'));
    $$('.tab-content').forEach((c) => c.classList.remove('active'));
    $$('.tab')[0].classList.add('active');
    $('#tab-sounds').classList.add('active');
  } catch (err) {
    errEl.textContent = err.message;
    errEl.classList.remove('hidden');
    progress.classList.add('hidden');
  }
  $('#yt-extract-btn').disabled = false;
});

// --- Status Events ---
window.api.onStatus((status) => {
  switch (status.event) {
    case 'login':
      botStatus.className = 'status-dot online';
      botStatusText.textContent = `Logged in as ${status.user}`;
      break;
    case 'logout':
      botStatus.className = 'status-dot offline';
      botStatusText.textContent = 'Disconnected';
      break;
    case 'joined':
      botStatusText.textContent = `Connected to ${status.channel}`;
      break;
    case 'left':
      botStatusText.textContent = 'Not in a channel';
      leaveBtn.classList.add('hidden');
      joinBtn.classList.remove('hidden');
      joinBtn.disabled = false;
      break;
    case 'playback':
      if (status.state === 'idle') {
        playingId = null;
        renderSoundGrid();
      }
      break;
    case 'error':
      console.error('Bot error:', status.message);
      alert(`Bot error: ${status.message}`);
      break;
  }
});

window.api.onYoutubeProgress((pct) => {
  const fill = $('#yt-progress-fill');
  const text = $('#yt-progress-text');
  if (fill && text) {
    fill.style.width = `${pct}%`;
    text.textContent = `${Math.round(pct)}%`;
  }
});

// --- External Links ---
$('#link-discord-dev').addEventListener('click', (e) => {
  e.preventDefault();
  window.api.openExternal('https://discord.com/developers/applications');
});

// --- Init ---
(async () => {
  const settings = await loadSettings();
  await refreshSounds();

  // Auto-login if token saved
  if (settings.botToken) {
    botStatusText.textContent = 'Connecting...';
    botStatus.className = 'status-dot connecting';
    try {
      const result = await window.api.botLogin(settings.botToken);
      botStatusText.textContent = `Logged in as ${result.user}`;
      botStatus.className = 'status-dot online';
      $('#token-login-btn').classList.add('hidden');
      $('#token-logout-btn').classList.remove('hidden');
      await loadGuilds();
    } catch {
      botStatusText.textContent = 'Auto-login failed';
      botStatus.className = 'status-dot offline';
    }
  }
})();
