// yt-dlp path rules shared by the main process and the settings form.
// A blank value, or the old default command name, means "use the bundle".
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.MithiumYtdlpPath = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  var PACKAGED_DIR = 'bin';
  var PACKAGED_NAME = 'yt-dlp.exe';

  function isCustomYtdlpPath(value) {
    var custom = String(value == null ? '' : value).trim();
    if (!custom) return false;
    if (/^yt-dlp(\.exe)?$/i.test(custom)) return false;
    return true;
  }

  function customPathForSettings(value) {
    return isCustomYtdlpPath(value) ? String(value).trim() : '';
  }

  return {
    PACKAGED_DIR: PACKAGED_DIR,
    PACKAGED_NAME: PACKAGED_NAME,
    isCustomYtdlpPath: isCustomYtdlpPath,
    customPathForSettings: customPathForSettings,
  };
});
