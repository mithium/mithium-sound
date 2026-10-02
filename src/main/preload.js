const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  // Bot
  botLogin: (token) => ipcRenderer.invoke('bot:login', token),
  botLogout: () => ipcRenderer.invoke('bot:logout'),
  botGetGuilds: () => ipcRenderer.invoke('bot:getGuilds'),
  botGetVoiceChannels: (guildId) => ipcRenderer.invoke('bot:getVoiceChannels', guildId),
  botJoinChannel: (channelId) => ipcRenderer.invoke('bot:joinChannel', channelId),
  botLeaveChannel: () => ipcRenderer.invoke('bot:leaveChannel'),

  // Sounds
  soundGetAll: () => ipcRenderer.invoke('sound:getAll'),
  soundPlay: (id) => ipcRenderer.invoke('sound:play', id),
  soundStop: () => ipcRenderer.invoke('sound:stop'),
  soundGetFilePath: (id) => ipcRenderer.invoke('sound:getFilePath', id),
  soundImport: () => ipcRenderer.invoke('sound:import'),
  soundDelete: (id) => ipcRenderer.invoke('sound:delete', id),
  soundRename: (id, name) => ipcRenderer.invoke('sound:rename', id, name),
  soundAssignToGroup: (soundId, groupId) => ipcRenderer.invoke('sound:assignToGroup', soundId, groupId),

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
});
