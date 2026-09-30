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
  soundImport: () => ipcRenderer.invoke('sound:import'),
  soundDelete: (id) => ipcRenderer.invoke('sound:delete', id),
  soundRename: (id, name) => ipcRenderer.invoke('sound:rename', id, name),

  // YouTube
  youtubeExtract: (opts) => ipcRenderer.invoke('youtube:extract', opts),
  youtubeProbeDuration: (url) => ipcRenderer.invoke('youtube:probeDuration', url),

  // Settings
  settingsGet: () => ipcRenderer.invoke('settings:get'),
  settingsSave: (settings) => ipcRenderer.invoke('settings:save', settings),

  // Shell
  openExternal: (url) => ipcRenderer.invoke('shell:openExternal', url),

  // Events from main
  onStatus: (cb) => {
    ipcRenderer.on('status', (_e, data) => cb(data));
  },
  onYoutubeProgress: (cb) => {
    ipcRenderer.on('youtube:progress', (_e, pct) => cb(pct));
  },
});
