// Download the pinned official yt-dlp.exe used by the Windows package.
// The binary is not committed. License and third-party notices are.
const fs = require('fs');
const path = require('path');
const https = require('https');
const crypto = require('crypto');
const release = require('./ytdlp-release');

function sha256File(filePath) {
  const hash = crypto.createHash('sha256');
  hash.update(fs.readFileSync(filePath));
  return hash.digest('hex');
}

function assertNotices() {
  const notice = fs.readFileSync(release.noticePath, 'utf8');
  if (!notice.includes(release.version)) {
    throw new Error(`yt-dlp NOTICE is missing pinned version ${release.version}`);
  }
  if (!notice.includes(release.sha256)) {
    throw new Error('yt-dlp NOTICE is missing the pinned SHA-256');
  }
  const license = fs.readFileSync(release.licensePath, 'utf8');
  if (!/unlicense\.org/i.test(license) || !/public domain/i.test(license)) {
    throw new Error('yt-dlp LICENSE is not the Unlicense text');
  }
  const thirdParty = fs.readFileSync(release.thirdPartyPath, 'utf8');
  if (!thirdParty.includes('PyInstaller-bundled executables')) {
    throw new Error('yt-dlp THIRD_PARTY_LICENSES.txt is missing or unexpected');
  }
}

function download(url, dest, redirectsLeft) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: { 'User-Agent': 'mithium-sound-build', Accept: '*/*' },
    }, (res) => {
      const status = res.statusCode || 0;
      if (status >= 300 && status < 400 && res.headers.location) {
        res.resume();
        if (redirectsLeft <= 0) {
          reject(new Error('Too many redirects downloading yt-dlp'));
          return;
        }
        const next = new URL(res.headers.location, url).href;
        download(next, dest, redirectsLeft - 1).then(resolve, reject);
        return;
      }
      if (status !== 200) {
        res.resume();
        reject(new Error(`yt-dlp download failed with HTTP ${status} for ${url}`));
        return;
      }
      const file = fs.createWriteStream(dest);
      res.pipe(file);
      file.on('finish', () => file.close((err) => (err ? reject(err) : resolve())));
      file.on('error', (err) => file.close(() => reject(err)));
    });
    req.on('error', reject);
  });
}

async function fetchWithRetries(url, dest) {
  let lastErr;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      await download(url, dest, 5);
      return;
    } catch (err) {
      lastErr = err;
      console.error(`yt-dlp download attempt ${attempt} failed: ${err.message}`);
    }
  }
  throw lastErr;
}

async function main() {
  assertNotices();
  fs.mkdirSync(path.dirname(release.destPath), { recursive: true });

  if (fs.existsSync(release.destPath) && sha256File(release.destPath) === release.sha256) {
    console.log(`yt-dlp ${release.version} already present: ${release.destPath}`);
    return;
  }

  const partial = `${release.destPath}.partial`;
  if (fs.existsSync(partial)) fs.unlinkSync(partial);
  console.log(`Downloading yt-dlp ${release.version} from ${release.url}`);
  await fetchWithRetries(release.url, partial);
  const got = sha256File(partial);
  if (got !== release.sha256) {
    fs.unlinkSync(partial);
    throw new Error(`yt-dlp SHA-256 mismatch: expected ${release.sha256}, got ${got}`);
  }
  if (fs.existsSync(release.destPath)) fs.unlinkSync(release.destPath);
  fs.renameSync(partial, release.destPath);
  console.log(`Saved yt-dlp.exe to ${release.destPath}`);
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
