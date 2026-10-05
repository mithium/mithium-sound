// Confirm a Windows electron-builder output contains yt-dlp at the path
// the packaged app resolves: <resources>/bin/yt-dlp.exe, outside app.asar.
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const release = require('./ytdlp-release');
const { resolveYtdlpPath, PACKAGED_RELATIVE } = require('../src/main/ytdlpBin');

const root = path.join(__dirname, '..');
const requireZip = process.argv.includes('--require-zip');

function fail(message) {
  console.error(`FAIL ${message}`);
  process.exit(1);
}

function readText(filePath) {
  return fs.readFileSync(filePath, 'utf8');
}

function listZipNames(zipPath) {
  const pythons = process.platform === 'win32' ? ['python', 'py', 'python3'] : ['python3', 'python'];
  const script = 'import sys, zipfile\nprint("\\n".join(zipfile.ZipFile(sys.argv[1]).namelist()))';
  let lastError = 'python not found';
  for (const python of pythons) {
    const result = spawnSync(python, ['-c', script, zipPath], { encoding: 'utf8' });
    if (result.status === 0) {
      return result.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    }
    if (result.error && result.error.code === 'ENOENT') continue;
    lastError = (result.stderr || result.stdout || (result.error && result.error.message) || '').trim();
  }
  fail(`Could not read zip ${zipPath}: ${lastError}`);
}

function loadAsar() {
  const names = ['@electron/asar', 'electron-builder/node_modules/@electron/asar'];
  for (const name of names) {
    try {
      return require(name);
    } catch {
      // Try the next location. The filesystem check still stands.
    }
  }
  return null;
}

function assertOutsideAsar(resourcesPath, resolved) {
  const asarPath = path.join(resourcesPath, 'app.asar');
  if (!fs.existsSync(asarPath)) fail(`app.asar missing at ${asarPath}`);
  const resolvedAbs = path.resolve(resolved);
  const asarAbs = path.resolve(asarPath);
  if (resolvedAbs === asarAbs || resolvedAbs.startsWith(asarAbs + path.sep)) {
    fail(`yt-dlp resolved inside app.asar: ${resolved}`);
  }
  if (resolved.split(/[/\\]/).includes('app.asar')) {
    fail(`resolved yt-dlp path contains app.asar: ${resolved}`);
  }

  const asar = loadAsar();
  if (!asar || typeof asar.listPackage !== 'function') {
    console.log('ok  asar file list skipped (package not loadable); path is a real file beside app.asar');
    return;
  }
  const entries = asar.listPackage(asarPath).map((entry) => entry.replace(/\\/g, '/'));
  const packedExe = entries.filter((entry) => entry.endsWith('/yt-dlp.exe') || entry.endsWith('yt-dlp.exe'));
  if (packedExe.length) {
    fail(`yt-dlp.exe is inside app.asar: ${packedExe.join(', ')}`);
  }
  console.log('ok  app.asar does not contain yt-dlp.exe');
}

function assertPackagedFile(resourcesPath, name, check) {
  const filePath = path.join(resourcesPath, 'bin', name);
  if (!fs.existsSync(filePath)) fail(`missing ${filePath}`);
  const text = readText(filePath);
  if (!check(text)) fail(`unexpected contents in ${filePath}`);
  console.log(`ok  ${filePath}`);
}

function verifyUnpacked(unpackedDir) {
  const resourcesPath = path.join(unpackedDir, 'resources');
  if (!fs.existsSync(resourcesPath)) fail(`Windows resources directory not found: ${resourcesPath}`);

  const resolved = resolveYtdlpPath({
    customPath: '',
    isPackaged: true,
    resourcesPath,
    devPath: path.join(root, 'bin', 'win', 'not-used.exe'),
  });
  const expected = path.join(resourcesPath, PACKAGED_RELATIVE);
  if (path.resolve(resolved) !== path.resolve(expected)) {
    fail(`resolver returned ${resolved}, expected ${expected}`);
  }

  if (!fs.existsSync(resolved)) fail(`yt-dlp missing at resolved path ${resolved}`);
  const stat = fs.statSync(resolved);
  if (!stat.isFile() || stat.size < 5_000_000) {
    fail(`yt-dlp at ${resolved} is ${stat.size} bytes; expected the official binary`);
  }
  const header = Buffer.alloc(2);
  const fd = fs.openSync(resolved, 'r');
  try {
    fs.readSync(fd, header, 0, 2, 0);
  } finally {
    fs.closeSync(fd);
  }
  if (header.toString('ascii') !== 'MZ') {
    fail(`yt-dlp at ${resolved} is not a Windows executable`);
  }

  const ffmpegPath = path.join(resourcesPath, 'bin', 'ffmpeg.exe');
  if (!fs.existsSync(ffmpegPath)) {
    fail(`bundled ffmpeg missing at ${ffmpegPath}`);
  }

  assertOutsideAsar(resourcesPath, resolved);
  assertPackagedFile(resourcesPath, 'yt-dlp-LICENSE.txt', (text) => /unlicense\.org/i.test(text));
  assertPackagedFile(resourcesPath, 'yt-dlp-NOTICE.txt', (text) => (
    text.includes(release.version) && text.includes(release.sha256)
  ));
  assertPackagedFile(
    resourcesPath,
    'yt-dlp-THIRD_PARTY_LICENSES.txt',
    (text) => text.includes('PyInstaller-bundled executables')
  );

  console.log(`ok  packaged yt-dlp ${resolved} (${stat.size} bytes)`);
  return resolved;
}

function verifyZip(distDir) {
  const zips = fs.readdirSync(distDir).filter((name) => name.endsWith('.zip'));
  if (!zips.length) {
    if (requireZip) fail(`no zip artifact in ${distDir}`);
    console.log('ok  zip check skipped (no zip in dist)');
    return;
  }
  for (const name of zips) {
    const zipPath = path.join(distDir, name);
    const names = listZipNames(zipPath).map((entry) => entry.replace(/\\/g, '/'));
    const hit = names.find((entry) => entry === 'resources/bin/yt-dlp.exe' || entry.endsWith('/resources/bin/yt-dlp.exe'));
    if (!hit) fail(`${name} does not contain resources/bin/yt-dlp.exe`);
    const insideAsar = names.filter((entry) => entry.includes('app.asar') && entry.endsWith('yt-dlp.exe'));
    if (insideAsar.length) fail(`${name} packs yt-dlp.exe inside app.asar: ${insideAsar.join(', ')}`);
    console.log(`ok  ${name} contains ${hit}`);
  }
}

const unpacked = path.join(root, 'dist', 'win-unpacked');
if (!fs.existsSync(unpacked)) fail(`Windows unpack directory not found: ${unpacked}`);
verifyUnpacked(unpacked);
verifyZip(path.join(root, 'dist'));
console.log('yt-dlp packaging check passed');
