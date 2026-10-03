// --- State ---
let sounds = [];
let groups = [];
let contextTarget = null;
let playingId = null;
let audioElement = null;
let availableDevices = [];
let armedClipId = null;
let holdToPlayActive = false;
let isKeyHeld = false;
let loadedClipId = null;
let loadedClipName = null;
let loadedClipAutoHold = true;
let loadedClipSimulating = null;
let loadedWatch = null;

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

// --- Modal Dialog System ---
const modalOverlay = $('#modal-overlay');
const modalDialog = $('#modal-dialog');
const modalTitle = $('#modal-title');
const modalMessage = $('#modal-message');
const modalInput = $('#modal-input');
const modalCancelBtn = $('#modal-cancel-btn');
const modalConfirmBtn = $('#modal-confirm-btn');

let modalResolve = null;

function showModal({ title, message, input = false, defaultValue = '', confirmText = 'OK', cancelText = 'Cancel' }) {
  return new Promise((resolve) => {
    modalResolve = resolve;
    
    modalTitle.textContent = title;
    modalMessage.textContent = message;
    modalConfirmBtn.textContent = confirmText;
    modalCancelBtn.textContent = cancelText;
    
    if (input) {
      modalInput.classList.remove('hidden');
      modalInput.value = defaultValue;
      modalInput.focus();
    } else {
      modalInput.classList.add('hidden');
    }
    
    modalOverlay.classList.remove('hidden');
    
    setTimeout(() => {
      if (input) {
        modalInput.select();
      } else {
        modalConfirmBtn.focus();
      }
    }, 50);
  });
}

function closeModal(result) {
  modalOverlay.classList.add('hidden');
  if (modalResolve) {
    modalResolve(result);
    modalResolve = null;
  }
}

modalCancelBtn.addEventListener('click', () => closeModal(null));
modalConfirmBtn.addEventListener('click', () => {
  if (!modalInput.classList.contains('hidden')) {
    closeModal(modalInput.value);
  } else {
    closeModal(true);
  }
});

modalInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    closeModal(modalInput.value);
  } else if (e.key === 'Escape') {
    e.preventDefault();
    closeModal(null);
  }
});

modalOverlay.addEventListener('click', (e) => {
  if (e.target === modalOverlay) {
    closeModal(null);
  }
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !modalOverlay.classList.contains('hidden')) {
    e.preventDefault();
    closeModal(null);
  }
});

// --- Tabs ---
$$('.tab').forEach((tab) => {
  tab.addEventListener('click', () => {
    $$('.tab').forEach((t) => t.classList.remove('active'));
    $$('.tab-content').forEach((c) => c.classList.remove('active'));
    tab.classList.add('active');
    $(`#tab-${tab.dataset.tab}`).classList.add('active');
  });
});

// --- Audio Device Management ---
async function enumerateDevices() {
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    availableDevices = devices.filter(d => d.kind === 'audiooutput');
    updateDeviceList();
    checkVoiceMeeterStatus();
  } catch (err) {
    console.error('Failed to enumerate devices:', err);
  }
}

function updateDeviceList() {
  const select = $('#setting-device');
  const currentValue = select.value;
  select.innerHTML = '<option value="default">System Default</option>';
  
  availableDevices.forEach(device => {
    const option = document.createElement('option');
    option.value = device.deviceId;
    option.textContent = device.label || `Device ${device.deviceId.substring(0, 8)}...`;
    select.appendChild(option);
  });
  
  if (currentValue && Array.from(select.options).some(opt => opt.value === currentValue)) {
    select.value = currentValue;
  }
}

function checkVoiceMeeterStatus() {
  const hasVoiceMeeter = availableDevices.some(device => 
    device.label.toLowerCase().includes('voicemeeter')
  );
  
  const statusText = $('#voicemeeter-status-text');
  const downloadBtn = $('#voicemeeter-download-btn');
  
  if (hasVoiceMeeter) {
    statusText.textContent = '✓ VoiceMeeter Detected';
    statusText.style.color = 'var(--success)';
    downloadBtn.classList.add('hidden');
  } else {
    statusText.textContent = '⚠ VoiceMeeter Not Detected';
    statusText.style.color = 'var(--warning)';
    downloadBtn.classList.remove('hidden');
  }
}

$('#voicemeeter-download-btn').addEventListener('click', () => {
  window.api.openExternal('https://vb-audio.com/Voicemeeter/banana.htm');
});

$('#refresh-devices-btn').addEventListener('click', async () => {
  await enumerateDevices();
});

// --- Settings ---
async function loadSettings() {
  const s = await window.api.settingsGet();
  $('#setting-token').value = s.botToken || '';
  $('#setting-ytdlp').value = s.ytdlpPath || 'yt-dlp';
  $('#setting-ffmpeg').value = s.ffmpegPath || 'ffmpeg';
  $('#setting-autoconnect').checked = s.autoConnect || false;
  $('#setting-hold-to-play').checked = s.holdToPlayMode || false;
  $('#setting-output-mode').value = s.outputMode || 'discord';
  volumeSlider.value = s.volume || 100;
  volumeValue.textContent = `${volumeSlider.value}%`;
  
  holdToPlayActive = s.holdToPlayMode || false;
  
  // Update UI state based on output mode
  updateOutputModeUI(s.outputMode || 'discord');
  
  await enumerateDevices();
  $('#setting-device').value = s.selectedDeviceId || 'default';
  
  // Load remote settings
  await loadRemoteSettings(s);
  await loadHomeServerSettings(s);
  
  return s;
}

// Auto-save helper - shows brief feedback
async function autoSaveSettings() {
  const data = {
    botToken: $('#setting-token').value,
    ytdlpPath: $('#setting-ytdlp').value,
    ffmpegPath: $('#setting-ffmpeg').value,
    autoConnect: $('#setting-autoconnect').checked,
    holdToPlayMode: $('#setting-hold-to-play').checked,
    volume: parseInt(volumeSlider.value, 10),
    outputMode: $('#setting-output-mode').value,
    selectedDeviceId: $('#setting-device').value,
    remoteEnabled: $('#setting-remote-enabled').checked,
    remotePort: parseInt($('#setting-remote-port').value, 10),
    remoteAuthToken: $('#setting-remote-auth').value.trim(),
    homeServerEnabled: $('#setting-home-server-enabled').checked,
    homeServerUrl: $('#setting-home-server-url').value.trim(),
    homeServerToken: $('#setting-home-server-token').value.trim(),
  };
  
  await window.api.settingsSave(data);
  
  // Show saved indicator briefly (if element exists)
  const status = $('#settings-status');
  if (status) {
    status.textContent = 'Saved';
    status.className = 'success-text';
    status.classList.remove('hidden');
    setTimeout(() => status.classList.add('hidden'), 1500);
  }
}

