// Regenerate icon.ico and the remote PWA icons from build/icon.png.
// The 1024px PNG is the canonical Mithium Sound mark. icon.svg is unused
// legacy artwork and must not overwrite the app icon.
const path = require('path');
const fs = require('fs');

const globalModules = path.join(process.env.HOME, '.nvm/versions/node/v24.12.0/lib/node_modules');
let sharp;
try {
  sharp = require(path.join(globalModules, 'netlify-cli/node_modules/sharp'));
} catch {
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

const root = path.join(__dirname, '..');
const buildDir = path.join(root, 'build');
const remoteDir = path.join(root, 'src', 'remote');
const masterPath = path.join(buildDir, 'icon.png');
const master = fs.readFileSync(masterPath);

async function pngAt(size) {
  return sharp(master).resize(size, size).png().toBuffer();
}

async function main() {
  const sizes = [16, 32, 48, 64, 128, 256];
  const pngs = [];
  for (const size of sizes) {
    const buf = await pngAt(size);
    pngs.push({ size, buf });
    console.log(`Generated ${size}x${size} buffer`);
  }

  const numImages = pngs.length;
  const headerSize = 6;
  const dirEntrySize = 16;
  let offset = headerSize + dirEntrySize * numImages;

  const entries = [];
  for (const { size, buf } of pngs) {
    entries.push({ size, buf, offset });
    offset += buf.length;
  }

  const ico = Buffer.alloc(offset);
  ico.writeUInt16LE(0, 0);
  ico.writeUInt16LE(1, 2);
  ico.writeUInt16LE(numImages, 4);

  let pos = headerSize;
  for (const entry of entries) {
    ico.writeUInt8(entry.size >= 256 ? 0 : entry.size, pos);
    ico.writeUInt8(entry.size >= 256 ? 0 : entry.size, pos + 1);
    ico.writeUInt8(0, pos + 2);
    ico.writeUInt8(0, pos + 3);
    ico.writeUInt16LE(1, pos + 4);
    ico.writeUInt16LE(32, pos + 6);
    ico.writeUInt32LE(entry.buf.length, pos + 8);
    ico.writeUInt32LE(entry.offset, pos + 12);
    pos += dirEntrySize;
  }

  for (const entry of entries) {
    entry.buf.copy(ico, entry.offset);
  }

  fs.writeFileSync(path.join(buildDir, 'icon.ico'), ico);
  console.log('Generated icon.ico');

  for (const size of [192, 512]) {
    const buf = await pngAt(size);
    const out = path.join(remoteDir, `icon-${size}.png`);
    fs.writeFileSync(out, buf);
    console.log(`Generated ${path.relative(root, out)}`);
  }
}

main().catch(err => { console.error(err); process.exit(1); });
