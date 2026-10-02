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
    proc = spawn(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', PS_SCRIPT],
      { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true },
    );
    ready = new Promise((resolve) => {
      const onData = (buf) => {
        if (String(buf).includes('ready')) {
          proc.stdout.off('data', onData);
          resolve(true);
        }
      };
      proc.stdout.on('data', onData);
      proc.on('error', () => resolve(false));
      proc.on('exit', () => {
        proc = null;
        ready = null;
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
  };
}

module.exports = { createWinKeyHold, KEYS };
