// Copy the Windows ffprobe.exe shipped by ffprobe-static next to ffmpeg.exe.
// The packaged app probes files with resources/bin/ffprobe.exe, outside app.asar.
const fs = require('fs');
const path = require('path');

const pkgRoot = path.dirname(require.resolve('ffprobe-static'));
const source = path.join(pkgRoot, 'bin', 'win32', 'x64', 'ffprobe.exe');
if (!fs.existsSync(source)) {
  console.error('Windows ffprobe.exe is missing from ffprobe-static:', source);
  process.exit(1);
}
const binDir = path.join(__dirname, '..', 'bin', 'win');
fs.mkdirSync(binDir, { recursive: true });
const dest = path.join(binDir, 'ffprobe.exe');
fs.copyFileSync(source, dest);
const size = fs.statSync(dest).size;
if (size < 1_000_000) {
  console.error('Copied ffprobe.exe is too small:', size);
  process.exit(1);
}
console.log('Copied ffprobe.exe to:', dest);
