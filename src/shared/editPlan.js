// Single-track insert order shared by the Windows UI, the phone remote, and ffmpeg.
// One base clip, plus inserts placed before it, after it, or at a point in it.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.MithiumEdit = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  function formatMs(ms) {
    const total = Math.max(0, Math.round(Number(ms) / 1000));
    const minutes = Math.floor(total / 60);
    const seconds = total % 60;
    return minutes + ':' + String(seconds).padStart(2, '0');
  }

  function buildEditTimeline(input) {
    const baseId = input && input.baseId;
    const duration = Number(input && input.baseDurationMs);
    if (baseId == null || baseId === '') throw new Error('Choose a clip to edit');
    if (!Number.isFinite(duration) || duration <= 0) throw new Error('Clip length is unknown');
    const list = Array.isArray(input.inserts) ? input.inserts : [];
    if (list.length > 12) throw new Error('Too many inserts');

    const befores = [];
    const afters = [];
    const ats = [];
    list.forEach(function (item, index) {
      if (!item || item.clipId == null || item.clipId === '') {
        throw new Error('Choose a clip to insert');
      }
      const placement = String(item.placement || '');
      if (placement === 'before') {
        befores.push(item);
        return;
      }
      if (placement === 'after') {
        afters.push(item);
        return;
      }
      if (placement !== 'at') throw new Error('Insert must be before, at a point, or after');
      const atMs = Number(item.atMs);
      if (!Number.isFinite(atMs)) throw new Error('Pick a point on the waveform');
      if (atMs < -50 || atMs > duration + 50) throw new Error('Insert point is outside the clip');
      ats.push({
        item: item,
        index: index,
        atMs: Math.min(duration, Math.max(0, atMs)),
      });
    });
    ats.sort(function (a, b) {
      return a.atMs - b.atMs || a.index - b.index;
    });

    const pieces = [];
    befores.forEach(function (item) {
      pieces.push({ kind: 'insert', clipId: item.clipId, uid: item.uid || null });
    });

    let cursor = 0;
    ats.forEach(function (entry) {
      if (entry.atMs > cursor) {
        pieces.push({
          kind: 'base',
          clipId: baseId,
          startMs: cursor,
          endMs: entry.atMs,
        });
      }
      pieces.push({ kind: 'insert', clipId: entry.item.clipId, uid: entry.item.uid || null });
      cursor = Math.max(cursor, entry.atMs);
    });
    if (duration > cursor) {
      pieces.push({
        kind: 'base',
        clipId: baseId,
        startMs: cursor,
        endMs: duration,
      });
    }
    afters.forEach(function (item) {
      pieces.push({ kind: 'insert', clipId: item.clipId, uid: item.uid || null });
    });
    return pieces;
  }

  function describeTimeline(timeline, names, baseId) {
    const lookup = names || {};
    return (timeline || []).map(function (piece) {
      if (piece.kind === 'insert') {
        return { uid: piece.uid || null, label: lookup[piece.clipId] || 'Clip' };
      }
      const name = lookup[baseId] || 'Voice';
      return {
        uid: null,
        label: name + ' ' + formatMs(piece.startMs) + '–' + formatMs(piece.endMs),
      };
    });
  }

  return {
    formatMs: formatMs,
    buildEditTimeline: buildEditTimeline,
    describeTimeline: describeTimeline,
  };
});
