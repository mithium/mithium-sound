# Mithium Sound v1.7.0 - Feature Overview

## User Workflow

### 1. Installation
```
Download: Mithium Sound-Setup-1.7.0.exe
Install → Start Menu shortcut created
Launch → App checks for updates automatically
```

### 2. VoiceMeeter Setup (First Time)
```
Settings → VoiceMeeter Setup Helper
├─ Status: ⚠ VoiceMeeter Not Detected
├─ Click "Download VoiceMeeter Banana"
├─ Install from official site
└─ Restart app → Status: ✓ VoiceMeeter Detected

Follow Setup Checklist:
1. VoiceMeeter: Hardware Input 1 = Nvidia Broadcast
2. Mithium Sound: Output Mode = Local Device or Both
3. Mithium Sound: Device = VoiceMeeter Input (VAIO)
4. Windows: Default Mic = VoiceMeeter Output
5. Discord/Zoom: Input = VoiceMeeter Output
```

### 3. Audio Routing
```
┌─────────────────┐
│ Nvidia Broadcast│ (Your voice)
└────────┬────────┘
         │
         ▼
┌─────────────────┐      ┌──────────────┐
│ VoiceMeeter     │◄─────┤ Mithium Sound│ (Soundboard)
│ Banana          │      │ Local Output │
│ (Hardware In 1) │      └──────────────┘
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│ VoiceMeeter Out │ (Mixed audio)
└────────┬────────┘
         │
         ▼
   Discord/Zoom/etc.
```

### 4. Playing Sounds
```
Soundboard Tab → Click sound button
├─ Mode: Discord Bot Only
│   └─ Plays through Discord bot voice connection
├─ Mode: Local Device Only
│   └─ Plays through selected Windows device (e.g., VoiceMeeter Input)
└─ Mode: Both
    ├─ Plays through Discord bot
    └─ AND plays through local device simultaneously
```

### 5. Auto-Updates
```
App Launch → Checks GitHub Releases (after 5s)
If update available:
  Settings → Software Updates → "Version X.X.X available"
  ├─ Click "Download Update"
  ├─ Progress bar shows download
  └─ Click "Restart & Install" when complete
      └─ App quits and updates automatically
```

## Key Features by Tab

### Soundboard Tab
- Grid of sound buttons
- Import sounds from files
- Extract clips from YouTube
- Right-click to rename/delete
- Visual "playing" animation
- Volume slider (0-150%)

### YouTube Tab
- Paste YouTube URL
- Drag start/end time sliders
- Auto-detects video duration
- Extract 30-second clips (or full length if detected)
- Names and saves to soundboard

### Settings Tab
**VoiceMeeter Setup Helper**
- Auto-detection of VoiceMeeter devices
- Download button if not installed
- Step-by-step setup checklist

**Audio Output Settings**
- Output Mode: Discord / Local / Both
- Device picker with refresh button
- Persists selection across restarts

**Discord Bot**
- Token login/logout
- Server and channel selection
- Auto-connect option

**Software Updates**
- Check for updates button
- Download progress tracking
- One-click install

**Home Server (optional)**
- Separate from LAN Web Remote
- Enable, LAN base URL, auth token, connection status, Sync now
- Playback, hotkeys, and the clip grid always use the local library
- Unreachable server shows Offline and does not block use
- See `docs/HOME_SERVER.md` for the sync rule and HTTP contract

## Technical Architecture

### Main Process (`src/main/`)
- `index.js`: Electron app, IPC handlers, auto-updater
- `bot.js`: Discord bot connection and voice playback
- `soundboard.js`: Sound library management
- `youtube.js`: yt-dlp integration for extraction
- `settings.js`: JSON settings persistence
- `homeserver.js` and `sync/`: optional Home Server client (offline-first)

### Renderer Process (`src/renderer/`)
- `index.html`: UI structure
- `app.js`: UI logic, device enumeration, local playback
- `styles.css`: Dark theme styling
- `timecode.js`: Time parsing utilities

### Build & Distribution
- `electron-builder.yml`: NSIS + zip packaging
- `package.json`: Dependencies and scripts
- Auto-updater pulls from GitHub Releases

## Settings File Structure
```json
{
  "botToken": "...",
  "lastGuildId": "...",
  "lastChannelId": "...",
  "autoConnect": false,
  "volume": 100,
  "outputMode": "both",
  "selectedDeviceId": "ABC123...",
  "homeServerEnabled": false,
  "homeServerUrl": "http://homelab:8787",
  "homeServerToken": ""
}
```

Stored in: `%APPDATA%/mithium-sound/settings.json`

Home Server URL and token use this same file (with the Discord bot token and the LAN remote PIN). Sync does not send the bot token. Contract and sync rule: `docs/HOME_SERVER.md`.

## Update Workflow
```
Developer:
  1. Update package.json version
  2. npm run build (on Windows)
  3. Create GitHub Release with:
     - Mithium Sound-Setup-X.X.X.exe
     - latest.yml
     - (optional) portable zip
  
Users:
  1. App auto-checks on launch
  2. Downloads update in background
  3. Installs on restart
  4. Settings preserved
```

## Security
- Auto-updater verifies SHA512 checksums
- Updates only from github.com/mithium/mithium-sound
- User must approve download and install
- No automatic silent updates

## Compatibility
- Windows 10/11 (x64)
- Requires: Electron 33, Node.js modules
- Optional: VoiceMeeter Banana (for mixing)
- Works with: Discord, Zoom, OBS, any app using Windows audio devices
