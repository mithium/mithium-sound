const { spawn } = require('child_process');
const path = require('path');
const { classifyGlobalEvent } = require('./loadedClipControl');

// Windows global hotkeys without a keyboard-hook executable.
//
// Electron's globalShortcut API (RegisterHotKey) is first-party, but it only
// reports keydown, it swallows V and T so a game never sees them, and it often
// does not fire while a game is exclusive fullscreen. Loaded-clip auto-hold
// needs the keydown and the keyup, and the game has to receive the real key.
//
// On Windows this module asks the Microsoft-signed powershell.exe to poll
// user32 GetAsyncKeyState for V, T, Delete, and the modifier keys. That is not
// a low-level keyboard hook, it does not consume the key, and it keeps working
// while this app is unfocused. No helper executable is shipped.
//
// Manual check on a Windows PC (automated tests cannot press keys):
// 1. Install the build and confirm resources/ has no WinKey helper executable
//    and no node-global-key-listener directory.
// 2. With the window unfocused or hidden to the tray, press V or T. A loaded
//    clip plays through, and auto-hold keeps that key down after release.
//    Delete stops playback and releases the held key.
// 3. With nothing loaded, arm a clip. Hold-to-play plays while V or T is held
//    and stops on release. With hold-to-play off, one press plays once.
// 4. Focus a fullscreen game and repeat V, T, and Delete.
// 5. Tray menu → Quit while V or T is held. The simulated key releases, and
//    Task Manager has no leftover powershell.exe started by Mithium Sound.

const POLL_MS = 10;

const WATCHED = [
  { name: 'V', vk: 0x56 },
  { name: 'T', vk: 0x54 },
  { name: 'DELETE', vk: 0x2E },
  { name: 'LEFT SHIFT', vk: 0xA0 },
  { name: 'RIGHT SHIFT', vk: 0xA1 },
  { name: 'LEFT CTRL', vk: 0xA2 },
  { name: 'RIGHT CTRL', vk: 0xA3 },
  { name: 'LEFT ALT', vk: 0xA4 },
  { name: 'RIGHT ALT', vk: 0xA5 },
];

const MODIFIERS = [
  'LEFT ALT',
  'RIGHT ALT',
  'LEFT CTRL',
  'RIGHT CTRL',
  'LEFT SHIFT',
  'RIGHT SHIFT',
];