// Output mode change handler - includes Discord leave logic
// Update UI state based on output mode
function updateOutputModeUI(outputMode) {
  const isLocal = outputMode === 'local';
  const localModeNotice = $('#local-mode-notice');
  const guildSelect = $('#guild-select');
  const channelSelect = $('#channel-select');
  const joinBtn = $('#join-btn');
  
  if (isLocal) {
    // Show notice and disable join controls
    localModeNotice.classList.remove('hidden');
    guildSelect.disabled = true;
    channelSelect.disabled = true;
    joinBtn.disabled = true;
    joinBtn.style.opacity = '0.5';
    joinBtn.style.cursor = 'not-allowed';
  } else {
    // Hide notice and restore normal state
    localModeNotice.classList.add('hidden');
    // Guild select enabled if logged in
    const isLoggedIn = !$('#token-logout-btn').classList.contains('hidden');
    guildSelect.disabled = !isLoggedIn;
    // Channel/join button state managed by channel selection
    joinBtn.style.opacity = '';
    joinBtn.style.cursor = '';
  }
}

async function handleOutputModeChange() {
  const oldSettings = await window.api.settingsGet();
  const oldOutputMode = oldSettings.outputMode || 'discord';
  const newOutputMode = $('#setting-output-mode').value;
  
  await autoSaveSettings();
  
  // Update UI state
  updateOutputModeUI(newOutputMode);
  
  // If switched to Local Device Only, leave Discord voice
  if (oldOutputMode !== 'local' && newOutputMode === 'local') {
    const isInChannel = await window.api.botIsInChannel();
    if (isInChannel) {
      await window.api.botLeaveChannel();
    }
  }
}

// Hold-to-play mode change handler
async function handleHoldToPlayChange() {
  await autoSaveSettings();
  holdToPlayActive = $('#setting-hold-to-play').checked;
  if (!holdToPlayActive) {
    armedClipId = null;
  }
  renderSoundGrid();
}

// Auto-save on all setting changes
$('#setting-autoconnect').addEventListener('change', autoSaveSettings);
$('#setting-output-mode').addEventListener('change', handleOutputModeChange);
$('#setting-device').addEventListener('change', autoSaveSettings);
$('#setting-hold-to-play').addEventListener('change', handleHoldToPlayChange);

// Token, ytdlp, and ffmpeg save on blur (after typing)
$('#setting-token').addEventListener('blur', autoSaveSettings);
$('#setting-ytdlp').addEventListener('blur', autoSaveSettings);
$('#setting-ffmpeg').addEventListener('blur', autoSaveSettings);

// --- Remote Control Settings ---
let remoteServerRunning = false;

async function updateRemoteStatus() {
  try {
    const status = await window.api.remoteStatus();
    remoteServerRunning = status.running;
    
    const statusText = $('#remote-status-text');
    const urlsContainer = $('#remote-urls');
    const urlList = $('#remote-url-list');
    const qrContainer = $('#remote-qr');
    
    if (status.running) {
      statusText.textContent = 'Running';
      statusText.style.color = 'var(--success)';
      
      // Show URLs
      urlList.innerHTML = '';
      const labeled = status.urls.map((url) => ({ url, label: '' }));
      (status.secureUrls || []).forEach((url) => labeled.push({ url, label: 'HTTPS mic · ' }));
      labeled.forEach(({ url, label }) => {
        const authToken = $('#setting-remote-auth').value.trim();
        const fullUrl = authToken ? `${url}?token=${encodeURIComponent(authToken)}` : url;
        
        const urlDiv = document.createElement('div');
        urlDiv.style.cssText = 'display: flex; align-items: center; gap: 8px; padding: 8px; background: var(--bg-primary); border-radius: 4px; font-family: monospace; font-size: 12px;';
        
        const urlText = document.createElement('span');
        urlText.textContent = `${label}${fullUrl}`;
        urlText.style.flex = '1';
        urlText.style.wordBreak = 'break-all';
        
        const copyBtn = document.createElement('button');
        copyBtn.textContent = 'Copy';
        copyBtn.style.cssText = 'padding: 4px 10px; font-size: 11px;';
        copyBtn.addEventListener('click', () => {
          navigator.clipboard.writeText(fullUrl);
          copyBtn.textContent = 'Copied!';
          setTimeout(() => copyBtn.textContent = 'Copy', 2000);
        });
        
        urlDiv.appendChild(urlText);
        urlDiv.appendChild(copyBtn);
        urlList.appendChild(urlDiv);
      });
      
      urlsContainer.classList.remove('hidden');
      
      // Generate and show QR code for first URL
      if (status.urls.length > 0) {
        const authToken = $('#setting-remote-auth').value.trim();
        const fullUrl = authToken ? `${status.urls[0]}?token=${encodeURIComponent(authToken)}` : status.urls[0];
        
        const qrResult = await window.api.remoteGenerateQR(fullUrl);
        if (qrResult.qrCode) {
          $('#remote-qr-img').src = qrResult.qrCode;
          qrContainer.classList.remove('hidden');
        }
      }
    } else {
      statusText.textContent = 'Stopped';
      statusText.style.color = 'var(--text-muted)';
      urlsContainer.classList.add('hidden');
      qrContainer.classList.add('hidden');
    }
  } catch (err) {
    console.error('Failed to update remote status:', err);
  }
}

async function handleRemoteEnabledChange() {
  const enabled = $('#setting-remote-enabled').checked;
  const configDiv = $('#remote-config');
  
  if (enabled) {
    configDiv.classList.remove('hidden');
    
    // Start the server
    const port = parseInt($('#setting-remote-port').value, 10);
    const authToken = $('#setting-remote-auth').value.trim();
    
    try {
      await window.api.remoteStart({
        port,
        authToken: authToken || null,
      });
      await updateRemoteStatus();
    } catch (err) {
      console.error('Failed to start remote server:', err);
      await showModal({
        title: 'Remote Server Error',
        message: `Failed to start remote server: ${err.message}`,
        confirmText: 'OK'
      });
      $('#setting-remote-enabled').checked = false;
      configDiv.classList.add('hidden');
    }
  } else {
    configDiv.classList.add('hidden');
    
    // Stop the server
    try {
      await window.api.remoteStop();
      await updateRemoteStatus();
    } catch (err) {
      console.error('Failed to stop remote server:', err);
    }
  }
  
  await autoSaveSettings();
}

async function handleRemotePortChange() {
  if (!remoteServerRunning) {
    await autoSaveSettings();
    return;
  }
  
  // Restart server with new port
  try {
    await window.api.remoteStop();
    const port = parseInt($('#setting-remote-port').value, 10);
    const authToken = $('#setting-remote-auth').value.trim();
    await window.api.remoteStart({
      port,
      authToken: authToken || null,
    });
    await updateRemoteStatus();
    await autoSaveSettings();
  } catch (err) {
    console.error('Failed to restart remote server:', err);
    await showModal({
      title: 'Remote Server Error',
      message: `Failed to restart remote server: ${err.message}`,
      confirmText: 'OK'
    });
  }
}

