const path = require('path');
const {
  PACKAGED_DIR,
  PACKAGED_NAME,
  isCustomYtdlpPath,
  customPathForSettings,
} = require('../shared/ytdlpPath');

// extraResources copies this next to resources/app.asar, not inside it.
// Spawn cannot run a binary packed inside the asar archive.
const PACKAGED_RELATIVE = path.join(PACKAGED_DIR, PACKAGED_NAME);

function resolveYtdlpPath({ customPath, isPackaged, resourcesPath, devPath }) {
  if (isCustomYtdlpPath(customPath)) return String(customPath).trim();
  if (isPackaged) return path.join(resourcesPath, PACKAGED_RELATIVE);
  return devPath;
}

function packagedYtdlpPath(resourcesPath) {
  return path.join(resourcesPath, PACKAGED_RELATIVE);
}

module.exports = {
  PACKAGED_RELATIVE,
  isCustomYtdlpPath,
  customPathForSettings,
  resolveYtdlpPath,
  packagedYtdlpPath,
};
