// State
let sounds = [];
let groups = [];
let playingId = null;
let ws = null;
let reconnectTimeout = null;
let volume = 100;

// DOM elements
const soundGrid = document.getElementById('sound-grid');
const volumeSlider = document.getElementById('volume-slider');
const volumeValue = document.getElementById('volume-value');
const stopBtn = document.getElementById('stop-btn');
const connectionStatus = document.getElementById('connection-status');
const connectionText = document.getElementById('connection-text');
const errorToast = document.getElementById('error-toast');
const errorMessage = document.getElementById('error-message');

// API base URL (relative to current page)
const API_BASE = '';

// Get auth token from URL query params if present
const urlParams = new URLSearchParams(window.location.search);
const authToken = urlParams.get('token');

// Show error toast
function showError(message) {
  errorMessage.textContent = message;
  errorToast.classList.remove('hidden');
  setTimeout(() => {
    errorToast.classList.add('hidden');
  }, 4000);
}

// Update connection status
function updateConnectionStatus(status) {
  connectionStatus.className = `status-dot ${status}`;
  
  if (status === 'online') {
    connectionText.textContent = 'Connected';
  } else if (status === 'connecting') {
    connectionText.textContent = 'Connecting...';
  } else {
    connectionText.textContent = 'Disconnected';
  }
}

// Fetch library from API
async function fetchLibrary() {
  try {
    const headers = authToken ? { 'X-Auth-Token': authToken } : {};
    const response = await fetch(`${API_BASE}/api/library`, { headers });
    
    if (!response.ok) {
      throw new Error(`Failed to load library: ${response.statusText}`);
    }
    
    const data = await response.json();
    sounds = data.sounds || [];
    groups = data.groups || [];
    renderSoundGrid();
  } catch (err) {
    console.error('Failed to fetch library:', err);
    showError('Failed to load sounds. Please check connection.');
    soundGrid.innerHTML = '<p class="empty-message">Failed to load sounds. Please refresh the page.</p>';
  }
}

// Render the sound grid
function renderSoundGrid() {
  if (sounds.length === 0) {
    soundGrid.innerHTML = '<p class="empty-message">No sounds available.</p>';
    return;
  }
  
  soundGrid.innerHTML = '';
  
  const ungroupedSounds = sounds.filter(s => !s.group_id);
  const groupedSounds = sounds.filter(s => s.group_id);
  
  // Render groups
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
    
    groupHeader.appendChild(expandIcon);
    groupHeader.appendChild(groupName);
    
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
  
  // Render ungrouped sounds
  if (ungroupedSounds.length > 0) {
    const ungroupedContainer = document.createElement('div');
    ungroupedContainer.className = 'sound-grid-items';
    
    ungroupedSounds.forEach(s => {
      ungroupedContainer.appendChild(createSoundButton(s));
    });
    
    soundGrid.appendChild(ungroupedContainer);
  }
}

// Create a sound button element
function createSoundButton(sound) {
  const wrapper = document.createElement('div');
  wrapper.className = 'sound-btn-wrapper';
  
  const btn = document.createElement('button');
  btn.className = 'sound-btn';
  if (sound.id === playingId) btn.classList.add('playing');
  btn.textContent = sound.name;
  btn.dataset.id = sound.id;
  
  btn.addEventListener('click', () => playSound(sound.id));
  
  if (sound.source_type === 'youtube') {
    const badge = document.createElement('span');
    badge.className = 'source-badge';
    badge.textContent = 'YT';
    wrapper.appendChild(badge);
  }
  
  wrapper.appendChild(btn);
  return wrapper;
}

// Toggle group collapsed state (client-side only)
function toggleGroup(groupId) {
  const group = groups.find(g => g.id === groupId);
  if (!group) return;
  
  group.collapsed = group.collapsed ? 0 : 1;
  
  const groupHeader = soundGrid.querySelector(`[data-group-id="${groupId}"]`);
  if (!groupHeader) return;
  
  const expandIcon = groupHeader.querySelector('.group-expand-icon');
  const groupContent = groupHeader.parentElement.querySelector('.sound-group-content');
  
  if (group.collapsed) {
    expandIcon.textContent = '▶';
    groupContent.classList.add('collapsed');
  } else {
    expandIcon.textContent = '▼';
    groupContent.classList.remove('collapsed');
  }
}

// Play sound via API
async function playSound(id) {
  try {
    const headers = {
      'Content-Type': 'application/json',
    };
    if (authToken) headers['X-Auth-Token'] = authToken;
    
    const response = await fetch(`${API_BASE}/api/play/${id}`, {
      method: 'POST',
      headers,
    });
    
    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.error || 'Failed to play sound');
    }
    
    playingId = id;
    updatePlayingState();
  } catch (err) {
    console.error('Failed to play sound:', err);
    showError(err.message);
  }
}