async function handleRemoteAuthChange() {
  await autoSaveSettings();
  if (remoteServerRunning) {
    await updateRemoteStatus(); // Update QR code with new token
  }
}

$('#setting-remote-enabled').addEventListener('change', handleRemoteEnabledChange);
$('#setting-remote-port').addEventListener('change', handleRemotePortChange);
$('#setting-remote-auth').addEventListener('blur', handleRemoteAuthChange);

// --- Home Server (optional; playback always uses the local library) ---
function renderHomeServerStatus(state) {
  const el = $('#home-server-status-text');
  const msg = $('#home-server-message');
  const syncBtn = $('#home-server-sync-btn');
  if (!el || !msg || !syncBtn) return;

  const status = (state && state.status) || 'idle';
  const labels = {
    connected: 'Connected',
    offline: 'Offline',
    error: 'Error',
    disabled: 'Disabled',
    syncing: 'Syncing…',
    idle: 'Checking…',
  };
  el.textContent = labels[status] || status;
  const colors = {
    connected: 'var(--success)',
    error: 'var(--danger)',
    syncing: 'var(--warning)',
  };
  el.style.color = colors[status] || 'var(--text-muted)';

  const parts = [];
  if (state && state.message) parts.push(state.message);
  if (state && state.lastSyncAt) {
    parts.push(`Last sync ${new Date(state.lastSyncAt).toLocaleString()}`);
  }
  if (state && (state.pulled || state.pushed)) {
    parts.push(`Pulled ${state.pulled || 0}, pushed ${state.pushed || 0}`);
  }
  msg.textContent = parts.join(' · ');

  const enabled = $('#setting-home-server-enabled').checked;
  syncBtn.disabled = !enabled || status === 'syncing';
}

function setHomeServerConfigVisible() {
  const enabled = $('#setting-home-server-enabled').checked;
  $('#home-server-config').classList.toggle('hidden', !enabled);
}

async function loadHomeServerSettings(s) {
  $('#setting-home-server-enabled').checked = !!s.homeServerEnabled;
  $('#setting-home-server-url').value = s.homeServerUrl || '';
  $('#setting-home-server-token').value = s.homeServerToken || '';
  setHomeServerConfigVisible();
  try {
    const state = await window.api.homeServerGetState();
    renderHomeServerStatus(state);
  } catch (err) {
    renderHomeServerStatus({ status: 'offline', message: 'Status unavailable. Local library is still ready.' });
    console.error('Home Server status failed:', err);
  }
}

async function handleHomeServerEnabledChange() {
  setHomeServerConfigVisible();
  await autoSaveSettings();
  if ($('#setting-home-server-enabled').checked) {
    renderHomeServerStatus({ status: 'syncing', message: 'Syncing…' });
    try {
      const state = await window.api.homeServerSync();
      renderHomeServerStatus(state);
    } catch (err) {
      renderHomeServerStatus({
        status: 'offline',
        message: 'Home Server is offline. Playback continues from the local library.',
      });
      console.error('Home Server sync failed:', err);
    }
  } else {
    renderHomeServerStatus({
      status: 'disabled',
      message: 'Home Server is off. Playback uses the local library.',
    });
  }
}

async function handleHomeServerSync() {
  await autoSaveSettings();
  renderHomeServerStatus({ status: 'syncing', message: 'Syncing…' });
  try {
    const state = await window.api.homeServerSync();
    renderHomeServerStatus(state);
  } catch (err) {
    renderHomeServerStatus({
      status: 'offline',
      message: 'Home Server is offline. Playback continues from the local library.',
    });
    console.error('Home Server sync failed:', err);
  }
}

$('#setting-home-server-enabled').addEventListener('change', handleHomeServerEnabledChange);
$('#setting-home-server-url').addEventListener('blur', autoSaveSettings);
$('#setting-home-server-token').addEventListener('blur', autoSaveSettings);
$('#home-server-sync-btn').addEventListener('click', handleHomeServerSync);

window.api.onHomeServerStatus(async (state) => {
  renderHomeServerStatus(state);
  if (state && state.libraryChanged) {
    try {
      await refreshSounds();
    } catch (err) {
      console.error('Failed to refresh sounds after Home Server sync:', err);
    }
  }
});

// Load remote settings
async function loadRemoteSettings(s) {
  $('#setting-remote-enabled').checked = s.remoteEnabled || false;
  $('#setting-remote-port').value = s.remotePort || 3000;
  $('#setting-remote-auth').value = s.remoteAuthToken || '';
  
  if (s.remoteEnabled) {
    $('#remote-config').classList.remove('hidden');
    
    // Auto-start remote server
    try {
      await window.api.remoteStart({
        port: s.remotePort || 3000,
        authToken: s.remoteAuthToken || null,
      });
      await updateRemoteStatus();
    } catch (err) {
      console.error('Failed to auto-start remote server:', err);
      $('#setting-remote-enabled').checked = false;
      $('#remote-config').classList.add('hidden');
    }
  }
}

// --- Volume ---
volumeSlider.addEventListener('input', () => {
  volumeValue.textContent = `${volumeSlider.value}%`;
});

