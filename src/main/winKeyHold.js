const { spawn } = require('child_process');

// US keyboard virtual-key and scan codes. keybd_event keeps the key down in
// Windows until a matching key-up, which is what games see as a held V or T.
const KEYS = {
  v: { vk: '56', scan: '2F' },
  t: { vk: '54', scan: '14' },
};

const PS_SCRIPT = `
$ErrorActionPreference = 'Stop'
Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class MithiumKeys {
  [DllImport("user32.dll")]
  public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, UIntPtr dwExtraInfo);
}
"@
[Console]::Out.WriteLine('ready')
[Console]::Out.Flush()
while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line -or $line -eq 'exit') { break }
  $parts = $line.Split(' ')
  if ($parts.Length -lt 3) { continue }
  $vk = [Convert]::ToByte($parts[1], 16)
  $scan = [Convert]::ToByte($parts[2], 16)
  $flags = [uint32]0
  if ($parts[0] -eq 'up') { $flags = [uint32]2 }
  [MithiumKeys]::keybd_event($vk, $scan, $flags, [UIntPtr]::Zero)
  [Console]::Out.WriteLine('ok')
  [Console]::Out.Flush()
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
      ['-NoProfile', '-NonInteractive', '-Command', PS_SCRIPT],
      { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true },
    );
    proc = child;
    ready = new Promise((resolve) => {
      const onData = (buf) => {
        if (String(buf).includes('ready')) {
          child.stdout.off('data', onData);
          resolve(true);
        }
      };
      child.stdout.on('data', onData);
      child.on('error', () => resolve(false));
      child.on('exit', () => {
        if (proc === child) {
          proc = null;
          ready = null;
        }
      });
    });
    return ready;
  }

  function finish(releaseKeys) {
    if (!proc) return;
    const child = proc;
    proc = null;
    ready = null;
    try {
      if (child.stdin && !child.stdin.destroyed) {
        const ups = releaseKeys ? 'up 56 2F\nup 54 14\n' : '';
        child.stdin.write(`${ups}exit\n`);
      }
    } catch {
      // Process is already gone.
    }
    if (!releaseKeys) {
      try { child.kill(); } catch { /* already gone */ }
      return;
    }
    const timer = setTimeout(() => {
      try { child.kill(); } catch { /* already gone */ }
    }, 500);
    if (typeof timer.unref === 'function') timer.unref();
    child.once('exit', () => clearTimeout(timer));
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
    // Drop the helper. releaseKeys sends V/T up first, for a simulated hold.
    // A normal quit only exits the process, so a physical V or T is left alone.
    dispose() {
      finish(true);
    },
    close() {
      finish(false);
    },
  };
}

module.exports = { createWinKeyHold, KEYS };
