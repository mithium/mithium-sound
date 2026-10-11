// Bind a LAN port without ever leaving an 'error' event unhandled.
// A taken port is not fatal: try the following ports, and report the one that worked.

const DEFAULT_ATTEMPTS = 20;

function normalizePort(value) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > 65535) return null;
  return n;
}

function nextPort(port) {
  const n = Number(port) + 1;
  if (!Number.isInteger(n) || n > 65535) return null;
  return n;
}

function fallbackNotice(requestedPort, actualPort, label) {
  if (actualPort == null || actualPort === requestedPort) return '';
  return `Port ${requestedPort} is already in use. ${label} is on port ${actualPort}.`;
}

function unavailableBecauseBusy(requestedPort, label) {
  return `Port ${requestedPort} is already in use, so ${label} is unavailable.`;
}

// An EventEmitter throws if 'error' is emitted and nobody is listening.
// ws re-emits the HTTP server's listen error onto the WebSocket server, which
// is what turned EADDRINUSE into the main-process dialog.
function swallowErrors(emitter) {
  if (!emitter || emitter.__mithiumSwallowErrors) return emitter;
  emitter.__mithiumSwallowErrors = true;
  emitter.on('error', () => {});
  return emitter;
}

function listenOn(server, listenPort, host) {
  const bindHost = host || '0.0.0.0';
  return new Promise((resolve, reject) => {
    let settled = false;
    function finish(err) {
      if (settled) return;
      settled = true;
      server.removeListener('error', onError);
      server.removeListener('listening', onListening);
      if (err) reject(err);
      else resolve();
    }
    function onError(err) {
      finish(err);
    }
    function onListening() {
      finish(null);
    }
    server.on('error', onError);
    server.on('listening', onListening);
    try {
      server.listen(listenPort, bindHost);
    } catch (err) {
      finish(err);
    }
  });
}

async function listenWithFallback(server, preferredPort, options = {}) {
  const attempts = options.attempts || DEFAULT_ATTEMPTS;
  const skip = options.skip || new Set();
  const listen = options.listen || ((srv, port) => listenOn(srv, port, options.host));
  const start = normalizePort(preferredPort);
  if (start == null) {
    const err = new Error('Enter a port from 1 to 65535.');
    err.code = 'EINVAL';
    throw err;
  }

  const tried = [];
  let candidate = start;
  let tries = 0;
  let steps = 0;
  const stepCap = attempts + skip.size + 2;
  while (candidate != null && tries < attempts && steps < stepCap) {
    steps += 1;
    if (skip.has(candidate)) {
      candidate = nextPort(candidate);
      continue;
    }
    tries += 1;
    try {
      await listen(server, candidate);
      return {
        port: candidate,
        requestedPort: start,
        tried,
        fallback: candidate !== start,
      };
    } catch (err) {
      if (!err || (err.code !== 'EADDRINUSE' && err.code !== 'EACCES')) throw err;
      tried.push(candidate);
      candidate = nextPort(candidate);
    }
  }

  const err = new Error(unavailableBecauseBusy(start, 'the port'));
  err.code = 'EADDRINUSE';
  err.tried = tried;
  throw err;
}

module.exports = {
  DEFAULT_ATTEMPTS,
  normalizePort,
  nextPort,
  fallbackNotice,
  unavailableBecauseBusy,
  swallowErrors,
  listenOn,
  listenWithFallback,
};