volumeSlider.addEventListener('change', async () => {
  await autoSaveSettings();
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
  
  // Check output mode before joining
  const settings = await window.api.settingsGet();
  const outputMode = settings.outputMode || 'discord';
  if (outputMode === 'local') {
    await showModal({
      title: 'Cannot Join Channel',
      message: 'Cannot join Discord voice channel in "Local Device Only" mode.\n\nChange Output Mode to "Discord Bot Only" or "Both" in Settings to enable Discord bot voice.',
      confirmText: 'OK',
      cancelText: 'Settings'
    });
    return;
  }
  
  joinBtn.disabled = true;
  try {
    await window.api.botJoinChannel(channelId);
    leaveBtn.classList.remove('hidden');
  } catch (err) {
    await showModal({
      title: 'Failed to Join',
      message: `Failed to join: ${err.message}`,
      confirmText: 'OK'
    });
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
  groups = await window.api.groupGetAll();
  renderSoundGrid();
  if (window.mithiumStudioRefresh) window.mithiumStudioRefresh();
}

window.mithiumSounds = () => sounds;
window.mithiumGroups = () => groups;
window.mithiumRefresh = refreshSounds;

function renderSoundGrid() {
  if (sounds.length === 0) {
    soundGrid.innerHTML = '<p class="empty-message">No sounds yet. Import audio, record a take, or search Openverse.</p>';
    return;
  }
  
  soundGrid.innerHTML = '';
  
  const liveGroupIds = new Set(groups.map((group) => group.id));
  const ungroupedSounds = sounds.filter((s) => !s.group_id || !liveGroupIds.has(s.group_id));
  const groupedSounds = sounds.filter((s) => s.group_id && liveGroupIds.has(s.group_id));
  
  groups.forEach(group => {
    const groupSounds = groupedSounds.filter(s => s.group_id === group.id);
    if (groupSounds.length === 0) return;
    
    const groupContainer = document.createElement('div');
    groupContainer.className = 'sound-group';
    
    const groupHeader = document.createElement('div');
    groupHeader.className = 'sound-group-header';
    groupHeader.dataset.groupId = group.id;
    
    const expandIcon = document.createElement('span');
    expandIcon.className = 'group-expand-icon';
    expandIcon.textContent = group.collapsed ? '▶' : '▼';
    
    const groupName = document.createElement('span');
    groupName.className = 'group-name';
    groupName.textContent = group.name;
    
    const groupActions = document.createElement('div');
    groupActions.className = 'group-actions';
    
    const renameBtn = document.createElement('button');
    renameBtn.className = 'group-action-btn';
    renameBtn.textContent = '✏️';
    renameBtn.title = 'Rename group';
    renameBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      renameGroupPrompt(group.id, group.name);
    });
    
    const deleteBtn = document.createElement('button');
    deleteBtn.className = 'group-action-btn';
    deleteBtn.textContent = '🗑️';
    deleteBtn.title = 'Delete group (sounds will be ungrouped)';
    deleteBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      deleteGroupPrompt(group.id, group.name);
    });
    
    groupActions.appendChild(renameBtn);
    groupActions.appendChild(deleteBtn);
    
    groupHeader.appendChild(expandIcon);
    groupHeader.appendChild(groupName);
    groupHeader.appendChild(groupActions);
    
    groupHeader.addEventListener('click', () => toggleGroup(group.id));
    
    const groupContent = document.createElement('div');
    groupContent.className = 'sound-group-content';
    if (group.collapsed) groupContent.classList.add('collapsed');
    
    groupSounds.forEach(s => {
      groupContent.appendChild(createSoundButton(s));
    });
    
    groupContainer.appendChild(groupHeader);
    groupContainer.appendChild(groupContent);
    soundGrid.appendChild(groupContainer);
  });
  
  if (ungroupedSounds.length > 0) {
    if (groups.length > 0) {
      const ungroupedHeader = document.createElement('div');
      ungroupedHeader.className = 'sound-group-header ungrouped-header';
      ungroupedHeader.textContent = 'Ungrouped';
      soundGrid.appendChild(ungroupedHeader);
    }
    
    const ungroupedContainer = document.createElement('div');
    ungroupedContainer.className = 'sound-grid-items';
    
    ungroupedSounds.forEach(s => {
      ungroupedContainer.appendChild(createSoundButton(s));
    });
    
    soundGrid.appendChild(ungroupedContainer);
  }
}

function createSoundButton(s) {
  const wrapper = document.createElement('div');
  wrapper.className = 'sound-btn-wrapper';

  const btn = document.createElement('button');
  btn.className = 'sound-btn';
  if (s.id === playingId) btn.classList.add('playing');
  if (s.id === armedClipId) btn.classList.add('armed');
  if (s.id === loadedClipId) btn.classList.add('loaded');
  btn.dataset.id = s.id;
  const nameEl = document.createElement('span');
  nameEl.textContent = s.name;
  btn.appendChild(nameEl);
  if (s.attribution_license || s.attribution_text) {
    btn.classList.add('has-meta');
    const license = document.createElement('span');
    license.className = 'clip-license';
    license.textContent = s.attribution_license || 'Licensed';
    btn.appendChild(license);
    btn.title = s.attribution_text || s.attribution_license;
  }

  btn.addEventListener('click', () => playSound(s.id));
  btn.addEventListener('contextmenu', (e) => showContextMenu(e, s.id));

  if (s.source_type === 'youtube') {
    const badge = document.createElement('span');
    badge.className = 'source-badge';
    badge.textContent = 'YT';
    wrapper.appendChild(badge);
  }
  
  if (holdToPlayActive) {
    const armBtn = document.createElement('button');
    armBtn.className = 'arm-btn';
    armBtn.textContent = '🎯';
    armBtn.title = 'Arm for V/T when no clip is loaded from the phone';
    armBtn.dataset.id = s.id;
    if (s.id === armedClipId) armBtn.classList.add('armed');
    armBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      toggleArmClip(s.id);
    });
    wrapper.appendChild(armBtn);
  }

  wrapper.appendChild(btn);
  return wrapper;
}

function toggleArmClip(id) {
  if (armedClipId === id) {
    armedClipId = null;
  } else {
    armedClipId = id;
  }
  renderSoundGrid();
}

async function toggleGroup(groupId) {
  await window.api.groupToggleCollapsed(groupId);
  await refreshSounds();
}

async function createGroupPrompt() {
  const name = await showModal({
    title: 'Create New Group',
    message: 'Enter a name for the new group:',
    input: true,
    confirmText: 'Create'
  });
  
  if (name && name.trim()) {
    await window.api.groupCreate(name.trim());
    await refreshSounds();
  }
}

async function renameGroupPrompt(groupId, currentName) {
  const newName = await showModal({
    title: 'Rename Group',
    message: 'Enter a new name for this group:',
    input: true,
    defaultValue: currentName,
    confirmText: 'Rename'
  });
  
  if (newName && newName.trim() && newName.trim() !== currentName) {
    await window.api.groupRename(groupId, newName.trim());
    await refreshSounds();
  }
}

async function deleteGroupPrompt(groupId, groupName) {
  const confirmed = await showModal({
    title: 'Delete Group',
    message: `Delete group "${groupName}"? Sounds in this group will become ungrouped.`,
    confirmText: 'Delete',
    cancelText: 'Cancel'
  });
  
  if (confirmed) {
    await window.api.groupDelete(groupId);
    await refreshSounds();
  }
}

async function moveToGroup(soundId, groupId) {
  await window.api.soundAssignToGroup(soundId, groupId);
  await refreshSounds();
}

async function stopAllPlayback() {
  loadedWatch = null;
  try {
    await window.api.loadedClipHardStop();
  } catch (err) {
    console.error('Failed to release simulated V/T hold:', err);
  }

  try {
    await window.api.soundStop();
  } catch (err) {
    console.error('Failed to stop Discord bot playback:', err);
  }
  
  if (audioElement) {
    audioElement.pause();
    audioElement.currentTime = 0;
  }
  
  playingId = null;
  renderSoundGrid();
  updateLoadedClipBanner();
}

