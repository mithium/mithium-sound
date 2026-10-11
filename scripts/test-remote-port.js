#!/usr/bin/env node
// LAN remote port binding. No Electron required.
//   node scripts/test-remote-port.js

const assert = require('assert');
const http = require('http');
const { EventEmitter } = require('events');
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const {
  normalizePort,
  fallbackNotice,
  unavailableBecauseBusy,
  swallowErrors,
  listenOn,
  listenWithFallback,
} = require('../src/main/listenPort');
const { remoteStatusView } = require('../src/shared/remoteStatus');

let passed = 0;

async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`ok  ${name}`);
  } catch (err) {
    console.error(`FAIL ${name}`);
    console.error(err);
    process.exitCode = 1;
  }
}

function busyError() {
  const err = new Error('listen EADDRINUSE');
  err.code = 'EADDRINUSE';
  return err;
}

(async () => {
  await test('normalizePort keeps a configured port and rejects junk', () => {
    assert.strictEqual(normalizePort(3000), 3000);
    assert.strictEqual(normalizePort('8080'), 8080);
    assert.strictEqual(normalizePort(1), 1);
    assert.strictEqual(normalizePort(65535), 65535);
    assert.strictEqual(normalizePort(0), null);
    assert.strictEqual(normalizePort(65536), null);
    assert.strictEqual(normalizePort('nope'), null);
    assert.strictEqual(normalizePort(3000.5), null);
  });

  await test('fallback notice names the requested port and the port that worked', () => {
    assert.strictEqual(fallbackNotice(3000, 3000, 'The remote'), '');
    assert.strictEqual(
      fallbackNotice(3000, 3002, 'The remote'),
      'Port 3000 is already in use. The remote is on port 3002.',
    );
    assert.strictEqual(
      unavailableBecauseBusy(3001, 'the secure remote'),
      'Port 3001 is already in use, so the secure remote is unavailable.',
    );
  });

  await test('settings view shows the actual address and keeps the saved port', () => {
    const status = {
      running: true,
      port: 3002,
      requestedPort: 3000,
      notice: fallbackNotice(3000, 3002, 'The remote'),
      urls: ['http://192.168.1.20:3002'],
      secureUrls: ['https://192.168.1.20:3003'],
    };
    const view = remoteStatusView(status);
    assert.strictEqual(status.requestedPort, 3000);
    assert.strictEqual(view.state, 'running');
    assert.strictEqual(view.label, 'Running on port 3002');
    assert.ok(view.detail.includes('port 3002'));
    assert.deepStrictEqual(view.urls, ['http://192.168.1.20:3002']);
    assert.deepStrictEqual(view.secureUrls, ['https://192.168.1.20:3003']);
  });

  await test('settings view says unavailable with the reason and does not pretend to be stopped', () => {
    const view = remoteStatusView({
      running: false,
      requestedPort: 3000,
      unavailableReason: unavailableBecauseBusy(3000, 'the remote'),
    });
    assert.strictEqual(view.state, 'unavailable');
    assert.strictEqual(view.label, 'Unavailable');
    assert.ok(view.detail.includes('Port 3000 is already in use'));
    assert.deepStrictEqual(view.urls, []);
  });

  await test('a taken port is tried, then the next free port is used', async () => {
    const calls = [];
    const listen = async (_server, port) => {
      calls.push(port);
      if (port === 3000 || port === 3001) throw busyError();
    };
    const result = await listenWithFallback({}, 3000, { listen, attempts: 5 });
    assert.deepStrictEqual(calls, [3000, 3001, 3002]);
    assert.strictEqual(result.port, 3002);
    assert.strictEqual(result.requestedPort, 3000);
    assert.strictEqual(result.fallback, true);
  });

  await test('https can skip the http port and keep going', async () => {
    const listen = async (_server, port) => {
      if (port === 3001) throw busyError();
    };
    const result = await listenWithFallback({}, 3001, {
      listen,
      attempts: 5,
      skip: new Set([3000]),
    });
    assert.strictEqual(result.port, 3002);
    assert.strictEqual(result.requestedPort, 3001);
  });

  await test('giving up after the attempt budget rejects instead of throwing out of band', async () => {
    const crashes = [];
    const onUncaught = (err) => crashes.push(err);
    process.on('uncaughtException', onUncaught);
    const listen = async () => {
      throw busyError();
    };
    await assert.rejects(
      () => listenWithFallback({}, 3000, { listen, attempts: 3 }),
      (err) => err.code === 'EADDRINUSE' && err.tried.length === 3,
    );
    await new Promise((resolve) => setImmediate(resolve));
    process.removeListener('uncaughtException', onUncaught);
    assert.deepStrictEqual(crashes, []);
  });

  await test('a real busy port does not become an uncaught exception when the socket forwards it', async () => {
    const crashes = [];
    const onUncaught = (err) => crashes.push(err);
    const onRejection = (err) => crashes.push(err);
    process.on('uncaughtException', onUncaught);
    process.on('unhandledRejection', onRejection);

    const blocker = http.createServer();
    await listenOn(blocker, 0, '127.0.0.1');
    const taken = blocker.address().port;
    const server = http.createServer();
    swallowErrors(server);
    const forwarded = new EventEmitter();
    server.on('error', (err) => forwarded.emit('error', err));
    swallowErrors(forwarded);

    const result = await listenWithFallback(server, taken, { host: '127.0.0.1', attempts: 5 });
    assert.notStrictEqual(result.port, taken);
    assert.strictEqual(result.fallback, true);
    await new Promise((resolve) => setImmediate(resolve));
    server.close();
    blocker.close();
    process.removeListener('uncaughtException', onUncaught);
    process.removeListener('unhandledRejection', onRejection);
    assert.deepStrictEqual(crashes, []);
  });

  await test('without an error listener the forwarded EADDRINUSE is uncaught', () => {
    const script = `
      const http = require('http');
      const { EventEmitter } = require('events');
      const blocker = http.createServer();
      blocker.listen(0, '127.0.0.1', () => {
        const port = blocker.address().port;
        const server = http.createServer();
        const forwarded = new EventEmitter();
        server.on('error', (err) => forwarded.emit('error', err));
        server.listen(port, '127.0.0.1');
      });
      setTimeout(() => process.exit(0), 1000);
    `;
    const result = spawnSync(process.execPath, ['-e', script], { encoding: 'utf8' });
    assert.notStrictEqual(result.status, 0);
    assert.match(`${result.stderr}`, /EADDRINUSE/);
  });

  await test('installer asks the running app to quit, then deletes the flag', () => {
    const nsh = fs.readFileSync(path.join(__dirname, '..', 'build', 'installer.nsh'), 'utf8');
    assert.match(nsh, /!macro customCheckAppRunning/);
    assert.match(nsh, /!macroend/);
    assert.match(nsh, /quit-for-install/);
    assert.match(nsh, /\$APPDATA\\mithium-sound\\quit-for-install/);
    assert.match(nsh, /\$APPDATA\\Mithium Sound\\quit-for-install/);
    assert.match(nsh, /taskkill \/F \/IM/);
    assert.match(nsh, /Delete "\$APPDATA\\mithium-sound\\quit-for-install"/);
    assert.match(nsh, /Delete "\$APPDATA\\Mithium Sound\\quit-for-install"/);
  });

  if (process.exitCode) {
    console.error('remote port tests failed');
    process.exit(process.exitCode);
  }
  console.log(`${passed} passed`);
})();
