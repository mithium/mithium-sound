// Voice editor UI shared by the Windows app and the phone remote.
(function (root) {
  function mountMixEditor(host) {
    const mix = root.MithiumMix;
    const waveApi = root.MithiumWave;
    const $ = host.$;
    const wave = $('#rec-wave');
    const trackList = $('#track-list');
    if (!mix || !waveApi || !wave || !trackList) return;

    const session = mix.createMixSession();
    const sources = new Map();
    let recording = false;
    let recordMode = 'take';
    let punchAt = 0;
    let recorder = null;
    let recordStream = null;
    let meterContext = null;
    let recordChunks = [];
    let livePeaks = [];
    let playContext = null;
    let sourceSerial = 1;
    let selection = null;
    let drag = null;

    function status(text) {
      const el = $('#rec-status');
      if (el) el.textContent = text;
    }

    function showError(message) {
      host.showError(message);
    }

    function markerRatio() {
      const duration = mix.sessionDurationMs(session);
      if (!duration) return 0;
      return Math.min(1, Math.max(0, session.markerMs / duration));
    }

    function trackPeaks(track) {
      const duration = mix.sessionDurationMs(session);
      if (track.kind === 'voice' && recording) return livePeaks;
      if (!duration || !track.clips.length) return [];
      const buckets = 180;
      const out = new Array(buckets).fill(0);
      track.clips.forEach(function (clip) {
        const src = sources.get(clip.sourceKey);
        const peaks = (src && src.peaks) || [];
        const srcDuration = (src && src.durationMs) || clip.durationMs;
        if (!peaks.length || !srcDuration) return;
        const startBucket = Math.floor((clip.startMs / duration) * buckets);
        const span = Math.max(1, Math.round((clip.durationMs / duration) * buckets));
        for (let i = 0; i < span; i += 1) {
          const local = (i / span) * clip.durationMs;
          const pos = Math.min(0.999, ((clip.offsetMs || 0) + local) / srcDuration);
          const sample = peaks[Math.min(peaks.length - 1, Math.floor(pos * peaks.length))] || 0;
          const bucket = startBucket + i;
          if (bucket >= 0 && bucket < buckets) out[bucket] = Math.max(out[bucket], sample);
        }
      });
      return out;
    }

    function selectionRatios(trackId) {
      const duration = mix.sessionDurationMs(session);
      if (!selection || selection.trackId !== trackId || !duration) return null;
      return { start: selection.startMs / duration, end: selection.endMs / duration };
    }

    function paint() {
      const duration = mix.sessionDurationMs(session);
      waveApi.drawWaveform(
        wave,
        trackPeaks(session.tracks[0]),
        recording ? null : markerRatio(),
        selectionRatios('voice')
      );
      trackList.querySelectorAll('canvas[data-track-id]').forEach(function (canvas) {
        const track = session.tracks.find(function (item) { return item.id === canvas.dataset.trackId; });
        if (!track) return;
        waveApi.drawWaveform(canvas, trackPeaks(track), markerRatio(), selectionRatios(track.id));
      });
      const label = $('#rec-marker');
      if (label) {
        const clock = root.MithiumEdit ? root.MithiumEdit.formatMs(session.markerMs) : String(session.markerMs);
        if (selection && selection.endMs > selection.startMs) {
          const from = root.MithiumEdit ? root.MithiumEdit.formatMs(selection.startMs) : String(selection.startMs);
          const to = root.MithiumEdit ? root.MithiumEdit.formatMs(selection.endMs) : String(selection.endMs);
          const track = session.tracks.find(function (item) { return item.id === selection.trackId; });
          label.textContent = 'Selected ' + from + '–' + to + ' on ' + (track ? track.name : 'track') + '. Delete section removes it and closes the gap.';
        } else {
          label.textContent = duration
            ? 'Point ' + clock + '. Click a waveform to move it. Drag across a track to select a section.'
            : 'Record a voice take, then click the waveform to place a sound effect or punch in.';
        }
      }
      const saveBtn = $('#edit-render');
      if (saveBtn) saveBtn.disabled = mix.mixClips(session, false).length === 0;
      const addBtn = $('#add-track');
      if (addBtn) addBtn.disabled = session.tracks.length >= mix.MAX_TRACKS;
      const deleteBtn = $('#delete-section');
      if (deleteBtn) deleteBtn.disabled = !(selection && selection.endMs > selection.startMs);
    }

    function redraw() {
      renderTracks();
      paint();
    }

    function timeAt(canvas, event) {
      const point = event.touches && event.touches[0] ? event.touches[0] : event;
      const rect = canvas.getBoundingClientRect();
      const duration = mix.sessionDurationMs(session);
      if (!duration || !rect.width) return 0;
      const ratio = Math.min(1, Math.max(0, (point.clientX - rect.left) / rect.width));
      return Math.round(ratio * duration);
    }

    function bindSelect(canvas, trackId) {
      canvas.addEventListener('pointerdown', function (event) {
        if (recording || (event.button != null && event.button !== 0)) return;
        if (!mix.sessionDurationMs(session)) return;
        canvas.setPointerCapture(event.pointerId);
        drag = {
          trackId: trackId,
          anchorMs: timeAt(canvas, event),
          currentMs: timeAt(canvas, event),
          moved: false,
          startX: event.clientX,
        };
      });
      canvas.addEventListener('pointermove', function (event) {
        if (!drag || drag.trackId !== trackId) return;
        if (Math.abs(event.clientX - drag.startX) > 6) drag.moved = true;
        drag.currentMs = timeAt(canvas, event);
        if (!drag.moved) return;
        selection = {
          trackId: trackId,
          startMs: Math.min(drag.anchorMs, drag.currentMs),
          endMs: Math.max(drag.anchorMs, drag.currentMs),
        };
        paint();
      });
      function finish(event) {
        if (!drag || drag.trackId !== trackId) return;
        const info = drag;
        drag = null;
        if (event && event.pointerId != null && canvas.hasPointerCapture && canvas.hasPointerCapture(event.pointerId)) {
          canvas.releasePointerCapture(event.pointerId);
        }
        if (!info.moved) {
          session.markerMs = info.anchorMs;
          selection = null;
          paint();
          return;
        }
        selection = {
          trackId: trackId,
          startMs: Math.min(info.anchorMs, info.currentMs),
          endMs: Math.max(info.anchorMs, info.currentMs),
        };
        paint();
      }
      canvas.addEventListener('pointerup', finish);
      canvas.addEventListener('pointercancel', finish);
    }

    function renderTracks() {
      const duration = Math.max(1, mix.sessionDurationMs(session));
      trackList.innerHTML = '';
      session.tracks.forEach(function (track) {
        if (track.kind === 'voice') return;
        const section = document.createElement('section');
        section.className = 'mix-track';
        const title = document.createElement('div');
        title.className = 'mix-track-title';
        title.textContent = track.name;
        const canvas = document.createElement('canvas');
        canvas.className = 'wave-canvas mix-wave';
        canvas.dataset.trackId = track.id;
        canvas.setAttribute('aria-label', track.name + ' waveform');
        bindSelect(canvas, track.id);
        const lane = document.createElement('div');
        lane.className = 'mix-lane';
        track.clips.forEach(function (clip) {
          const block = document.createElement('div');
          block.className = 'mix-block';
          const width = Math.max(4, ((clip.durationMs || 400) / duration) * 100);
          block.style.left = ((clip.startMs / duration) * 100) + '%';
          block.style.width = width + '%';
          block.textContent = clip.name || 'Clip';
          lane.appendChild(block);
        });
        const list = document.createElement('ul');
        list.className = 'insert-list';
        track.clips.forEach(function (clip) {
          const li = document.createElement('li');
          const clock = root.MithiumEdit ? root.MithiumEdit.formatMs(clip.startMs) : String(clip.startMs);
          const text = document.createElement('span');
          text.textContent = (clip.name || 'Clip') + ' at ' + clock;
          const remove = document.createElement('button');
          remove.type = 'button';
          remove.textContent = 'Remove';
          remove.addEventListener('click', function () {
            mix.removeClip(session, track.id, clip.uid);
            redraw();
          });
          li.appendChild(text);
          li.appendChild(remove);
          list.appendChild(li);
        });
        section.appendChild(title);
        section.appendChild(canvas);
        section.appendChild(lane);
        if (track.kind === 'extra') {
          const actions = document.createElement('div');
          actions.className = 'studio-inline';
          const place = document.createElement('button');
          place.type = 'button';
          place.textContent = 'Place at point';
          place.addEventListener('click', function () {
            placeOn(track.id).catch(function (err) { showError(err.message); });
          });
          const drop = document.createElement('button');
          drop.type = 'button';
          drop.textContent = 'Remove track';
          drop.addEventListener('click', function () {
            mix.removeTrack(session, track.id);
            redraw();
          });
          actions.appendChild(place);
          actions.appendChild(drop);
          section.appendChild(actions);
        }
        section.appendChild(list);
        trackList.appendChild(section);
      });
    }

    function fillClips() {
      const select = $('#edit-insert');
      if (!select) return;
      const current = select.value;
      select.innerHTML = '<option value="">Choose a clip</option>';
      host.sounds().forEach(function (sound) {
        const option = document.createElement('option');
        option.value = String(sound.id);
        option.textContent = sound.name;
        select.appendChild(option);
      });
      if (current) select.value = current;
    }

    async function rememberSource(key, blob, decoded, extra) {
      sources.set(key, Object.assign({
        blob: blob,
        mime: blob.type || 'audio/webm',
        buffer: decoded.buffer,
        peaks: decoded.peaks,
        durationMs: decoded.durationMs,
      }, extra || {}));
    }

    async function decodeBlob(blob) {
      const ctx = new AudioContext();
      const raw = await blob.arrayBuffer();
      const audio = await ctx.decodeAudioData(raw.slice(0));
      const peaks = waveApi.peaksFromAudioBuffer(audio, 180);
      const durationMs = Math.round(audio.duration * 1000);
      await ctx.close();
      return { buffer: audio, peaks: peaks, durationMs: durationMs };
    }

    function stopMeter() {
      if (meterContext) meterContext.close().catch(function () {});
      meterContext = null;
      if (recordStream) {
        recordStream.getTracks().forEach(function (track) { track.stop(); });
        recordStream = null;
      }
    }

    async function startRecording(mode) {
      showError('');
      recordMode = mode === 'punch' ? 'punch' : 'take';
      punchAt = recordMode === 'punch' ? Math.max(0, Math.round(session.markerMs || 0)) : 0;
      if (recordMode === 'punch' && !session.tracks[0].clips.length && punchAt === 0) {
        recordMode = 'take';
      }
      if (playContext) {
        playContext.close().catch(function () {});
        playContext = null;
      }
      recordStream = await host.openMic();
      meterContext = new AudioContext();
      const source = meterContext.createMediaStreamSource(recordStream);
      const analyser = meterContext.createAnalyser();
      analyser.fftSize = 2048;
      source.connect(analyser);
      const mime = root.MediaRecorder && MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
        ? 'audio/webm;codecs=opus'
        : '';
      recorder = mime ? new MediaRecorder(recordStream, { mimeType: mime }) : new MediaRecorder(recordStream);
      recordChunks = [];
      livePeaks = [];
      recorder.ondataavailable = function (event) {
        if (event.data && event.data.size) recordChunks.push(event.data);
      };
      recorder.start(200);
      recording = true;
      $('#rec-start').disabled = true;
      const punchBtn = $('#rec-punch');
      if (punchBtn) punchBtn.disabled = true;
      $('#rec-stop').disabled = false;
      status(recordMode === 'punch'
        ? 'Punching in at ' + (root.MithiumEdit ? root.MithiumEdit.formatMs(punchAt) : punchAt)
        : 'Recording');
      const timeBuf = new Uint8Array(analyser.fftSize);
      let last = 0;
      const tick = function (now) {
        if (!recording) return;
        if (now - last > 50) {
          analyser.getByteTimeDomainData(timeBuf);
          livePeaks.push(waveApi.peakFromTimeDomain(timeBuf));
          if (livePeaks.length > 600) livePeaks.shift();
          last = now;
          redraw();
        }
        root.requestAnimationFrame(tick);
      };
      root.requestAnimationFrame(tick);
    }

    async function stopRecording() {
      if (!recorder || recorder.state === 'inactive') return;
      recording = false;
      const blob = await new Promise(function (resolve) {
        recorder.addEventListener('stop', function () {
          resolve(new Blob(recordChunks, { type: recorder.mimeType || 'audio/webm' }));
        }, { once: true });
        recorder.stop();
      });
      stopMeter();
      $('#rec-start').disabled = false;
      const punchBtn = $('#rec-punch');
      if (punchBtn) punchBtn.disabled = false;
      $('#rec-stop').disabled = true;
      const decoded = await decodeBlob(blob);
      const key = (recordMode === 'punch' ? 'punch-' : 'take-') + (sourceSerial += 1);
      await rememberSource(key, blob, decoded);
      if (recordMode === 'punch') mix.punchVoice(session, punchAt, key, decoded.durationMs);
      else mix.setVoiceTake(session, key, decoded.durationMs);
      const name = $('#edit-name');
      if (name && !name.value.trim()) name.value = 'Voice mix';
      status('Stopped · ' + (root.MithiumEdit ? root.MithiumEdit.formatMs(mix.sessionDurationMs(session)) : ''));
      redraw();
    }

    async function placeOn(trackId) {
      const select = $('#edit-insert');
      const clipId = select ? Number(select.value) : 0;
      if (!clipId) throw new Error('Choose a clip to place');
      if (!mix.sessionDurationMs(session) && session.markerMs === 0 && !session.tracks[0].clips.length) {
        throw new Error('Record a voice take first, then click where the effect should sit.');
      }
      const sound = host.sounds().find(function (item) { return Number(item.id) === clipId; });
      const key = 'clip:' + clipId;
      if (!sources.has(key)) {
        const bytes = await host.loadClipBytes(clipId);
        const blob = new Blob([bytes], { type: 'application/octet-stream' });
        const decoded = await decodeBlob(blob);
        await rememberSource(key, blob, decoded, { clipId: clipId });
      }
      const src = sources.get(key);
      mix.placeClip(session, trackId, {
        clipId: clipId,
        name: sound ? sound.name : 'Clip',
        startMs: session.markerMs || 0,
        durationMs: src.durationMs,
      });
      showError('');
      redraw();
    }

    async function payloadFor(clips) {
      const out = [];
      const seen = new Set();
      for (let i = 0; i < clips.length; i += 1) {
        const clip = clips[i];
        if (seen.has(clip.sourceKey)) continue;
        seen.add(clip.sourceKey);
        const src = sources.get(clip.sourceKey);
        if (!src) throw new Error('A track is missing its audio');
        if (src.clipId != null) out.push({ key: clip.sourceKey, clipId: src.clipId });
        else if (host.uploadScratch) {
          if (!src.scratchId) src.scratchId = await host.uploadScratch(src.blob, src.mime);
          out.push({ key: clip.sourceKey, scratchId: src.scratchId });
        } else {
          out.push({
            key: clip.sourceKey,
            bytes: new Uint8Array(await src.blob.arrayBuffer()),
            mime: src.mime,
          });
        }
      }
      return {
        name: ($('#edit-name') && $('#edit-name').value.trim()) || 'Voice mix',
        groupId: host.groupId(),
        clips: clips,
        sources: out,
      };
    }

    async function play(voiceOnly) {
      const clips = mix.mixClips(session, voiceOnly);
      if (!clips.length) throw new Error(voiceOnly ? 'Record a voice take first.' : 'Nothing to play yet.');
      if (!host.preferLocalPreview()) {
        if (playContext) playContext.close().catch(function () {});
        playContext = null;
        await host.playThroughWindows(await payloadFor(clips));
        status(voiceOnly ? 'Playing voice on Windows' : 'Playing mix on Windows');
        return;
      }
      if (playContext) playContext.close().catch(function () {});
      playContext = new AudioContext();
      if (host.prepareContext) await host.prepareContext(playContext);
      const when = playContext.currentTime + 0.05;
      clips.forEach(function (clip) {
        const src = sources.get(clip.sourceKey);
        if (!src || !src.buffer) throw new Error('Audio for this mix is still loading');
        const node = playContext.createBufferSource();
        node.buffer = src.buffer;
        node.connect(playContext.destination);
        node.start(when + clip.startMs / 1000, (clip.offsetMs || 0) / 1000, clip.durationMs / 1000);
      });
      status(voiceOnly ? 'Playing voice' : 'Playing mix');
    }

    async function loadLibraryVoice(id) {
      const clipId = Number(id);
      if (!clipId) return;
      const bytes = await host.loadClipBytes(clipId);
      const blob = new Blob([bytes]);
      const decoded = await decodeBlob(blob);
      const key = 'clip:' + clipId;
      await rememberSource(key, blob, decoded, { clipId: clipId });
      mix.setVoiceTake(session, key, decoded.durationMs);
      session.markerMs = Math.min(session.markerMs, decoded.durationMs);
      const sound = host.sounds().find(function (item) { return Number(item.id) === clipId; });
      const name = $('#edit-name');
      if (name && sound && !name.value.trim()) name.value = sound.name + ' mix';
      status('Loaded ' + (sound ? sound.name : 'clip'));
      redraw();
    }

    $('#rec-start').addEventListener('click', function () {
      startRecording('take').catch(function (err) {
        stopMeter();
        recording = false;
        $('#rec-start').disabled = false;
        $('#rec-stop').disabled = true;
        showError(err.name === 'NotAllowedError' ? 'Microphone permission was blocked.' : (err.message || 'Could not start recording'));
      });
    });
    const punchBtn = $('#rec-punch');
    if (punchBtn) {
      punchBtn.addEventListener('click', function () {
        startRecording('punch').catch(function (err) {
          stopMeter();
          recording = false;
          $('#rec-start').disabled = false;
          punchBtn.disabled = false;
          $('#rec-stop').disabled = true;
          showError(err.message || 'Could not punch in');
        });
      });
    }
    $('#rec-stop').addEventListener('click', function () {
      stopRecording().catch(function (err) { showError(err.message); });
    });
    $('#play-voice').addEventListener('click', function () {
      play(true).catch(function (err) { showError(err.message); });
    });
    $('#play-mix').addEventListener('click', function () {
      play(false).catch(function (err) { showError(err.message); });
    });
    $('#place-effect').addEventListener('click', function () {
      const effects = mix.effectsTrack(session);
      placeOn(effects.id).catch(function (err) { showError(err.message); });
    });
    $('#add-track').addEventListener('click', function () {
      try {
        mix.addExtraTrack(session);
        showError('');
        redraw();
      } catch (err) {
        showError(err.message);
      }
    });
    $('#edit-render').addEventListener('click', function () {
      const button = $('#edit-render');
      button.disabled = true;
      payloadFor(mix.mixClips(session, false)).then(function (payload) {
        payload.save = true;
        return host.saveMix(payload);
      }).then(function (sound) {
        status('Saved “' + (sound.name || 'mix') + '”');
        if (host.onSaved) return host.onSaved();
      }).catch(function (err) {
        showError(err.message || 'Could not save the mix');
      }).then(function () {
        button.disabled = mix.mixClips(session, false).length === 0;
      });
    });
    bindSelect(wave, 'voice');
    const deleteBtn = $('#delete-section');
    if (deleteBtn) {
      deleteBtn.addEventListener('click', function () {
        if (!selection || !(selection.endMs > selection.startMs)) {
          showError('Drag across a section of a track to select it.');
          return;
        }
        try {
          mix.deleteRange(session, selection.trackId, selection.startMs, selection.endMs);
          selection = null;
          showError('');
          redraw();
        } catch (err) {
          showError(err.message);
        }
      });
    }

    root.mithiumStopMixPreview = function () {
      if (playContext) {
        playContext.close().catch(function () {});
        playContext = null;
      }
    };
    root.mithiumLoadVoice = function (id) {
      loadLibraryVoice(id).catch(function (err) { showError(err.message); });
    };
    root.mithiumMixRefresh = fillClips;
    fillClips();
    redraw();
  }

  root.MithiumMixEditor = { mount: mountMixEditor };
})(typeof globalThis !== 'undefined' ? globalThis : this);