async function playLocalAudio(filePath, volume, deviceId) {
  try {
    if (!audioElement) {
      audioElement = new Audio();
      audioElement.addEventListener('ended', () => {
        playingId = null;
        renderSoundGrid();
        noteLoadedLocalDone();
      });
      audioElement.addEventListener('error', (e) => {
        console.error('Audio playback error:', e);
        playingId = null;
        renderSoundGrid();
        noteLoadedLocalDone();
      });
    }
    
    audioElement.src = filePath;
    audioElement.volume = Math.max(0, Math.min(1, volume));
    
    if (deviceId && deviceId !== 'default' && typeof audioElement.setSinkId === 'function') {
      try {
        await audioElement.setSinkId(deviceId);
      } catch (err) {
        console.error('Failed to set output device:', err);
      }
    }
    
    await audioElement.play();
  } catch (err) {
    console.error('Local playback error:', err);
    throw err;
  }
}

async function playSound(id, opts = {}) {
  if (!opts.fromLoadedHotkey && (loadedWatch || loadedClipSimulating)) {
    await stopAllPlayback();
  }
  try {
    const settings = await window.api.settingsGet();
    const outputMode = settings.outputMode || 'discord';
    
    if (outputMode === 'discord' || outputMode === 'both') {
      if (settings.lastChannelId && leaveBtn.classList.contains('hidden')) {
        try {
          await window.api.botJoinChannel(settings.lastChannelId);
          joinBtn.classList.add('hidden');
          leaveBtn.classList.remove('hidden');
        } catch (err) {
          if (outputMode === 'discord') {
            await showModal({
              title: 'Auto-Join Failed',
              message: `Failed to auto-join channel: ${err.message}`,
              confirmText: 'OK'
            });
            return false;
          }
        }
      }
    }
    
    const result = await window.api.soundPlay(id);
    
    if ((outputMode === 'local' || outputMode === 'both') && result.filePath) {
      await playLocalAudio(result.filePath, result.volume, settings.selectedDeviceId);
    }
    
    playingId = id;
    renderSoundGrid();
    return true;
  } catch (err) {
    await showModal({
      title: 'Playback Error',
      message: `Playback error: ${err.message}`,
      confirmText: 'OK'
    });
    return false;
  }
}

// --- Import ---
importBtn.addEventListener('click', async () => {
  await window.api.soundImport();
  await refreshSounds();
});

// --- Create Group ---
$('#create-group-btn').addEventListener('click', createGroupPrompt);

// --- Stop Button ---
$('#stop-btn').addEventListener('click', async () => {
  await stopAllPlayback();
});

// --- Context Menu ---
function showContextMenu(e, soundId) {
  e.preventDefault();
  contextTarget = soundId;
  
  const groupSubmenu = $('#group-submenu');
  groupSubmenu.innerHTML = '<button data-group-id="">Ungrouped</button>';
  
  groups.forEach(g => {
    const btn = document.createElement('button');
    btn.dataset.groupId = g.id;
    btn.textContent = g.name;
    groupSubmenu.appendChild(btn);
  });
  
  contextMenu.style.left = `${e.clientX}px`;
  contextMenu.style.top = `${e.clientY}px`;
  contextMenu.classList.remove('hidden');
}

document.addEventListener('click', () => {
  contextMenu.classList.add('hidden');
  contextTarget = null;
});

const submenuTrigger = contextMenu.querySelector('.context-submenu-trigger');
const submenuContent = contextMenu.querySelector('.context-submenu-content');

submenuTrigger.addEventListener('click', (e) => {
  e.stopPropagation();
  submenuContent.classList.toggle('hidden');
});

submenuContent.addEventListener('click', async (e) => {
  if (e.target.tagName === 'BUTTON' && contextTarget) {
    const groupId = e.target.dataset.groupId;
    await moveToGroup(contextTarget, groupId || null);
    contextMenu.classList.add('hidden');
  }
});

contextMenu.querySelector('[data-action="edit"]').addEventListener('click', () => {
  const id = contextTarget;
  if (!id || !window.mithiumEditClip) return;
  window.mithiumEditClip(id);
});

contextMenu.querySelector('[data-action="rename"]').addEventListener('click', async () => {
  if (!contextTarget) return;
  const sound = sounds.find((s) => s.id === contextTarget);
  
  const newName = await showModal({
    title: 'Rename Sound',
    message: 'Enter a new name for this sound:',
    input: true,
    defaultValue: sound?.name || '',
    confirmText: 'Rename'
  });
  
  if (newName && newName.trim()) {
    await window.api.soundRename(contextTarget, newName.trim());
    await refreshSounds();
  }
});

contextMenu.querySelector('[data-action="delete"]').addEventListener('click', async () => {
  if (!contextTarget) return;
  const sound = sounds.find((s) => s.id === contextTarget);
  
  const confirmed = await showModal({
    title: 'Delete Sound',
    message: `Delete "${sound?.name}"? This cannot be undone.`,
    confirmText: 'Delete',
    cancelText: 'Cancel'
  });
  
  if (confirmed) {
    if (contextTarget === armedClipId) {
      armedClipId = null;
    }
    await window.api.soundDelete(contextTarget);
    await refreshSounds();
  }
});

// --- YouTube trim range ---
const ytUrl = $('#yt-url');
const ytStart = $('#yt-start');
const ytEnd = $('#yt-end');
const ytRangeStart = $('#yt-range-start');
const ytRangeEnd = $('#yt-range-end');
const ytTrimFill = $('#yt-trim-fill');
const ytTrimHint = $('#yt-trim-hint');

const TRIM_FALLBACK_MAX = 30;
let trimMax = TRIM_FALLBACK_MAX;
let trimStart = 0;
let trimEnd = TRIM_FALLBACK_MAX;
let durationState = 'unknown'; // unknown | loading | known | failed
let trimTouched = false;
let probeToken = 0;
let probeTimer = null;

function paintTrim() {
  const max = Math.max(1, Number(ytRangeStart.max) || TRIM_FALLBACK_MAX);
  const start = Number(ytRangeStart.value);
  const end = Number(ytRangeEnd.value);
  ytTrimFill.style.left = `${(start / max) * 100}%`;
  ytTrimFill.style.right = `${100 - (end / max) * 100}%`;
}

function setSlider(start, end, max) {
  const cap = Math.max(1, max);
  ytRangeStart.max = String(cap);
  ytRangeEnd.max = String(cap);
  ytRangeStart.value = String(start);
  ytRangeEnd.value = String(end);
  paintTrim();
}

function activeCap() {
  return durationState === 'known' ? trimMax : TRIM_FALLBACK_MAX;
}

function writeTouchedFields() {
  if (ytStart.value.trim()) ytStart.value = formatClock(trimStart);
  if (ytEnd.value.trim()) ytEnd.value = formatClock(trimEnd);
}

