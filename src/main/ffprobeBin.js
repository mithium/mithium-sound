const fs = require('fs');
const path = require('path');

function packagedFfprobePath(resourcesPath) {
  return path.join(resourcesPath, 'bin', 'ffprobe.exe');
}

function resolveFfprobePath({ isPackaged, resourcesPath, devPath } = {}) {
  if (isPackaged) return packagedFfprobePath(resourcesPath);
  if (devPath && fs.existsSync(devPath)) return devPath;
  try {
    const bundled = require('ffprobe-static').path;
    if (bundled && fs.existsSync(bundled)) return bundled;
  } catch {
    /* use the dev path below */
  }
  return devPath || '';
}

module.exports = {
  packagedFfprobePath,
  resolveFfprobePath,
};
