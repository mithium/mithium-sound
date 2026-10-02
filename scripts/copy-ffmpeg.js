// Extracts ffmpeg.exe from ffmpeg-static to build/ffmpeg/ for packaging
const fs = require('fs');
const path = require('path');

const destDir = path.join(__dirname, '..', 'build', 'ffmpeg');
fs.mkdirSync(destDir, { recursive: true });

try {
  const ffmpegStatic = require('ffmpeg-static');
  const destPath = path.join(destDir, 'ffmpeg.exe');
  fs.copyFileSync(ffmpegStatic, destPath);
  console.log('copy-ffmpeg: copied', ffmpegStatic, 'to', destPath);
} catch (err) {
  console.error('copy-ffmpeg: failed to copy ffmpeg.exe:', err.message);
  process.exit(1);
}