function applyFallbackClamp() {
  trimMax = TRIM_FALLBACK_MAX;
  const fixed = clampRange(trimStart, trimEnd, TRIM_FALLBACK_MAX, 'end');
  trimStart = fixed.start;
  trimEnd = fixed.end;
  setSlider(trimStart, trimEnd, TRIM_FALLBACK_MAX);
  writeTouchedFields();
}

function applyKnownDuration(seconds) {
  const max = Math.max(1, Math.floor(Number(seconds)));
  durationState = 'known';
  trimMax = max;
  const fixed = clampRange(trimStart, trimEnd, max, 'end');
  trimStart = fixed.start;
  trimEnd = fixed.end;
  setSlider(trimStart, trimEnd, max);
  writeTouchedFields();
  ytTrimHint.textContent = `Video length ${formatClock(max)}`;
}

function resetTrim() {
  probeToken += 1;
  clearTimeout(probeTimer);
  durationState = 'unknown';
  trimTouched = false;
  trimStart = 0;
  trimEnd = TRIM_FALLBACK_MAX;
  trimMax = TRIM_FALLBACK_MAX;
  setSlider(0, TRIM_FALLBACK_MAX, TRIM_FALLBACK_MAX);
  ytTrimHint.textContent = 'Duration unknown — range limited to 0:30';
}

async function probeUrl(url, token) {
  durationState = 'loading';
  ytTrimHint.textContent = 'Checking duration…';
  try {
    const result = await window.api.youtubeProbeDuration(url);
    if (token !== probeToken) return;
    const seconds = Number(result && result.duration);
    if (!Number.isFinite(seconds) || seconds < 1) {
      throw new Error('Could not read video duration');
    }
    applyKnownDuration(seconds);
  } catch (err) {
    if (token !== probeToken) return;
    durationState = 'failed';
    applyFallbackClamp();
    ytTrimHint.textContent = "Couldn't read duration — range limited to 0:30";
    console.error('Duration probe failed:', err && err.message ? err.message : err);
  }
}

function scheduleProbe() {
  clearTimeout(probeTimer);
  probeToken += 1;
  const token = probeToken;
  const url = ytUrl.value.trim();
  if (!url || !isYoutubeUrl(url)) {
    durationState = 'unknown';
    trimMax = TRIM_FALLBACK_MAX;
    const vis = clampRange(
      Math.min(trimStart, TRIM_FALLBACK_MAX),
      Math.min(Math.max(trimEnd, 1), TRIM_FALLBACK_MAX),
      TRIM_FALLBACK_MAX,
      'end'
    );
    setSlider(vis.start, vis.end, TRIM_FALLBACK_MAX);
    ytTrimHint.textContent = 'Duration unknown — range limited to 0:30';
    return;
  }
  durationState = 'loading';
  ytTrimHint.textContent = 'Checking duration…';
  probeTimer = setTimeout(() => probeUrl(url, token), 400);
}

ytUrl.addEventListener('input', scheduleProbe);

function onRangeInput(prefer) {
  const cap = Math.max(1, Number(ytRangeStart.max) || TRIM_FALLBACK_MAX);
  const fixed = clampRange(Number(ytRangeStart.value), Number(ytRangeEnd.value), cap, prefer);
  trimStart = fixed.start;
  trimEnd = fixed.end;
  trimMax = durationState === 'known' ? cap : TRIM_FALLBACK_MAX;
  trimTouched = true;
  setSlider(trimStart, trimEnd, cap);
  ytStart.value = formatClock(trimStart);
  ytEnd.value = formatClock(trimEnd);
}

ytRangeStart.addEventListener('input', () => onRangeInput('start'));
ytRangeEnd.addEventListener('input', () => onRangeInput('end'));
ytRangeStart.addEventListener('pointerdown', () => {
  ytRangeStart.style.zIndex = '4';
  ytRangeEnd.style.zIndex = '3';
});
ytRangeEnd.addEventListener('pointerdown', () => {
  ytRangeEnd.style.zIndex = '4';
  ytRangeStart.style.zIndex = '3';
});

function previewFromText(prefer) {
  const rawStart = parseClock(ytStart.value);
  const rawEnd = parseClock(ytEnd.value);
  if (rawStart != null) trimStart = rawStart;
  if (rawEnd != null) trimEnd = rawEnd;
  if (rawStart != null || rawEnd != null) trimTouched = true;
  const cap = activeCap();
  // While a probe is in flight, keep typed times past the temporary 0:30 cap.
  const vis = clampRange(Math.min(trimStart, cap), Math.min(Math.max(trimEnd, 1), cap), cap, prefer);
  setSlider(vis.start, vis.end, cap);
}

ytStart.addEventListener('input', () => previewFromText('start'));
ytEnd.addEventListener('input', () => previewFromText('end'));

function commitText(prefer) {
  const input = prefer === 'start' ? ytStart : ytEnd;
  const raw = input.value.trim();
  if (!raw) {
    if (trimTouched) input.value = formatClock(prefer === 'start' ? trimStart : trimEnd);
    return;
  }
  const parsed = parseClock(raw);
  if (parsed == null) {
    input.value = formatClock(prefer === 'start' ? trimStart : trimEnd);
    previewFromText(prefer);
    return;
  }
  if (prefer === 'start') trimStart = parsed;
  else trimEnd = parsed;
  trimTouched = true;

  if (durationState === 'loading') {
    if (trimStart >= trimEnd) {
      const fixed = clampRange(trimStart, trimEnd, Math.max(trimEnd, trimStart + 1, 1), prefer);
      trimStart = fixed.start;
      trimEnd = fixed.end;
    }
    if (ytStart.value.trim()) ytStart.value = formatClock(trimStart);
    if (ytEnd.value.trim()) ytEnd.value = formatClock(trimEnd);
    input.value = formatClock(prefer === 'start' ? trimStart : trimEnd);
    previewFromText(prefer);
    return;
  }

  const cap = activeCap();
  const fixed = clampRange(trimStart, trimEnd, cap, prefer);
  trimStart = fixed.start;
  trimEnd = fixed.end;
  setSlider(trimStart, trimEnd, cap);
  ytStart.value = ytStart.value.trim() ? formatClock(trimStart) : ytStart.value;
  ytEnd.value = ytEnd.value.trim() ? formatClock(trimEnd) : ytEnd.value;
  input.value = formatClock(prefer === 'start' ? trimStart : trimEnd);
}

ytStart.addEventListener('blur', () => commitText('start'));
ytEnd.addEventListener('blur', () => commitText('end'));

