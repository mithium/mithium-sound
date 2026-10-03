// Windows Openverse browse caps. Search results are already under 30 seconds.
// 30 seconds and under keeps that list. 10 seconds and under keeps duration <= 10s.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.MithiumLengthCap = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  var MAX_MS = 30000;
  var SHORT_MS = 10000;

  function capMs(value) {
    return Number(value) === SHORT_MS ? SHORT_MS : MAX_MS;
  }

  function matches(durationMs, cap) {
    var duration = Number(durationMs);
    var limit = capMs(cap);
    if (!isFinite(duration) || duration <= 0) return false;
    if (duration >= MAX_MS) return false;
    return duration <= limit;
  }

  return {
    MAX_MS: MAX_MS,
    SHORT_MS: SHORT_MS,
    capMs: capMs,
    matches: matches,
  };
});
