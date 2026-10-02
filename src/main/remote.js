const express = require('express');
const { WebSocketServer } = require('ws');
const http = require('http');
const https = require('https');
const path = require('path');
const os = require('os');
const QRCode = require('qrcode');
const soundboard = require('./soundboard');
const settings = require('./settings');
const loadedClip = require('./loadedClip');
const studio = require('./studioRoutes');
const remoteCert = require('./remoteCert');

let httpServer = null;
let httpsServer = null;
let expressApp = null;
const socketServers = [];
const sockets = new Set();
let isRunning = false;
let port = 3000;
let securePort = null;
let authToken = null;
let onLibraryChange = null;

// Get all LAN IP addresses
function getLanIPs() {
  const interfaces = os.networkInterfaces();
  const ips = [];
  
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      // Skip internal/loopback and non-IPv4
      if (iface.family === 'IPv4' && !iface.internal) {
        ips.push(iface.address);
      }
    }
  }
  
  return ips;
}

// Broadcast update to all connected WebSocket clients
function broadcastUpdate(type, data) {
  const message = JSON.stringify({ type, data });
  sockets.forEach((client) => {
    if (client.readyState === 1) {
      client.send(message);
    }
  });
}

function changedLibrary() {
  if (typeof onLibraryChange === 'function') onLibraryChange();
  else notifyLibraryUpdate();
}

// Simple auth middleware (optional PIN protection)
function authMiddleware(req, res, next) {
  if (!authToken) {
    return next();
  }
  
  const providedToken = req.headers['x-auth-token'] || req.query.token;
  if (providedToken === authToken) {
    return next();
  }
  
  res.status(401).json({ error: 'Unauthorized' });
}

function sendApiError(res, err) {
  const status = err && err.status ? err.status : 500;
  res.status(status).json({ error: err.message || 'Request failed', offline: !!(err && err.offline) });
}