// --- YouTube Extraction ---
$('#yt-extract-btn').addEventListener('click', async () => {
  commitText('start');
  commitText('end');
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
    resetTrim();
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
      if (status.state === 'playing') noteLoadedDiscordPlaying();
      if (status.state === 'idle') {
        playingId = null;
        renderSoundGrid();
        noteLoadedDiscordIdle();
      }
      break;
    case 'error':
      console.error('Bot error:', status.message);
      showModal({
        title: 'Bot Error',
        message: `Bot error: ${status.message}`,
        confirmText: 'OK'
      });
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

// --- Software Updates ---
let updateDownloaded = false;

$('#check-updates-btn').addEventListener('click', async () => {
  $('#check-updates-btn').disabled = true;
  $('#check-updates-btn').textContent = 'Checking...';
  $('#update-info').classList.add('hidden');
  
  try {
    await window.api.updateCheck();
  } catch (err) {
    $('#update-message').textContent = `Update check failed: ${err.message}`;
    $('#update-info').classList.remove('hidden');
    $('#update-actions').classList.add('hidden');
  } finally {
    $('#check-updates-btn').disabled = false;
    $('#check-updates-btn').textContent = 'Check for Updates';
  }
});

$('#download-update-btn').addEventListener('click', async () => {
  $('#download-update-btn').disabled = true;
  $('#download-update-btn').textContent = 'Downloading...';
  $('#update-progress-container').classList.remove('hidden');
  
  try {
    await window.api.updateDownload();
  } catch (err) {
    $('#update-message').textContent = `Download failed: ${err.message}`;
    $('#update-progress-container').classList.add('hidden');
    $('#download-update-btn').disabled = false;
    $('#download-update-btn').textContent = 'Download Update';
  }
});

$('#install-update-btn').addEventListener('click', () => {
  window.api.updateInstall();
});

window.api.onUpdateChecking(() => {
  console.log('Checking for updates...');
});

window.api.onUpdateAvailable((info) => {
  console.log('Update available:', info.version);
  $('#update-message').textContent = `Version ${info.version} is available! Current: ${info.currentVersion || 'unknown'}`;
  $('#update-info').classList.remove('hidden');
  $('#update-actions').classList.remove('hidden');
  $('#download-update-btn').classList.remove('hidden');
  $('#install-update-btn').classList.add('hidden');
  updateDownloaded = false;
});

window.api.onUpdateNotAvailable((info) => {
  console.log('No updates available');
  $('#update-message').textContent = `You're running the latest version (${info.version})`;
  $('#update-message').style.color = 'var(--success)';
  $('#update-info').classList.remove('hidden');
  $('#update-actions').classList.add('hidden');
  setTimeout(() => {
    $('#update-info').classList.add('hidden');
  }, 3000);
});

window.api.onUpdateProgress((progress) => {
  const percent = Math.round(progress.percent);
  $('#update-progress-fill').style.width = `${percent}%`;
  $('#update-progress-text').textContent = `${percent}% (${formatBytes(progress.transferred)} / ${formatBytes(progress.total)})`;
});

window.api.onUpdateDownloaded((info) => {
  console.log('Update downloaded:', info.version);
  updateDownloaded = true;
  $('#update-message').textContent = `Version ${info.version} downloaded and ready to install!`;
  $('#update-message').style.color = 'var(--success)';
  $('#update-progress-container').classList.add('hidden');
  $('#download-update-btn').classList.add('hidden');
  $('#install-update-btn').classList.remove('hidden');
});

window.api.onUpdateError((message) => {
  console.error('Update error:', message);
  $('#update-message').textContent = `Update error: ${message}`;
  $('#update-message').style.color = 'var(--danger)';
  $('#update-info').classList.remove('hidden');
  $('#update-actions').classList.add('hidden');
  $('#update-progress-container').classList.add('hidden');
});

// --- Library Backup ---
async function updateLibraryInfo() {
  try {
    const info = await window.api.libraryGetInfo();
    $('#library-sound-count').textContent = info.soundCount;
    $('#library-group-count').textContent = info.groupCount;
    $('#library-size').textContent = info.totalSizeMB;
    $('#library-path').textContent = info.soundsDir;
  } catch (err) {
    console.error('Failed to get library info:', err);
  }
}

$('#library-backup-btn').addEventListener('click', async () => {
  const btn = $('#library-backup-btn');
  const statusEl = $('#library-status');
  
  btn.disabled = true;
  btn.textContent = 'Creating Backup...';
  statusEl.classList.add('hidden');
  
  try {
    const result = await window.api.libraryBackup();
    
    if (result.canceled) {
      btn.textContent = 'Backup Library';
      btn.disabled = false;
      return;
    }
    
    statusEl.textContent = `✓ Backup created successfully! ${result.soundsCopied} of ${result.totalSounds} sounds backed up to: ${result.backupPath}`;
    statusEl.style.background = 'var(--success-bg, #1a4d2e)';
    statusEl.style.color = 'var(--success-text, #4ade80)';
    statusEl.classList.remove('hidden');
  } catch (err) {
    statusEl.textContent = `✗ Backup failed: ${err.message}`;
    statusEl.style.background = 'var(--error-bg, #4d1a1a)';
    statusEl.style.color = 'var(--error-text, #f87171)';
    statusEl.classList.remove('hidden');
  } finally {
    btn.textContent = 'Backup Library';
    btn.disabled = false;
  }
});

$('#library-restore-btn').addEventListener('click', async () => {
  const btn = $('#library-restore-btn');
  const statusEl = $('#library-status');
  
  const confirmed = await showModal({
    title: 'Restore from Backup',
    message: 'This will replace your current sound library with the backup. Your current library will be saved to a temporary location as a safety measure.\n\nDo you want to continue?',
    confirmText: 'Restore',
    cancelText: 'Cancel'
  });
  
  if (!confirmed) return;
  
  btn.disabled = true;
  btn.textContent = 'Restoring...';
  statusEl.classList.add('hidden');
  
  try {
    const result = await window.api.libraryRestore();
    
    if (result.canceled) {
      btn.textContent = 'Restore from Backup';
      btn.disabled = false;
      return;
    }
    
    statusEl.textContent = `✓ Restore completed! ${result.restoredCount} sounds restored from backup created on ${new Date(result.manifest.backupDate).toLocaleString()}. Your previous library was saved to: ${result.tempBackupPath}`;
    statusEl.style.background = 'var(--success-bg, #1a4d2e)';
    statusEl.style.color = 'var(--success-text, #4ade80)';
    statusEl.classList.remove('hidden');
    
    // Reload the sound grid
    await loadSounds();
    await updateLibraryInfo();
  } catch (err) {
    statusEl.textContent = `✗ Restore failed: ${err.message}`;
    statusEl.style.background = 'var(--error-bg, #4d1a1a)';
    statusEl.style.color = 'var(--error-text, #f87171)';
    statusEl.classList.remove('hidden');
  } finally {
    btn.textContent = 'Restore from Backup';
    btn.disabled = false;
  }
});

// Update library info when settings tab is opened
const tabButtons = document.querySelectorAll('.tab');
tabButtons.forEach(btn => {
  const originalClick = btn.onclick;
  btn.addEventListener('click', () => {
    if (btn.dataset.tab === 'settings') {
      updateLibraryInfo();
    }
  });
});

// Initial library info load
updateLibraryInfo();

function formatBytes(bytes) {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return Math.round(bytes / Math.pow(k, i) * 100) / 100 + ' ' + sizes[i];
}

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
      
      // If Output Mode is Local Device Only, ensure bot is not in a voice channel
      const outputMode = settings.outputMode || 'discord';
      if (outputMode === 'local') {
        const isInChannel = await window.api.botIsInChannel();
        if (isInChannel) {
          console.log('Output Mode is Local Device Only - leaving voice channel');
          await window.api.botLeaveChannel();
        }
      }
    } catch {
      botStatusText.textContent = 'Auto-login failed';
      botStatus.className = 'status-dot offline';
    }
  }
})();

