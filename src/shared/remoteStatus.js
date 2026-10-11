// Settings copy for the LAN remote. The saved port stays what the user chose.
// The status line is the port that is actually listening, or why it is not.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.MithiumRemoteStatus = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  function remoteStatusView(status) {
    var state = status || {};
    if (state.running) {
      var moved = state.requestedPort && state.port && Number(state.port) !== Number(state.requestedPort);
      var parts = [];
      if (state.notice) parts.push(String(state.notice));
      if (state.secureUnavailableReason) parts.push(String(state.secureUnavailableReason));
      return {
        state: 'running',
        label: moved ? 'Running on port ' + state.port : 'Running',
        detail: parts.join(' '),
        detailTone: state.secureUnavailableReason ? 'warning' : (state.notice ? 'muted' : ''),
        urls: state.urls || [],
        secureUrls: state.secureUrls || [],
      };
    }
    if (state.unavailableReason) {
      return {
        state: 'unavailable',
        label: 'Unavailable',
        detail: String(state.unavailableReason),
        detailTone: 'danger',
        urls: [],
        secureUrls: [],
      };
    }
    return {
      state: 'stopped',
      label: 'Stopped',
      detail: '',
      detailTone: '',
      urls: [],
      secureUrls: [],
    };
  }

  return { remoteStatusView: remoteStatusView };
});
