const { spawn } = require('child_process');

// US keyboard virtual-key codes. The helper maps each VK to the current
// layout's scan code and sends it with KEYEVENTF_SCANCODE, which is what
// games read as a held V or T. A virtual-key-only event is invisible to
// many of them, so releasing the physical key looked like the hold ended.
const KEYEVENTF_KEYUP = 0x0002;
const KEYEVENTF_SCANCODE = 0x0008;

const KEYS = {
  v: { vk: '56', scan: '2F' },
  t: { vk: '54', scan: '14' },
};

const injectionScript = `
$ErrorActionPreference = 'Stop'
Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class MithiumKeys {
  [DllImport("user32.dll")]
  public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, UIntPtr dwExtraInfo);
  [DllImport("user32.dll")]
  public static extern uint MapVirtualKey(uint uCode, uint uMapType);
  public static void Hold(byte vk, byte fallbackScan, uint flags) {
    uint mapped = MapVirtualKey((uint)vk, 0);
    byte scan = mapped != 0 ? (byte)mapped : fallbackScan;
    keybd_event(vk, scan, flags, UIntPtr.Zero);
  }
}
"@
[Console]::Out.WriteLine('ready')
[Console]::Out.Flush()
while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line -or $line -eq 'exit') { break }
  $parts = $line.Split(' ')
  if ($parts.Length -lt 3) { continue }
  try {
    $vk = [Convert]::ToByte($parts[1], 16)
    $scan = [Convert]::ToByte($parts[2], 16)
    $flags = [uint32]${KEYEVENTF_SCANCODE}
    if ($parts[0] -eq 'up') { $flags = [uint32]${KEYEVENTF_SCANCODE | KEYEVENTF_KEYUP} }
    [MithiumKeys]::Hold($vk, $scan, $flags)
    [Console]::Out.WriteLine('ok')
    [Console]::Out.Flush()
  } catch {
    [Console]::Error.WriteLine($_.Exception.Message)
    [Console]::Error.Flush()
  }
}
`;

function createWinKeyHold() {
  let proc = null;
  let ready = null;

  function ensure() {
    if (process.platform !== 'win32') return Promise.resolve(false);
    if (proc && proc.exitCode == null && !proc.killed) return ready;
    const child = spawn(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', injectionScript],
      { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true },
    );
    proc = child;
    let settled = false;
    ready = new Promise((resolve) => {
      const finish = (ok) => {
        if (settled) return;
        settled = true;
        resolve(ok);
      };
      // Keep reading after ready. Otherwise the 'ok' lines fill the pipe
      // and a later hold blocks forever inside the helper.
      child.stdout.on('data', (buf) => {
        if (String(buf).includes('ready')) finish(true);
      });
      child.stderr.on('data', (buf) => {
        const text = String(buf).trim();
        if (text) console.error('Simulated key hold:', text);
      });
      child.on('error', (err) => {
        console.error('Simulated key hold failed to start:', err.message || err);
        finish(false);
      });
      child.on('exit', () => {
        if (proc === child) {
          proc = null;
          ready = null;
        }
        finish(false);
      });
    });
    return ready;
  }

  async function send(dir, name) {
    const key = KEYS[name];
    if (!key) return;
    try {
      const ok = await ensure();
      if (!ok || !proc || !proc.stdin || proc.stdin.destroyed) return;
      proc.stdin.write(`${dir} ${key.vk} ${key.scan}\n`);
    } catch (err) {
      console.error('Simulated key hold failed:', err.message || err);
    }
  }

  return {
    // Spawn the helper before any hook runs. The keyboard hook gives up
    // if the reply is late, and spawning PowerShell from that callback is late.
    warm() {
      return ensure();
    },
    keyDown(name) {
      return send('down', name);
    },
    keyUp(name) {
      return send('up', name);
    },
    async releaseAll() {
      if (!proc) return;
      await send('up', 'v');
      await send('up', 't');
    },
    dispose() {
      if (!proc || !proc.stdin || proc.stdin.destroyed) return;
      try {
        proc.stdin.write('up 56 2F\nup 54 14\nexit\n');
      } catch {
        // Process is already gone.
      }
    },
    // Quit when nothing is held. Do not tap V or T on the way out.
    close() {
      if (!proc || !proc.stdin || proc.stdin.destroyed) return;
      try {
        proc.stdin.write('exit\n');
      } catch {
        // Process is already gone.
      }
    },
  };
}

module.exports = {
  createWinKeyHold,
  KEYS,
  injectionScript,
  KEYEVENTF_KEYUP,
  KEYEVENTF_SCANCODE,
};