function updateLoadedClipBanner() {
  const banner = $('#loaded-clip-banner');
  const text = $('#loaded-clip-text');
  const hold = $('#loaded-clip-hold');
  if (!banner || !text || !hold) return;
  if (loadedClipId == null) {
    banner.classList.remove('active');
    text.textContent = 'No clip loaded. Set one on the phone remote.';
  } else {
    banner.classList.add('active');
    const name = loadedClipName || 'Loaded clip';
    text.textContent = `Loaded: ${name}`;
  }
  if (loadedClipSimulating === 'v' || loadedClipSimulating === 't') {
    hold.textContent = `Holding ${loadedClipSimulating.toUpperCase()}`;
    hold.classList.remove('hidden');
  } else {
    hold.textContent = loadedClipAutoHold ? 'V/T auto-hold on' : 'V/T auto-hold off';
    hold.classList.remove('hidden');
  }
}

function applyLoadedClipState(state) {
  if (!state) return;
  loadedClipId = state.id == null ? null : Number(state.id);
  if (!Number.isFinite(loadedClipId)) loadedClipId = null;
  loadedClipName = state.name || null;
  if (typeof state.autoHold === 'boolean') loadedClipAutoHold = state.autoHold;
  loadedClipSimulating = state.simulating || null;
  updateLoadedClipBanner();
  renderSoundGrid();
}

function noteLoadedLocalDone() {
  if (!loadedWatch || loadedWatch.settled) return;
  loadedWatch.localPending = false;
  finishLoadedWatch();
}

function noteLoadedDiscordPlaying() {
  if (!loadedWatch || loadedWatch.settled) return;
  loadedWatch.discordSawPlaying = true;
}

function noteLoadedDiscordIdle() {
  if (!loadedWatch || loadedWatch.settled || !loadedWatch.discordPending) return;
  if (!loadedWatch.discordSawPlaying) return;
  loadedWatch.discordPending = false;
  finishLoadedWatch();
}

function finishLoadedWatch() {
  if (!loadedWatch || loadedWatch.settled) return;
  if (loadedWatch.localPending || loadedWatch.discordPending) return;
  loadedWatch.settled = true;
  loadedWatch = null;
  window.api.loadedClipEnded();
}

async function playLoadedFromHotkey(id) {
  const settings = await window.api.settingsGet();
  const mode = settings.outputMode || 'discord';
  loadedWatch = {
    localPending: mode === 'local' || mode === 'both',
    discordPending: mode === 'discord' || mode === 'both',
    discordSawPlaying: false,
    settled: false,
  };
  const ok = await playSound(id, { fromLoadedHotkey: true });
  if (!loadedWatch || loadedWatch.settled) return;
  if (!ok) {
    loadedWatch = null;
    window.api.loadedClipPlayFailed();
  }
}

function handleLegacyKeyDown(key) {
  if (!armedClipId) return;
  if (!holdToPlayActive) {
    playSound(armedClipId);
    return;
  }
  if (!isKeyHeld) {
    isKeyHeld = true;
    playSound(armedClipId);
  }
}

async function handleLegacyKeyUp(key) {
  if (!holdToPlayActive || !armedClipId || !isKeyHeld) return;
  if (key !== 'v' && key !== 't') return;
  isKeyHeld = false;
  await stopAllPlayback();
  armedClipId = null;
  renderSoundGrid();
}

// --- Keyboard Handlers ---
// Focused window uses these. Unfocused / tray uses the global hook in main,
// which calls the same loaded-clip path. Text fields are left alone.
document.addEventListener('keydown', async (e) => {
  const target = e.target;
  const isInputField = target.tagName === 'INPUT' || target.tagName === 'TEXTAREA';
  if (isInputField) return;

  if (e.key === 'Delete') {
    e.preventDefault();
    stopAllPlayback();
    return;
  }

  const key = e.key.toLowerCase();
  if (key !== 'v' && key !== 't') return;
  if (e.repeat) return;
  e.preventDefault();

  const decision = await window.api.loadedClipKeyDown(key);
  if (!decision || decision.type === 'legacy') handleLegacyKeyDown(key);
});

document.addEventListener('keyup', async (e) => {
  const target = e.target;
  const isInputField = target.tagName === 'INPUT' || target.tagName === 'TEXTAREA';
  if (isInputField) return;

  const key = e.key.toLowerCase();
  if (key !== 'v' && key !== 't') return;
  e.preventDefault();

  const decision = await window.api.loadedClipKeyUp(key);
  if (!decision || decision.type === 'legacy') handleLegacyKeyUp(key);
});

// Legacy armed-clip path when the window is not focused and nothing is loaded.
window.api.onGlobalHotkeyKeydown((key) => {
  if (key === 'Delete') {
    stopAllPlayback();
    return;
  }
  if ((key === 'v' || key === 't') && loadedClipId == null) handleLegacyKeyDown(key);
});

window.api.onGlobalHotkeyKeyup(async (key) => {
  if ((key === 'v' || key === 't') && loadedClipId == null) handleLegacyKeyUp(key);
});

window.api.onLoadedClipState((state) => {
  applyLoadedClipState(state);
});

window.api.onLoadedClipPlay((data) => {
  if (!data || data.id == null) return;
  playLoadedFromHotkey(data.id);
});

window.api.onLoadedClipForceStop(() => {
  stopAllPlayback();
});

window.api.onRemotePlayLocal(async (data) => {
  if (!data || !data.filePath) return;
  try {
    const settings = await window.api.settingsGet();
    await playLocalAudio(data.filePath, data.volume == null ? 1 : data.volume, settings.selectedDeviceId);
    if (data.id != null) {
      playingId = data.id;
      renderSoundGrid();
    }
  } catch (err) {
    console.error('Remote local playback failed:', err);
  }
});

window.api.loadedClipGetState().then((state) => {
  applyLoadedClipState(state);
}).catch((err) => {
  console.error('Failed to read loaded clip:', err);
});

startDesktopStudio();
