const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  // Bot
  botLogin: (token) => ipcRenderer.invoke('bot:login', token),
  botLogout: () => ipcRenderer.invoke('bot:logout'),
  botGetGuilds: () => ipcRenderer.invoke('bot:getGuilds'),
  botGetVoiceChannels: (guildId) => ipcRenderer.invoke('bot:getVoiceChannels', guildId),
  botJoinChannel: (channelId) => ipcRenderer.invoke('bot:joinChannel', channelId),
  botLeaveChannel: () => ipcRenderer.invoke('bot:leaveChannel'),
  botIsInChannel: () => ipcRenderer.invoke('bot:isInChannel'),

  // Sounds
  soundGetAll: () => ipcRenderer.invoke('sound:getAll'),
  soundPlay: (id) => ipcRenderer.invoke('sound:play', id),
  soundStop: () => ipcRenderer.invoke('sound:stop'),
  soundGetFilePath: (id) => ipcRenderer.invoke('sound:getFilePath', id),
  soundImport: () => ipcRenderer.invoke('sound:import'),
  soundDelete: (id) => ipcRenderer.invoke('sound:delete', id),
  soundRename: (id, name) => ipcRenderer.invoke('sound:rename', id, name),
  soundAssignToGroup: (soundId, groupId) => ipcRenderer.invoke('sound:assignToGroup', soundId, groupId),
  soundSaveRecording: (payload) => ipcRenderer.invoke('sound:saveRecording', payload),
  soundRead: (id) => ipcRenderer.invoke('sound:read', id),
  clipProbe: (id) => ipcRenderer.invoke('clip:probe', id),
  clipRender: (plan) => ipcRenderer.invoke('clip:render', plan),
  openverseSearch: (query, page) => ipcRenderer.invoke('openverse:search', query, page),
  openversePreview: (id) => ipcRenderer.invoke('openverse:preview', id),
  openverseImport: (payload) => ipcRenderer.invoke('openverse:import', payload),

  // Groups
  groupGetAll: () => ipcRenderer.invoke('group:getAll'),
  groupCreate: (name) => ipcRenderer.invoke('group:create', name),
  groupRename: (id, name) => ipcRenderer.invoke('group:rename', id, name),
  groupDelete: (id) => ipcRenderer.invoke('group:delete', id),
  groupToggleCollapsed: (id) => ipcRenderer.invoke('group:toggleCollapsed', id),

  // YouTube
  youtubeExtract: (opts) => ipcRenderer.invoke('youtube:extract', opts),
  youtubeProbeDuration: (url) => ipcRenderer.invoke('youtube:probeDuration', url),

  // Settings
  settingsGet: () => ipcRenderer.invoke('settings:get'),
  settingsSave: (settings) => ipcRenderer.invoke('settings:save', settings),

  // Shell
  openExternal: (url) => ipcRenderer.invoke('shell:openExternal', url),

  // Updates
  updateCheck: () => ipcRenderer.invoke('update:check'),
  updateDownload: () => ipcRenderer.invoke('update:download'),
  updateInstall: () => ipcRenderer.invoke('update:install'),
  
  // Library Backup
  libraryGetInfo: () => ipcRenderer.invoke('library:getInfo'),
  libraryBackup: () => ipcRenderer.invoke('library:backup'),
  libraryRestore: () => ipcRenderer.invoke('library:restore'),
  
  // Remote Server
  remoteStart: (opts) => ipcRenderer.invoke('remote:start', opts),
  remoteStop: () => ipcRenderer.invoke('remote:stop'),
  remoteStatus: () => ipcRenderer.invoke('remote:status'),
  remoteGenerateQR: (url) => ipcRenderer.invoke('remote:generateQR', url),

  // Home Server (optional LAN library sync; playback stays local)
  homeServerGetState: () => ipcRenderer.invoke('homeserver:getState'),
  homeServerSync: () => ipcRenderer.invoke('homeserver:sync'),

  // Events from main
  onStatus: (cb) => {
    ipcRenderer.on('status', (_e, data) => cb(data));
  },
  onYoutubeProgress: (cb) => {
    ipcRenderer.on('youtube:progress', (_e, pct) => cb(pct));
  },
  onUpdateChecking: (cb) => {
    ipcRenderer.on('update:checking', () => cb());
  },
  onUpdateAvailable: (cb) => {
    ipcRenderer.on('update:available', (_e, info) => cb(info));
  },
  onUpdateNotAvailable: (cb) => {
    ipcRenderer.on('update:not-available', (_e, info) => cb(info));
  },
  onUpdateProgress: (cb) => {
    ipcRenderer.on('update:progress', (_e, progress) => cb(progress));
  },
  onUpdateDownloaded: (cb) => {
    ipcRenderer.on('update:downloaded', (_e, info) => cb(info));
  },
  onUpdateError: (cb) => {
    ipcRenderer.on('update:error', (_e, message) => cb(message));
  },
  
  // Global hotkeys
  onGlobalHotkeyKeydown: (cb) => {
    ipcRenderer.on('global-hotkey:keydown', (_e, key) => cb(key));
  },
  onGlobalHotkeyKeyup: (cb) => {
    ipcRenderer.on('global-hotkey:keyup', (_e, key) => cb(key));
  },

  // Phone-loaded clip. V/T play it; hard stops release a simulated key.
  loadedClipGetState: () => ipcRenderer.invoke('loaded-clip:get-state'),
  loadedClipKeyDown: (key) => ipcRenderer.invoke('loaded-clip:key-down', key),
  loadedClipKeyUp: (key) => ipcRenderer.invoke('loaded-clip:key-up', key),
  loadedClipHardStop: () => ipcRenderer.invoke('loaded-clip:hard-stop'),
  loadedClipEnded: () => ipcRenderer.send('loaded-clip:ended'),
  loadedClipPlayFailed: () => ipcRenderer.send('loaded-clip:play-failed'),
  onLoadedClipState: (cb) => {
    ipcRenderer.on('loaded-clip:state', (_e, state) => cb(state));
  },
  onLoadedClipPlay: (cb) => {
    ipcRenderer.on('loaded-clip:play', (_e, data) => cb(data));
  },
  onLoadedClipForceStop: (cb) => {
    ipcRenderer.on('loaded-clip:force-stop', () => cb());
  },
  onHomeServerStatus: (cb) => {
    ipcRenderer.on('homeserver:status', (_e, state) => cb(state));
  },
});