function powershellExe(env = process.env) {
  if (env.SystemRoot) {
    return path.win32.join(env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  }
  return 'powershell.exe';
}

function buildPollScript() {
  const vks = WATCHED.map((key) => '0x' + key.vk.toString(16).toUpperCase()).join(',');
  return `
$ErrorActionPreference = 'Stop'
$utf8 = New-Object System.Text.UTF8Encoding $false
[Console]::OutputEncoding = $utf8
$OutputEncoding = $utf8
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class MithiumPoll {
  [DllImport("user32.dll")]
  public static extern short GetAsyncKeyState(int vKey);
}
'@
[Console]::Out.WriteLine('ready')
[Console]::Out.Flush()
$vks = @(${vks})
$prev = -1
while ($true) {
  $mask = 0
  for ($i = 0; $i -lt $vks.Count; $i++) {
    if ([MithiumPoll]::GetAsyncKeyState([int]$vks[$i]) -lt 0) {
      $mask = $mask -bor (1 -shl $i)
    }
  }
  if ($mask -ne $prev) {
    [Console]::Out.WriteLine($mask)
    [Console]::Out.Flush()
    $prev = $mask
  }
  Start-Sleep -Milliseconds ${POLL_MS}
}
`;
}

function encodeCommand(script) {
  return Buffer.from(script, 'utf16le').toString('base64');
}

function decodeCommand(encoded) {
  return Buffer.from(encoded, 'base64').toString('utf16le');
}

function pollerLaunch(env = process.env) {
  const script = buildPollScript();
  return {
    command: powershellExe(env),
    args: [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy', 'Bypass',
      '-EncodedCommand',
      encodeCommand(script),
    ],
    script,
  };
}

function defaultSpawn() {
  const launch = pollerLaunch();
  return spawn(launch.command, launch.args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
}

function downMap(mask) {
  const down = {};
  WATCHED.forEach((key, index) => {
    if (mask & (1 << index)) down[key.name] = true;
  });
  return down;
}

function edgesFromMasks(previous, next) {
  const down = downMap(next);
  const events = [];
  WATCHED.forEach((key, index) => {
    const bit = 1 << index;
    const wasDown = (previous & bit) !== 0;
    const isDown = (next & bit) !== 0;
    if (wasDown === isDown) return;
    events.push({
      event: { name: key.name, state: isDown ? 'DOWN' : 'UP' },
      down,
    });
  });
  return events;
}

function isChordModified(down) {
  if (!down) return false;
  return MODIFIERS.some((name) => down[name]);
}

function decideGlobalHotkey(event, down, context) {
  const ctx = context || {};
  if (ctx.focused) return null;
  if (isChordModified(down)) return null;
  const classified = classifyGlobalEvent(event);
  if (!classified || classified.kind !== 'key') return null;
  // keybd_event re-hold shows up as another V/T down. Playback is already
  // running for that key, so this edge is not a new press.
  if (classified.down && ctx.playbackActive && ctx.simulating === classified.key) return null;
  return classified;
}

function globalHotkeyAction(classified) {
  if (!classified) return null;
  if (classified.down && classified.key === 'Delete') return { type: 'hard-stop' };
  if (classified.down) return { type: 'keydown', key: classified.key };
  if (classified.key !== 'Delete') return { type: 'keyup', key: classified.key };
  return null;
}

function planQuit({ quitReleaseStarted, simulating }) {
  if (quitReleaseStarted) return { delayForRelease: false };
  if (simulating) return { delayForRelease: true };
  return { delayForRelease: false };
}

function createGlobalKeyListener(options = {}) {
  const listeners = new Set();
  const log = options.log || ((message) => console.log(message));
  const logError = options.logError || ((message) => console.error(message));
  let stopped = false;
  let proc = null;
  let buffer = '';
  let previousMask = null;
  let announced = false;

  function emit(event, down) {
    for (const listener of listeners) {
      try {
        listener(event, down);
      } catch (err) {
        logError(`Global hotkey listener failed: ${err && err.message ? err.message : err}`);
      }
    }
  }

  function handleLine(line) {
    const trimmed = String(line).trim();
    if (!trimmed) return;
    if (trimmed === 'ready') {
      if (!announced) {
        announced = true;
        log('Global hotkeys armed for V, T, and Delete');
      }
      return;
    }
    const mask = Number(trimmed);
    if (!Number.isInteger(mask) || mask < 0) return;
    if (previousMask == null) {
      previousMask = mask;
      return;
    }
    const events = edgesFromMasks(previousMask, mask);
    previousMask = mask;
    for (const item of events) emit(item.event, item.down);
  }

  function pushChunk(chunk) {
    if (stopped) return;
    buffer += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
    buffer = buffer.replace(/\r/g, '');
    let newline = buffer.indexOf('\n');
    while (newline !== -1) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      handleLine(line);
      newline = buffer.indexOf('\n');
    }
  }

  function start() {
    if (stopped || proc) return;
    const platform = options.platform || process.platform;
    if (platform !== 'win32') return;
    let child;
    try {
      child = (options.spawn || defaultSpawn)();
    } catch (err) {
      logError(`Failed to start global hotkeys: ${err && err.message ? err.message : err}`);
      return;
    }
    if (!child || !child.stdout || typeof child.stdout.on !== 'function') {
      logError('Failed to start global hotkeys: poller did not start');
      return;
    }
    proc = child;
    child.stdout.on('data', pushChunk);
    if (child.stderr && typeof child.stderr.on === 'function') {
      child.stderr.on('data', (chunk) => {
        const text = String(chunk).trim();
        if (text) logError(`Global hotkey poller: ${text}`);
      });
    }
    child.on('error', (err) => {
      logError(`Global hotkey poller failed: ${err && err.message ? err.message : err}`);
    });
    child.on('exit', (code) => {
      if (proc === child) proc = null;
      if (stopped) return;
      logError(`Global hotkey poller exited: ${code}`);
    });
  }

  start();

  return {
    addListener(fn) {
      listeners.add(fn);
    },
    kill() {
      stopped = true;
      listeners.clear();
      const child = proc;
      proc = null;
      if (!child || typeof child.kill !== 'function') return;
      try {
        child.kill();
      } catch (err) {
        logError(`Failed to stop global hotkeys: ${err && err.message ? err.message : err}`);
      }
    },
  };
}

module.exports = {
  POLL_MS,
  WATCHED,
  buildPollScript,
  encodeCommand,
  decodeCommand,
  pollerLaunch,
  powershellExe,
  edgesFromMasks,
  decideGlobalHotkey,
  globalHotkeyAction,
  planQuit,
  createGlobalKeyListener,
};
