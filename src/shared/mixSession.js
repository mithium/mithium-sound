// Multi-track voice editor. Voice stays on its own track. Sound effects sit on
// another track until save mixes them down. Two tracks show by default.
// Extra tracks are added only when asked, up to 10.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.MithiumMix = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  var MAX_TRACKS = 10;

  function createMixSession() {
    return {
      markerMs: 0,
      tracks: [
        { id: 'voice', name: 'Voice', kind: 'voice', clips: [] },
        { id: 'effects', name: 'Sound effects', kind: 'effects', clips: [] },
      ],
    };
  }

  function sessionDurationMs(session) {
    var max = 0;
    (session && session.tracks || []).forEach(function (track) {
      (track.clips || []).forEach(function (clip) {
        var end = Number(clip.startMs) + Number(clip.durationMs || 0);
        if (end > max) max = end;
      });
    });
    return max;
  }

  function voiceTrack(session) {
    return session.tracks[0];
  }

  function effectsTrack(session) {
    return session.tracks.find(function (track) { return track.kind === 'effects'; });
  }

  function addExtraTrack(session) {
    if (!session || session.tracks.length >= MAX_TRACKS) {
      throw new Error('Ten tracks is the limit');
    }
    var track = {
      id: 'extra-' + (session.tracks.length + 1) + '-' + Math.floor(Math.random() * 1000),
      name: 'Track ' + (session.tracks.length + 1),
      kind: 'extra',
      clips: [],
    };
    session.tracks.push(track);
    return track;
  }

  function removeTrack(session, trackId) {
    var track = (session.tracks || []).find(function (item) { return item.id === trackId; });
    if (!track || track.kind !== 'extra') throw new Error('Only an extra track can be removed');
    session.tracks = session.tracks.filter(function (item) { return item.id !== trackId; });
  }

  function setVoiceTake(session, sourceKey, durationMs) {
    var length = Math.round(Number(durationMs));
    if (!sourceKey) throw new Error('The voice take has no audio');
    if (!Number.isFinite(length) || length <= 0) throw new Error('The voice take has no length');
    voiceTrack(session).clips = [{
      uid: 'voice-' + sourceKey,
      sourceKey: sourceKey,
      startMs: 0,
      offsetMs: 0,
      durationMs: length,
    }];
    return voiceTrack(session).clips.slice();
  }

  function punchVoice(session, atMs, sourceKey, durationMs) {
    var length = Math.round(Number(durationMs));
    if (!sourceKey) throw new Error('The punch-in has no audio');
    if (!Number.isFinite(length) || length <= 0) throw new Error('The punch-in has no length');
    var voice = voiceTrack(session);
    if (!voice.clips.length) {
      voice.clips = [{
        uid: 'voice-' + sourceKey,
        sourceKey: sourceKey,
        startMs: Math.max(0, Math.round(Number(atMs) || 0)),
        offsetMs: 0,
        durationMs: length,
      }];
      return voice.clips.slice();
    }
    var start = Math.max(0, Math.round(Number(atMs) || 0));
    var end = start + length;
    var next = [];
    voice.clips.forEach(function (clip) {
      var clipEnd = clip.startMs + clip.durationMs;
      if (clipEnd <= start || clip.startMs >= end) {
        next.push(Object.assign({}, clip));
        return;
      }
      if (clip.startMs < start) {
        next.push(Object.assign({}, clip, { durationMs: start - clip.startMs }));
      }
      if (clipEnd > end) {
        var consumed = end - clip.startMs;
        next.push(Object.assign({}, clip, {
          uid: clip.uid + '-tail-' + end,
          startMs: end,
          offsetMs: (clip.offsetMs || 0) + consumed,
          durationMs: clipEnd - end,
        }));
      }
    });
    next.push({
      uid: 'punch-' + sourceKey,
      sourceKey: sourceKey,
      startMs: start,
      offsetMs: 0,
      durationMs: length,
    });
    next.sort(function (a, b) { return a.startMs - b.startMs; });
    voice.clips = next;
    return next;
  }

  function placeClip(session, trackId, clip) {
    var track = (session.tracks || []).find(function (item) { return item.id === trackId; });
    if (!track) throw new Error('That track is not on screen');
    if (track.kind === 'voice') throw new Error('Sound effects sit on their own track');
    if (!clip || clip.clipId == null || clip.clipId === '') throw new Error('Choose a clip to place');
    var duration = Number(clip.durationMs);
    if (!Number.isFinite(duration) || duration <= 0) throw new Error('That clip has no length');
    var item = {
      uid: clip.uid || ('fx-' + track.clips.length + '-' + Math.floor(Math.random() * 100000)),
      sourceKey: 'clip:' + clip.clipId,
      clipId: clip.clipId,
      name: clip.name || 'Clip',
      startMs: Math.max(0, Math.round(Number(clip.startMs) || 0)),
      offsetMs: 0,
      durationMs: Math.round(duration),
    };
    track.clips.push(item);
    return item;
  }

  function deleteRange(session, trackId, startMs, endMs) {
    var track = (session.tracks || []).find(function (item) { return item.id === trackId; });
    if (!track) throw new Error('That track is not on screen');
    var start = Math.round(Math.min(Number(startMs), Number(endMs)));
    var end = Math.round(Math.max(Number(startMs), Number(endMs)));
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
      throw new Error('Select a section to delete');
    }
    var gap = end - start;
    var next = [];
    (track.clips || []).forEach(function (clip) {
      var clipStart = clip.startMs;
      var clipEnd = clip.startMs + clip.durationMs;
      if (clipEnd <= start) {
        next.push(Object.assign({}, clip));
        return;
      }
      if (clipStart >= end) {
        next.push(Object.assign({}, clip, { startMs: clipStart - gap }));
        return;
      }
      if (clipStart < start) {
        next.push(Object.assign({}, clip, {
          uid: clip.uid + '-keep-' + start,
          durationMs: start - clipStart,
        }));
      }
      if (clipEnd > end) {
        next.push(Object.assign({}, clip, {
          uid: clip.uid + '-after-' + end,
          startMs: start,
          offsetMs: (clip.offsetMs || 0) + (end - clipStart),
          durationMs: clipEnd - end,
        }));
      }
    });
    next.sort(function (a, b) { return a.startMs - b.startMs; });
    track.clips = next;
    return next;
  }

  function removeClip(session, trackId, uid) {
    var track = (session.tracks || []).find(function (item) { return item.id === trackId; });
    if (!track || track.kind === 'voice') return;
    track.clips = track.clips.filter(function (clip) { return clip.uid !== uid; });
  }

  function mixClips(session, voiceOnly) {
    var tracks = voiceOnly
      ? (session.tracks || []).filter(function (track) { return track.kind === 'voice'; })
      : (session.tracks || []);
    var clips = [];
    tracks.forEach(function (track) {
      (track.clips || []).forEach(function (clip) {
        if (!clip.sourceKey || !(Number(clip.durationMs) > 0)) return;
        clips.push({
          trackId: track.id,
          trackKind: track.kind,
          sourceKey: clip.sourceKey,
          clipId: clip.clipId == null ? null : clip.clipId,
          name: clip.name || '',
          startMs: clip.startMs,
          offsetMs: clip.offsetMs || 0,
          durationMs: clip.durationMs,
        });
      });
    });
    return clips;
  }

  return {
    MAX_TRACKS: MAX_TRACKS,
    createMixSession: createMixSession,
    sessionDurationMs: sessionDurationMs,
    addExtraTrack: addExtraTrack,
    removeTrack: removeTrack,
    setVoiceTake: setVoiceTake,
    punchVoice: punchVoice,
    placeClip: placeClip,
    deleteRange: deleteRange,
    removeClip: removeClip,
    mixClips: mixClips,
    effectsTrack: effectsTrack,
  };
});