// Stop playback via API
async function stopPlayback() {
  try {
    const headers = {
      'Content-Type': 'application/json',
    };
    if (authToken) headers['X-Auth-Token'] = authToken;
    
    const response = await fetch(`${API_BASE}/api/stop`, {
      method: 'POST',
      headers,
    });
    
    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.error || 'Failed to stop playback');
    }
    
    playingId = null;
    updatePlayingState();
  } catch (err) {
    console.error('Failed to stop playback:', err);
    showError(err.message);
  }
}

// Update volume via API
async function updateVolume(newVolume) {
  try {
    const headers = {
      'Content-Type': 'application/json',
    };
    if (authToken) headers['X-Auth-Token'] = authToken;
    
    const response = await fetch(`${API_BASE}/api/volume`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ volume: newVolume }),
    });
    
    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.error || 'Failed to update volume');
    }
  } catch (err) {
    console.error('Failed to update volume:', err);
    showError(err.message);
  }
}

// Update playing state in UI
function updatePlayingState() {
  const buttons = soundGrid.querySelectorAll('.sound-btn');
  buttons.forEach(btn => {
    const id = parseInt(btn.dataset.id, 10);
    if (id === playingId) {
      btn.classList.add('playing');
    } else {
      btn.classList.remove('playing');
    }
  });
}

// WebSocket connection
function connectWebSocket() {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const wsUrl = `${protocol}//${window.location.host}/ws`;
  
  updateConnectionStatus('connecting');
  
  ws = new WebSocket(wsUrl);
  
  ws.addEventListener('open', () => {
    console.log('WebSocket connected');
    updateConnectionStatus('online');
    
    if (reconnectTimeout) {
      clearTimeout(reconnectTimeout);
      reconnectTimeout = null;
    }
  });
  
  ws.addEventListener('message', (event) => {
    try {
      const message = JSON.parse(event.data);
      handleWebSocketMessage(message);
    } catch (err) {
      console.error('Failed to parse WebSocket message:', err);
    }
  });
  
  ws.addEventListener('close', () => {
    console.log('WebSocket disconnected');
    updateConnectionStatus('offline');
    ws = null;
    
    // Attempt to reconnect after 3 seconds
    reconnectTimeout = setTimeout(() => {
      connectWebSocket();
    }, 3000);
  });
  
  ws.addEventListener('error', (err) => {
    console.error('WebSocket error:', err);
    updateConnectionStatus('offline');
  });
}

// Handle WebSocket messages
function handleWebSocketMessage(message) {
  const { type, data } = message;
  
  switch (type) {
    case 'init':
      // Initial state from server
      sounds = data.sounds || [];
      groups = data.groups || [];
      volume = data.volume || 100;
      volumeSlider.value = volume;
      volumeValue.textContent = `${volume}%`;
      renderSoundGrid();
      break;
      
    case 'library':
      // Library updated
      sounds = data.sounds || [];
      groups = data.groups || [];
      renderSoundGrid();
      break;
      
    case 'playing':
      // Sound started playing
      playingId = data.id;
      updatePlayingState();
      break;
      
    case 'stopped':
      // Playback stopped
      playingId = null;
      updatePlayingState();
      break;
      
    case 'volume':
      // Volume changed
      volume = data.volume;
      volumeSlider.value = volume;
      volumeValue.textContent = `${volume}%`;
      break;
      
    default:
      console.log('Unknown message type:', type);
  }
}

// Volume slider events
volumeSlider.addEventListener('input', () => {
  volumeValue.textContent = `${volumeSlider.value}%`;
});

let volumeChangeTimeout = null;
volumeSlider.addEventListener('change', () => {
  // Debounce volume updates
  clearTimeout(volumeChangeTimeout);
  volumeChangeTimeout = setTimeout(() => {
    updateVolume(parseInt(volumeSlider.value, 10));
  }, 300);
});

// Stop button
stopBtn.addEventListener('click', () => {
  stopPlayback();
});

// Initialize
async function init() {
  // Fetch initial library
  await fetchLibrary();
  
  // Connect WebSocket for live updates
  connectWebSocket();
  
  // Fetch current status
  try {
    const headers = authToken ? { 'X-Auth-Token': authToken } : {};
    const response = await fetch(`${API_BASE}/api/status`, { headers });
    
    if (response.ok) {
      const status = await response.json();
      volume = status.volume || 100;
      volumeSlider.value = volume;
      volumeValue.textContent = `${volume}%`;
    }
  } catch (err) {
    console.error('Failed to fetch status:', err);
  }
}

// Start the app
init();

// Register service worker for PWA
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(err => {
      console.log('Service worker registration failed:', err);
    });
  });
}
