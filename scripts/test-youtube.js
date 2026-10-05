#!/usr/bin/env node
// yt-dlp path resolution and plain-language failures. No Electron required.
//   node scripts/test-youtube.js

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const youtube = require('../src/main/youtube');
const { resolveYtdlpPath, PACKAGED_RELATIVE } = require('../src/main/ytdlpBin');
const { userFacingIpcError } = require('../src/shared/ipcError');
const release = require('./ytdlp-release');

let passed = 0;

async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`ok  ${name}`);
  } catch (err) {
    console.error(`FAIL ${name}`);
    console.error(err);
    process.exitCode = 1;
  }
}

const resources = path.join(path.sep, 'Program Files', 'Mithium Sound', 'resources');
const devPath = path.join(path.sep, 'src', 'bin', 'win', 'yt-dlp.exe');
const customPath = path.join(path.sep, 'Tools', 'custom-yt-dlp.exe');

function packaged() {
  return path.join(resources, PACKAGED_RELATIVE);
}

(async () => {
  await test('blank and the old command name use the bundled path outside app.asar', () => {
    for (const custom of ['', '   ', 'yt-dlp', 'yt-dlp.exe', 'YT-DLP.EXE', null, undefined]) {
      const resolved = resolveYtdlpPath({
        customPath: custom,
        isPackaged: true,
        resourcesPath: resources,
        devPath,
      });
      assert.strictEqual(resolved, packaged());
      assert.ok(!resolved.split(path.sep).includes('app.asar'));
      assert.strictEqual(path.basename(resolved), 'yt-dlp.exe');
      assert.strictEqual(PACKAGED_RELATIVE, path.join('bin', 'yt-dlp.exe'));
    }
  });

  await test('unpackaged app uses the downloaded dev binary, not the bare command', () => {
    const resolved = resolveYtdlpPath({
      customPath: 'yt-dlp',
      isPackaged: false,
      resourcesPath: resources,
      devPath,
    });
    assert.strictEqual(resolved, devPath);
  });

  await test('a custom settings path wins over the bundle', () => {
    const resolved = resolveYtdlpPath({
      customPath: `  ${customPath}  `,
      isPackaged: true,
      resourcesPath: resources,
      devPath,
    });
    assert.strictEqual(resolved, customPath);
  });

  await test('bot check and network failures stay plain language', () => {
    const bot = youtube.explainYtdlpFailure(
      "ERROR: [youtube] MMdvNV6kAQk: Sign in to confirm you’re not a bot. Use --cookies-from-browser or --cookies for the authentication."
    );
    assert.match(bot, /thinks the app is a bot/i);
    assert.doesNotMatch(bot, /ERROR:/);
    assert.doesNotMatch(bot, /Error invoking remote method/);

    const networkStderr = "ERROR: Unable to download webpage: https://www.youtube.com/watch?v=MMdvNV6kAQk (caused by URLError('nodename nor servname provided, or not known'))";
    const network = youtube.explainYtdlpFailure(networkStderr);
    assert.match(network, /Couldn't reach YouTube/);
    assert.doesNotMatch(network, /URLError/);
    assert.doesNotMatch(network, /MMdvNV6kAQk/);

    assert.strictEqual(
      youtube.shouldRetryWithCookies('Sign in to confirm you’re not a bot. Use --cookies'),
      true
    );
    assert.strictEqual(youtube.shouldRetryWithCookies(networkStderr), false);
    assert.strictEqual(
      youtube.shouldRetryWithCookies('ERROR: This video is age-restricted'),
      true
    );
  });

  await test('a missing downloader does not tell the user to install yt-dlp', async () => {
    const missing = path.join(path.sep, 'missing', 'yt-dlp.exe');
    await assert.rejects(
      () => youtube.probeDuration({
        url: 'https://www.youtube.com/watch?v=MMdvNV6kAQk',
        ytdlpPath: missing,
      }),
      (err) => {
        assert.match(err.message, /Couldn't find the YouTube downloader/);
        assert.match(err.message, /Reinstall Mithium Sound/);
        assert.doesNotMatch(err.message, /Install it/);
        assert.doesNotMatch(err.message, /exited with code/);
        return true;
      }
    );
  });

  await test('renderer strips the IPC wrapper and keeps the sentence', () => {
    const plain = "Couldn't reach YouTube. Check your internet connection and try again.";
    assert.strictEqual(
      userFacingIpcError(new Error(`Error invoking remote method 'youtube:extract': ${plain}`)),
      plain
    );
    assert.strictEqual(
      userFacingIpcError(new Error(`Error invoking remote method 'youtube:extract': Error: ${plain}`)),
      plain
    );
  });

  await test('packaging config places yt-dlp in extraResources beside ffmpeg', () => {
    const yml = fs.readFileSync(path.join(__dirname, '..', 'electron-builder.yml'), 'utf8');
    assert.match(yml, /from:\s*bin\/win\/ffmpeg\.exe/);
    assert.match(yml, /to:\s*bin\/ffmpeg\.exe/);
    assert.match(yml, /from:\s*bin\/win\/yt-dlp\.exe/);
    assert.match(yml, /to:\s*bin\/yt-dlp\.exe/);
    assert.match(yml, /from:\s*third_party\/yt-dlp\/LICENSE/);
    assert.match(yml, /to:\s*bin\/yt-dlp-LICENSE\.txt/);
    assert.match(yml, /from:\s*third_party\/yt-dlp\/THIRD_PARTY_LICENSES\.txt/);
    assert.match(yml, /from:\s*third_party\/yt-dlp\/NOTICE/);
    const index = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'index.js'), 'utf8');
    assert.match(index, /resolveConfiguredYtdlpPath/);
    assert.doesNotMatch(index, /\|\| 'yt-dlp'/);
    const appJs = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'app.js'), 'utf8');
    assert.match(appJs, /customPathForSettings/);
    assert.match(appJs, /youtubeErrorText\(err\)/);
    assert.doesNotMatch(appJs, /ytdlpPath \|\| 'yt-dlp'/);
    const notice = fs.readFileSync(release.noticePath, 'utf8');
    assert.ok(notice.includes(release.version));
    assert.ok(notice.includes(release.sha256));
    const license = fs.readFileSync(release.licensePath, 'utf8');
    assert.match(license, /unlicense\.org/i);
  });

  if (process.exitCode) {
    console.error('youtube tests failed');
    return;
  }
  console.log(`\n${passed} passed`);
})();
