// Where a phone remote tap should be heard.
// Default is the Windows app. The phone speaker is only an explicit audition.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.MithiumPlayback = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  function playbackTarget(hearOnPhone) {
    return hearOnPhone === true ? 'phone' : 'windows';
  }

  return { playbackTarget: playbackTarget };
});