async function startServer(opts = {}) {
  if (isRunning) {
    throw new Error('Remote server is already running');
  }
  
  port = opts.port || 3000;
  authToken = opts.authToken || null;
  onLibraryChange = opts.onLibraryChange || null;
  securePort = null;
  
  expressApp = express();
  expressApp.use(express.json({ limit: '1mb' }));
  
  // Serve static files for the web UI
  const remotePath = path.join(__dirname, '..', 'remote');
  expressApp.use('/shared', express.static(path.join(__dirname, '..', 'shared')));
  expressApp.use(express.static(remotePath));
  
  // API: Get library (groups + sounds)
  expressApp.get('/api/library', authMiddleware, (req, res) => {
    try {
      const sounds = soundboard.getAllSounds();
      const groups = soundboard.getAllGroups();
      res.json({ sounds, groups });
    } catch (err) {
      console.error('API error (library):', err);
      res.status(500).json({ error: err.message });
    }
  });
  
  // API: Play sound
  expressApp.post('/api/play/:id', authMiddleware, async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      const sounds = soundboard.getAllSounds();
      const sound = sounds.find((s) => s.id === id);
      
      if (!sound) {
        return res.status(404).json({ error: 'Sound not found' });
      }
      
      const filePath = soundboard.getFilePath(sound.filename);
      const vol = (settings.get('volume') || 100) / 100;
      const outputMode = settings.get('outputMode') || 'discord';
      
      // Play through the bot module (imported in index.js will handle this)
      // We'll emit an event that the main process can handle
      const bot = require('./bot');
      
      if (outputMode === 'discord' || outputMode === 'both') {
        bot.playSound(filePath, vol);
      }
      
      // Broadcast to all clients that this sound is now playing
      broadcastUpdate('playing', { id });
      
      res.json({ success: true, id, name: sound.name });
    } catch (err) {
      console.error('API error (play):', err);
      res.status(500).json({ error: err.message });
    }
  });
  
  // API: Stop playback
  expressApp.post('/api/stop', authMiddleware, async (req, res) => {
    try {
      const service = loadedClip.getService();
      if (service) {
        await service.hardStop({ notifyRenderer: true });
      } else {
        const bot = require('./bot');
        bot.stopSound();
        broadcastUpdate('stopped', {});
      }
      
      res.json({ success: true });
    } catch (err) {
      console.error('API error (stop):', err);
      res.status(500).json({ error: err.message });
    }
  });
  
  // API: Set volume
  expressApp.post('/api/volume', authMiddleware, (req, res) => {
    try {
      const { volume } = req.body;
      if (typeof volume !== 'number' || volume < 0 || volume > 150) {
        return res.status(400).json({ error: 'Invalid volume (must be 0-150)' });
      }
      
      settings.set('volume', volume);
      
      broadcastUpdate('volume', { volume });
      
      res.json({ success: true, volume });
    } catch (err) {
      console.error('API error (volume):', err);
      res.status(500).json({ error: err.message });
    }
  });
  
  // API: Get current status
  expressApp.get('/api/status', authMiddleware, (req, res) => {
    try {
      const volume = settings.get('volume') || 100;
      res.json({
        volume,
        serverVersion: require('../../package.json').version,
        secureUrls: securePort ? getSecureURLs() : [],
        ...loadedClip.getPublicState(),
      });
    } catch (err) {
      console.error('API error (status):', err);
      res.status(500).json({ error: err.message });
    }
  });

  // API: Set or clear the phone loaded clip (null clears it)
  expressApp.post('/api/loaded-clip', authMiddleware, async (req, res) => {
    try {
      const service = loadedClip.getService();
      if (!service) {
        return res.status(503).json({ error: 'Loaded clip is not ready' });
      }
      const id = req.body && Object.prototype.hasOwnProperty.call(req.body, 'id')
        ? req.body.id
        : undefined;
      if (id === undefined) {
        return res.status(400).json({ error: 'Expected { id } (number or null)' });
      }
      const state = await service.setLoaded(id);
      res.json({ success: true, ...state });
    } catch (err) {
      console.error('API error (loaded-clip):', err);
      res.status(err.status || 500).json({ error: err.message });
    }
  });

  // API: Phone toggle for simulating V/T held until the clip ends. Defaults on.
  expressApp.post('/api/auto-hold', authMiddleware, async (req, res) => {
    try {
      const service = loadedClip.getService();
      if (!service) {
        return res.status(503).json({ error: 'Loaded clip is not ready' });
      }
      const enabled = req.body ? req.body.enabled : undefined;
      if (typeof enabled !== 'boolean') {
        return res.status(400).json({ error: 'Expected { enabled: boolean }' });
      }
      const state = await service.setAutoHold(enabled);
      res.json({ success: true, ...state });
    } catch (err) {
      console.error('API error (auto-hold):', err);
      res.status(err.status || 500).json({ error: err.message });
    }
  });

  expressApp.post('/api/recordings', authMiddleware, express.raw({ type: () => true, limit: '40mb' }), async (req, res) => {
    try {
      const sound = await studio.saveRecording({
        name: req.query.name,
        groupId: req.query.groupId,
        mime: req.headers['content-type'],
        bytes: req.body,
        durationMs: req.query.durationMs,
      });
      changedLibrary();
      res.status(201).json({ success: true, sound });
    } catch (err) {
      console.error('API error (recording):', err);
      sendApiError(res, err);
    }
  });

  expressApp.get('/api/sounds/:id/audio', authMiddleware, (req, res) => {
    try {
      const audio = studio.readClip(req.params.id);
      res.setHeader('Content-Type', audio.mime);
      res.setHeader('Content-Length', audio.bytes.length);
      res.send(audio.bytes);
    } catch (err) {
      sendApiError(res, err);
    }
  });

  expressApp.get('/api/sounds/:id/probe', authMiddleware, async (req, res) => {
    try {
      res.json(await studio.probeClip(req.params.id));
    } catch (err) {
      sendApiError(res, err);
    }
  });

  expressApp.post('/api/edits', authMiddleware, async (req, res) => {
    try {
      const body = req.body || {};
      const sound = await studio.renderEdit({
        name: body.name,
        groupId: body.groupId,
        baseId: body.baseId,
        inserts: body.inserts,
      });
      changedLibrary();
      res.status(201).json({ success: true, sound });
    } catch (err) {
      console.error('API error (edit):', err);
      sendApiError(res, err);
    }
  });

  expressApp.get('/api/openverse/search', authMiddleware, async (req, res) => {
    try {
      res.json(await studio.searchOpenverse(req.query.q, req.query.page));
    } catch (err) {
      sendApiError(res, err);
    }
  });

  expressApp.get('/api/openverse/preview/:id', authMiddleware, async (req, res) => {
    try {
      const preview = await studio.previewOpenverse(req.params.id);
      res.setHeader('Content-Type', preview.mime || 'audio/mpeg');
      res.send(preview.bytes);
    } catch (err) {
      sendApiError(res, err);
    }
  });

  expressApp.post('/api/openverse/import', authMiddleware, async (req, res) => {
    try {
      const body = req.body || {};
      const sound = await studio.importOpenverse({
        id: body.id,
        name: body.name,
        groupId: body.groupId,
      });
      changedLibrary();
      res.status(201).json({ success: true, sound });
    } catch (err) {
      console.error('API error (openverse import):', err);
      sendApiError(res, err);
    }
  });

  expressApp.use((err, _req, res, next) => {
    if (err && err.type === 'entity.too.large') {
      return res.status(413).json({ error: 'Recording is too large' });
    }
    return next(err);
  });
  
  // Create HTTP server
  httpServer = http.createServer(expressApp);
  attachSockets(httpServer);
  await listenOn(httpServer, port);
  isRunning = true;
  console.log(`Remote server started on port ${port}`);
  console.log('Access URLs:', getAccessURLs());
  await startSecureServer();
}

