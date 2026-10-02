// Extract ffmpeg.exe from ffmpeg-static for bundling
const fs = require('fs');
const path = require('path');

try {
  const ffmpegPath = require('ffmpeg-static');
  console.log('Found ffmpeg-static at:', ffmpegPath);
  
  const binDir = path.join(__dirname, '..', 'bin', 'win');
  fs.mkdirSync(binDir, { recursive: true });
  
  const destPath = path.join(binDir, 'ffmpeg.exe');
  fs.copyFileSync(ffmpegPath, destPath);
  console.log('Copied ffmpeg.exe to:', destPath);
} catch (err) {
  console.error('Failed to extract ffmpeg:', err.message);
  process.exit(1);
}
