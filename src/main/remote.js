const express = require('express');
const { WebSocketServer } = require('ws');
const http = require('http');
const path = require('path');
const os = require('os');
const QRCode = require('qrcode');
const soundboard = require('./soundboard');
const settings = require('./settings');

let httpServer = null;
let expressApp = null;
let wss = null;
let isRunning = false;
let port = 3000;
let authToken = null;

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
  if (!wss) return;
  
  const message = JSON.stringify({ type, data });
  wss.clients.forEach((client) => {
    if (client.readyState === 1) { // WebSocket.OPEN
      client.send(message);
    }
  });
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

function startServer(opts = {}) {
  if (isRunning) {
    throw new Error('Remote server is already running');
  }
  
  port = opts.port || 3000;
  authToken = opts.authToken || null;
  
  expressApp = express();
  expressApp.use(express.json());
  
  // Serve static files for the web UI
  const remotePath = path.join(__dirname, '..', 'remote');
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
  expressApp.post('/api/stop', authMiddleware, (req, res) => {
    try {
      const bot = require('./bot');
      bot.stopSound();
      
      broadcastUpdate('stopped', {});
      
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
      });
    } catch (err) {
      console.error('API error (status):', err);
      res.status(500).json({ error: err.message });
    }
  });
  
  // Create HTTP server
  httpServer = http.createServer(expressApp);
  
  // WebSocket server for live updates
  wss = new WebSocketServer({ server: httpServer, path: '/ws' });
  
  wss.on('connection', (ws, req) => {
    console.log('WebSocket client connected from', req.socket.remoteAddress);
    
    // Send initial library state
    try {
      const sounds = soundboard.getAllSounds();
      const groups = soundboard.getAllGroups();
      const volume = settings.get('volume') || 100;
      ws.send(JSON.stringify({ 
        type: 'init', 
        data: { sounds, groups, volume }
      }));
    } catch (err) {
      console.error('WebSocket init error:', err);
    }
    
    ws.on('error', (err) => {
      console.error('WebSocket error:', err);
    });
    
    ws.on('close', () => {
      console.log('WebSocket client disconnected');
    });
  });
  
  // Start listening
  httpServer.listen(port, '0.0.0.0', () => {
    isRunning = true;
    console.log(`Remote server started on port ${port}`);
    console.log('Access URLs:', getAccessURLs());
  });
}

function stopServer() {
  if (!isRunning) {
    return;
  }
  
  if (wss) {
    wss.clients.forEach((client) => client.close());
    wss.close();
    wss = null;
  }
  
  if (httpServer) {
    httpServer.close();
    httpServer = null;
  }
  
  expressApp = null;
  isRunning = false;
  console.log('Remote server stopped');
}

function getStatus() {
  return {
    running: isRunning,
    port,
    urls: isRunning ? getAccessURLs() : [],
    hasAuth: !!authToken,
  };
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