function listenOn(server, listenPort) {
  return new Promise((resolve, reject) => {
    const onError = (err) => {
      server.off('error', onError);
      reject(err);
    };
    server.once('error', onError);
    server.listen(listenPort, '0.0.0.0', () => {
      server.off('error', onError);
      resolve();
    });
  });
}

function attachSockets(server) {
  const wss = new WebSocketServer({ server, path: '/ws' });
  socketServers.push(wss);
  wss.on('connection', (ws, req) => {
    sockets.add(ws);
    console.log('WebSocket client connected from', req.socket.remoteAddress);
    try {
      const sounds = soundboard.getAllSounds();
      const groups = soundboard.getAllGroups();
      const volume = settings.get('volume') || 100;
      const clip = loadedClip.getPublicState();
      ws.send(JSON.stringify({
        type: 'init',
        data: { sounds, groups, volume, secureUrls: securePort ? getSecureURLs() : [], ...clip },
      }));
    } catch (err) {
      console.error('WebSocket init error:', err);
    }
    ws.on('error', (err) => {
      console.error('WebSocket error:', err);
    });
    ws.on('close', () => {
      sockets.delete(ws);
      console.log('WebSocket client disconnected');
    });
  });
}

async function startSecureServer() {
  const nextPort = Number(port) + 1;
  if (!Number.isInteger(nextPort) || nextPort > 65535) return;
  let credentials;
  try {
    const { app } = require('electron');
    const dir = path.join(app.getPath('userData'), 'remote-tls');
    credentials = remoteCert.loadOrCreate(dir, getLanIPs());
  } catch (err) {
    console.error('Remote HTTPS certificate failed:', err.message);
    return;
  }
  const server = https.createServer(credentials, expressApp);
  attachSockets(server);
  try {
    await listenOn(server, nextPort);
  } catch (err) {
    console.error('Remote HTTPS server failed:', err.message);
    try { server.close(); } catch { /* not listening */ }
    return;
  }
  httpsServer = server;
  securePort = nextPort;
  console.log('Remote HTTPS (phone microphone) on port', nextPort);
}

function stopServer() {
  if (!isRunning && !httpServer) {
    return;
  }
  
  sockets.forEach((client) => {
    try { client.close(); } catch { /* already closed */ }
  });
  sockets.clear();
  socketServers.forEach((wss) => {
    try { wss.close(); } catch { /* already closed */ }
  });
  socketServers.length = 0;
  
  if (httpServer) {
    httpServer.close();
    httpServer = null;
  }
  if (httpsServer) {
    httpsServer.close();
    httpsServer = null;
  }
  
  expressApp = null;
  isRunning = false;
  securePort = null;
  console.log('Remote server stopped');
}

function getStatus() {
  return {
    running: isRunning,
    port,
    securePort,
    urls: isRunning ? getAccessURLs() : [],
    secureUrls: isRunning && securePort ? getSecureURLs() : [],
    hasAuth: !!authToken,
  };
}

function getSecureURLs() {
  if (!securePort) return [];
  return getLanIPs().map((ip) => `https://${ip}:${securePort}`);
}

function getAccessURLs() {
  if (!isRunning) return [];
  
  const ips = getLanIPs();
  return ips.map(ip => `http://${ip}:${port}`);
}

async function generateQRCode(url) {
  try {
    return await QRCode.toDataURL(url, {
      width: 300,
      margin: 2,
      color: {
        dark: '#cdd6f4',
        light: '#1e1e2e',
      },
    });
  } catch (err) {
    console.error('QR code generation error:', err);
    return null;
  }
}

// Notify all connected clients when library changes
function notifyLibraryUpdate() {
  if (!isRunning) return;
  
  try {
    const sounds = soundboard.getAllSounds();
    const groups = soundboard.getAllGroups();
    broadcastUpdate('library', { sounds, groups });
  } catch (err) {
    console.error('Error notifying library update:', err);
  }
}

module.exports = {
  startServer,
  stopServer,
  getStatus,
  getAccessURLs,
  generateQRCode,
  notifyLibraryUpdate,
  broadcastUpdate,
};
