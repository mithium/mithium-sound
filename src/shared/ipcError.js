// Electron prefixes renderer failures with the IPC channel name.
// YouTube errors are already plain sentences; this only removes that wrapper.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.MithiumIpcError = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  function userFacingIpcError(err) {
    var raw = '';
    if (err && err.message) raw = String(err.message);
    else if (err) raw = String(err);
    var guard = 0;
    while (guard < 3) {
      var next = raw.replace(/^Error invoking remote method '[^']+':\s*/i, '');
      next = next.replace(/^Error:\s*/i, '');
      if (next === raw) break;
      raw = next;
      guard += 1;
    }
    raw = raw.trim();
    return raw || 'Something went wrong. Try again.';
  }

  return { userFacingIpcError: userFacingIpcError };
});
