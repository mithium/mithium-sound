// Generate PNG icons from SVG using sharp
// sharp is available globally via netlify-cli
const path = require('path');
const fs = require('fs');

// Resolve sharp from global install
const globalModules = path.join(process.env.HOME, '.nvm/versions/node/v24.12.0/lib/node_modules');
let sharp;
try {
  sharp = require(path.join(globalModules, 'netlify-cli/node_modules/sharp'));
} catch {
  // Try to find sharp in global modules
  const sharpPath = require('child_process')
    .execSync('find ~/.nvm -name "sharp" -path "*/node_modules/sharp/lib/index.js" 2>/dev/null | head -1')
    .toString().trim();
  if (sharpPath) {
    sharp = require(path.dirname(path.dirname(sharpPath)));
  } else {
    console.error('sharp not found, cannot generate icons');
    process.exit(1);
  }
}

const buildDir = path.join(__dirname, '..', 'build');
const svgPath = path.join(buildDir, 'icon.svg');
const svg = fs.readFileSync(svgPath);

async function main() {
  // Generate 256x256 PNG (electron-builder default)
  await sharp(svg).resize(256, 256).png().toFile(path.join(buildDir, 'icon.png'));
  console.log('Generated icon.png (256x256)');

  // Generate multiple sizes for ICO
  const sizes = [16, 32, 48, 64, 128, 256];
  const pngs = [];
  for (const size of sizes) {
    const buf = await sharp(svg).resize(size, size).png().toBuffer();
    pngs.push({ size, buf });
    console.log(`Generated ${size}x${size} buffer`);
  }

  // Build ICO file manually
  // ICO format: header + directory entries + image data
  const numImages = pngs.length;
  const headerSize = 6;
  const dirEntrySize = 16;
  const dirSize = dirEntrySize * numImages;
  let offset = headerSize + dirSize;

  const entries = [];
  for (const { size, buf } of pngs) {
    entries.push({ size, buf, offset });
    offset += buf.length;
  }

  const ico = Buffer.alloc(offset);
  // Header: reserved(2) + type(2) + count(2)
  ico.writeUInt16LE(0, 0);     // reserved
  ico.writeUInt16LE(1, 2);     // type: 1 = ICO
  ico.writeUInt16LE(numImages, 4);

  let pos = headerSize;
  for (const entry of entries) {
    ico.writeUInt8(entry.size >= 256 ? 0 : entry.size, pos);      // width (0 = 256)
    ico.writeUInt8(entry.size >= 256 ? 0 : entry.size, pos + 1);  // height
    ico.writeUInt8(0, pos + 2);      // color palette
    ico.writeUInt8(0, pos + 3);      // reserved
    ico.writeUInt16LE(1, pos + 4);   // color planes
    ico.writeUInt16LE(32, pos + 6);  // bits per pixel
    ico.writeUInt32LE(entry.buf.length, pos + 8);  // size of image data
    ico.writeUInt32LE(entry.offset, pos + 12);     // offset of image data
    pos += dirEntrySize;
  }

  for (const entry of entries) {
    entry.buf.copy(ico, entry.offset);
  }

  fs.writeFileSync(path.join(buildDir, 'icon.ico'), ico);
  console.log('Generated icon.ico');
}

main().catch(err => { console.error(err); process.exit(1); });
