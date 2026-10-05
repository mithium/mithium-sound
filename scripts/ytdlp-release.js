// Pinned official yt-dlp Windows build. The exe is downloaded at install
// time; the license texts in third_party/yt-dlp are committed so the
// redistributed notices stay reviewable.
const path = require('path');

const root = path.join(__dirname, '..');
const version = '2026.08.19';
const sha256 = '66674953fe251b89f4d08c5f0e35e0728679bd67ab3d7d05c0562af101dd3e7a';

module.exports = {
  version,
  sha256,
  url: `https://github.com/yt-dlp/yt-dlp/releases/download/${version}/yt-dlp.exe`,
  licensePath: path.join(root, 'third_party', 'yt-dlp', 'LICENSE'),
  thirdPartyPath: path.join(root, 'third_party', 'yt-dlp', 'THIRD_PARTY_LICENSES.txt'),
  noticePath: path.join(root, 'third_party', 'yt-dlp', 'NOTICE'),
  destPath: path.join(root, 'bin', 'win', 'yt-dlp.exe'),
};
