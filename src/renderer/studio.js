function startDesktopStudio() {
  const $ = (sel) => document.querySelector(sel);
  const wave = $('#rec-wave');
  const deviceSelect = $('#rec-device');
  const statusEl = $('#rec-status');
  const errorEl = $('#rec-error');
  const editError = $('#edit-error');
  const markerLabel = $('#rec-marker');
  const orderList = $('#edit-order');
  if (!wave || !window.MithiumWave || !window.MithiumEdit) return;

  const draw = window.MithiumWave.drawWaveform;
  const peaksFromAudio = window.MithiumWave.peaksFromAudioBuffer;
  const peakFromTime = window.MithiumWave.peakFromTimeDomain;
  const buildTimeline = window.MithiumEdit.buildEditTimeline;
  const describe = window.MithiumEdit.describeTimeline;

  let recording = false;
  let recorder = null;
  let recordStream = null;
  let recordContext = null;
  let recordChunks = [];
  let livePeaks = [];
  let peaks = [];
  let markerRatio = 0.5;
  let durationMs = 0;
  let takeBytes = null;
  let takeMime = '';
  let savedTakeId = null;
  let unsavedTake = false;
  let baseId = null;
  let inserts = [];
  let insertUid = 1;
  let drawing = false;

  function showError(el, message) {
    if (!el) return;
    if (!message) {
      el.textContent = '';
      el.classList.add('hidden');
      return;
    }
    el.textContent = message;
    el.classList.remove('hidden');
  }

  function sounds() {
    return window.mithiumSounds ? window.mithiumSounds() : [];
  }

  function groups() {
    return window.mithiumGroups ? window.mithiumGroups() : [];
  }

  function fillGroups(select) {
    if (!select) return;
    const current = select.value;
    select.innerHTML = '<option value="">Ungrouped</option>';
    groups().forEach((group) => {
      const option = document.createElement('option');
      option.value = String(group.id);
      option.textContent = group.name;
      select.appendChild(option);
    });
    if (current && Array.from(select.options).some((opt) => opt.value === current)) {
      select.value = current;
    }
  }

  function fillClipSelect(select, includeBlank) {
    if (!select) return;
    const current = select.value;
    select.innerHTML = '';
    if (includeBlank) {
      const blank = document.createElement('option');
      blank.value = '';
      blank.textContent = 'Choose a clip';
      select.appendChild(blank);
    }
    sounds().forEach((sound) => {
      const option = document.createElement('option');
      option.value = String(sound.id);
      option.textContent = sound.name;
      select.appendChild(option);
    });
    if (current && Array.from(select.options).some((opt) => opt.value === current)) {
      select.value = current;
    }
  }

  function redraw() {
    draw(wave, peaks.length ? peaks : livePeaks, recording ? null : markerRatio);
    const at = durationMs ? Math.round(markerRatio * durationMs) : 0;
    markerLabel.textContent = durationMs
      ? `Insert point ${window.MithiumEdit.formatMs(at)}. Click the waveform to move it.`
      : 'Click the waveform to choose an insert point.';
  }

  function nameOf(id) {
    const sound = sounds().find((item) => Number(item.id) === Number(id));
    return sound ? sound.name : 'Clip';
  }

  function activeBaseId() {
    if (baseId) return Number(baseId);
    if (unsavedTake) return 'take';
    return null;
  }

  function renderOrder() {
    orderList.innerHTML = '';
    const editId = activeBaseId();
    if (!editId || !durationMs) {
      $('#edit-render').disabled = true;
      return;
    }
    let timeline = [];
    try {
      timeline = buildTimeline({ baseId: editId, baseDurationMs: durationMs, inserts });
    } catch (err) {
      showError(editError, err.message);
      $('#edit-render').disabled = true;
      return;
    }
    const names = {};
    sounds().forEach((sound) => { names[sound.id] = sound.name; });
    names.take = $('#rec-name').value.trim() || 'Voice';
    describe(timeline, names, editId).forEach((row) => {
      const li = document.createElement('li');
      const label = document.createElement('span');
      label.textContent = row.label;
      li.appendChild(label);
      if (row.uid) {
        const remove = document.createElement('button');
        remove.type = 'button';
        remove.textContent = 'Remove';
        remove.addEventListener('click', () => {
          inserts = inserts.filter((item) => item.uid !== row.uid);
          renderOrder();
        });
        li.appendChild(remove);
      }
      orderList.appendChild(li);
    });
    $('#edit-render').disabled = inserts.length === 0;
  }

  async function enumerateInputs() {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const inputs = devices.filter((device) => device.kind === 'audioinput');
    const settings = await window.api.settingsGet();
    const saved = settings.recordDeviceId || '';
    deviceSelect.innerHTML = '';
    if (!inputs.length) {
      const option = document.createElement('option');
      option.value = '';
      option.textContent = 'No microphone found';
      deviceSelect.appendChild(option);
      return;
    }
    inputs.forEach((device, index) => {
      const option = document.createElement('option');
      option.value = device.deviceId;
      option.textContent = device.label || `Microphone ${index + 1}`;
      deviceSelect.appendChild(option);
    });
    if (saved && Array.from(deviceSelect.options).some((opt) => opt.value === saved)) {
      deviceSelect.value = saved;
    }
  }

  async function listInputs() {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      stream.getTracks().forEach((track) => track.stop());
    } catch (err) {
      showError(errorEl, err.name === 'NotAllowedError'
        ? 'Microphone permission was blocked.'
        : `Could not open a microphone: ${err.message}`);
    }
    await enumerateInputs();
  }

  async function rememberDevice() {
    const id = deviceSelect.value || '';
    if (!id) return;
    await window.api.settingsSave({ recordDeviceId: id });
  }

  function stopMeter() {
    if (recordContext) {
      recordContext.close().catch(() => {});
      recordContext = null;
    }
    if (recordStream) {
      recordStream.getTracks().forEach((track) => track.stop());
      recordStream = null;
    }
  }

  async function startRecording() {
    showError(errorEl, '');
    await rememberDevice();
    const deviceId = deviceSelect.value;
    const audio = deviceId ? { deviceId: { exact: deviceId } } : true;
    try {
      recordStream = await navigator.mediaDevices.getUserMedia({ audio });
    } catch (err) {
      if (!deviceId || (err.name !== 'OverconstrainedError' && err.name !== 'NotFoundError')) throw err;
      recordStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    }
    await enumerateInputs();
    recordContext = new AudioContext();
    const source = recordContext.createMediaStreamSource(recordStream);
    const analyser = recordContext.createAnalyser();
    analyser.fftSize = 2048;
    source.connect(analyser);
    const mime = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
      ? 'audio/webm;codecs=opus'
      : (MediaRecorder.isTypeSupported('audio/webm') ? 'audio/webm' : '');
    recorder = mime ? new MediaRecorder(recordStream, { mimeType: mime }) : new MediaRecorder(recordStream);
    recordChunks = [];
    livePeaks = [];
    peaks = [];
    durationMs = 0;
    takeBytes = null;
    savedTakeId = null;
    unsavedTake = false;
    baseId = null;
    inserts = [];
    renderOrder();
    recorder.ondataavailable = (event) => {
      if (event.data && event.data.size) recordChunks.push(event.data);
    };
    recorder.start(200);
    recording = true;
    $('#rec-start').disabled = true;
    $('#rec-stop').disabled = false;
    $('#rec-save').disabled = true;
    statusEl.textContent = 'Recording';
    const timeBuf = new Uint8Array(analyser.fftSize);
    let last = 0;
    const tick = (now) => {
      if (!recording) return;
      if (now - last > 50) {
        analyser.getByteTimeDomainData(timeBuf);
        livePeaks.push(peakFromTime(timeBuf));
        if (livePeaks.length > 600) livePeaks.shift();
        peaks = livePeaks.slice();
        last = now;
        redraw();
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }

  function finishTake(blob) {
    takeMime = blob.type || 'audio/webm';
    blob.arrayBuffer().then(async (raw) => {
      takeBytes = new Uint8Array(raw);
      try {
        const ctx = new AudioContext();
        const audio = await ctx.decodeAudioData(raw.slice(0));
        durationMs = Math.round(audio.duration * 1000);
        peaks = peaksFromAudio(audio, 180);
        await ctx.close();
      } catch (err) {
        console.error('Could not decode the take:', err);
        peaks = livePeaks.slice();
      }
      recording = false;
      redraw();
      statusEl.textContent = durationMs
        ? `Stopped · ${window.MithiumEdit.formatMs(durationMs)}`
        : 'Stopped';
      $('#rec-save').disabled = !takeBytes;
      unsavedTake = !!takeBytes;
      if (!$('#rec-name').value.trim()) $('#rec-name').value = 'Voice take';
      renderOrder();
    }).catch((err) => {
      showError(errorEl, err.message);
    });
  }

  async function stopRecording() {
    if (!recorder || recorder.state === 'inactive') return;
    recording = false;
    const blob = await new Promise((resolve) => {
      recorder.addEventListener('stop', () => {
        resolve(new Blob(recordChunks, { type: recorder.mimeType || 'audio/webm' }));
      }, { once: true });
      recorder.stop();
    });
    stopMeter();
    $('#rec-start').disabled = false;
    $('#rec-stop').disabled = true;
    finishTake(blob);
  }

  async function saveTake(opts) {
    if (!takeBytes) return null;
    showError(errorEl, '');
    const sound = await window.api.soundSaveRecording({
      name: $('#rec-name').value.trim() || 'Voice take',
      groupId: $('#rec-group').value || null,
      mime: takeMime,
      bytes: takeBytes,
      durationMs,
    });
    savedTakeId = sound.id;
    unsavedTake = false;
    if (window.mithiumRefresh) await window.mithiumRefresh();
    await loadBase(sound.id, { keepInserts: !!(opts && opts.keepInserts) });
    statusEl.textContent = `Saved “${sound.name}”`;
    $('#rec-save').disabled = true;
    return sound;
  }

  async function loadBase(id, opts) {
    baseId = id ? Number(id) : null;
    if (!opts || !opts.keepInserts) inserts = [];
    fillClipSelect($('#edit-base'), true);
    fillClipSelect($('#edit-insert'), true);
    if (baseId) $('#edit-base').value = String(baseId);
    showError(editError, '');
    if (!baseId) {
      durationMs = savedTakeId ? durationMs : 0;
      renderOrder();
      redraw();
      return;
    }
    try {
      const [audio, probe] = await Promise.all([
        window.api.soundRead(baseId),
        window.api.clipProbe(baseId).catch(() => null),
      ]);
      const raw = audio.bytes.buffer.slice(audio.bytes.byteOffset, audio.bytes.byteOffset + audio.bytes.byteLength);
      try {
        const ctx = new AudioContext();
        const decoded = await ctx.decodeAudioData(raw.slice(0));
        durationMs = Math.round(decoded.duration * 1000);
        peaks = peaksFromAudio(decoded, 180);
        await ctx.close();
      } catch (err) {
        peaks = [];
        durationMs = probe && probe.durationMs ? Math.round(probe.durationMs) : 0;
        if (!durationMs) throw err;
      }
      if (!$('#edit-name').value.trim()) $('#edit-name').value = `${nameOf(baseId)} edit`;
      redraw();
      renderOrder();
    } catch (err) {
      showError(editError, err.message || 'Could not load that clip');
    }
  }

  function addInsert(placement) {
    const clipId = Number($('#edit-insert').value);
    if (!activeBaseId()) {
      showError(editError, 'Record a take or choose a clip to edit.');
      return;
    }
    if (!clipId) {
      showError(editError, 'Choose a clip to insert.');
      return;
    }
    if (!durationMs) {
      showError(editError, 'Clip length is unknown.');
      return;
    }
    showError(editError, '');
    inserts.push({
      uid: insertUid,
      clipId,
      placement,
      atMs: placement === 'at' ? Math.round(markerRatio * durationMs) : null,
    });
    insertUid += 1;
    renderOrder();
  }

  $('#rec-refresh').addEventListener('click', () => {
    listInputs().catch((err) => showError(errorEl, err.message));
  });
  deviceSelect.addEventListener('change', () => {
    rememberDevice().catch((err) => console.error(err));
  });
  if (window.MithiumMixEditor) {
    window.MithiumMixEditor.mount({
      $: $,
      sounds: () => sounds(),
      showError: (message) => showError(errorEl, message),
      openMic: async () => {
        await rememberDevice();
        const deviceId = deviceSelect.value;
        const audio = deviceId ? { deviceId: { exact: deviceId } } : true;
        try {
          const stream = await navigator.mediaDevices.getUserMedia({ audio });
          await enumerateInputs();
          return stream;
        } catch (err) {
          if (!deviceId || (err.name !== 'OverconstrainedError' && err.name !== 'NotFoundError')) throw err;
          return navigator.mediaDevices.getUserMedia({ audio: true });
        }
      },
      loadClipBytes: async (id) => {
        const audio = await window.api.soundRead(id);
        return audio.bytes.buffer.slice(audio.bytes.byteOffset, audio.bytes.byteOffset + audio.bytes.byteLength);
      },
      probeDuration: async (id) => (await window.api.clipProbe(id)).durationMs,
      groupId: () => ($('#edit-group').value ? Number($('#edit-group').value) : null),
      preferLocalPreview: () => true,
      prepareContext: async (ctx) => {
        const settings = await window.api.settingsGet();
        if (settings.selectedDeviceId && settings.selectedDeviceId !== 'default' && ctx.setSinkId) {
          try { await ctx.setSinkId(settings.selectedDeviceId); } catch (err) { console.error(err); }
        }
      },
      saveMix: async (payload) => (await window.api.clipMix(payload)).sound,
      onSaved: async () => { if (window.mithiumRefresh) await window.mithiumRefresh(); },
      playThroughWindows: async () => {},
      leaveEditor: () => {
        const tab = document.querySelector('.tab[data-tab="sounds"]');
        if (tab) tab.click();
      },
    });
  }

  let ovPage = 1;
  let ovPageCount = 1;
  let ovAudioUrl = null;
  let ovPlayer = null;
  let ovResults = [];
  let ovSearched = false;

  function lengthCapMs() {
    const caps = window.MithiumLengthCap;
    return caps ? caps.capMs($('#ov-cap').value) : 30000;
  }

  function lengthCapLabel() {
    return lengthCapMs() === 10000 ? '10 seconds and under' : '30 seconds and under';
  }

  function resultsForCap(results) {
    const caps = window.MithiumLengthCap;
    const cap = lengthCapMs();
    return (results || []).filter((result) => (caps ? caps.matches(result.durationMs, cap) : true));
  }

  function showCappedResults() {
    const visible = resultsForCap(ovResults);
    const label = lengthCapLabel();
    if (visible.length) {
      $('#ov-note').textContent = label;
    } else if (ovResults.length) {
      $('#ov-note').textContent = ovPage < ovPageCount
        ? `Nothing on this page is ${label}.`
        : `No results are ${label}.`;
    } else {
      $('#ov-note').textContent = ovPage < ovPageCount
        ? 'No short sound effects on this page.'
        : 'No short sound effects.';
    }
    renderOpenverse(visible);
  }

  function previewPlayer() {
    if (!ovPlayer) {
      ovPlayer = document.createElement('audio');
      ovPlayer.id = 'ov-player';
      ovPlayer.className = 'ov-player hidden';
      ovPlayer.controls = true;
      ovPlayer.preload = 'none';
    }
    return ovPlayer;
  }

  function clearPreview() {
    if (!ovPlayer) return;
    ovPlayer.pause();
    ovPlayer.classList.add('hidden');
    if (ovPlayer.parentNode) ovPlayer.parentNode.removeChild(ovPlayer);
  }

  function selectedGroup(id) {
    const value = $(id).value;
    return value ? Number(value) : null;
  }

  async function runSearch(page) {
    showError($('#ov-error'), '');
    $('#ov-note').textContent = 'Searching…';
    try {
      const data = await window.api.openverseSearch($('#ov-query').value.trim(), page);
      ovPage = data.page || page;
      ovPageCount = data.pageCount || 1;
      ovSearched = true;
      ovResults = data.results || [];
      showCappedResults();
      $('#ov-prev').classList.toggle('hidden', ovPage <= 1);
      $('#ov-next').classList.toggle('hidden', ovPage >= ovPageCount);
    } catch (err) {
      $('#ov-note').textContent = '';
      ovSearched = true;
      ovResults = [];
      showError($('#ov-error'), err.message || 'Openverse is unreachable. Recording and the soundboard still work offline.');
      renderOpenverse([]);
    }
  }

  function renderOpenverse(results) {
    clearPreview();
    const host = $('#ov-results');
    host.innerHTML = '';
    results.forEach((result) => {
      const card = document.createElement('article');
      card.className = 'ov-card';
      const title = document.createElement('h3');
      title.textContent = result.title;
      const meta = document.createElement('p');
      meta.className = 'ov-meta';
      meta.textContent = `${result.creator} · ${result.license || 'License unknown'}`;
      if (result.lengthLabel) {
        meta.appendChild(document.createTextNode(' · '));
        const length = document.createElement('span');
        length.className = 'ov-length';
        length.textContent = result.lengthLabel;
        meta.appendChild(length);
      }
      if (result.sourceUrl) {
        meta.appendChild(document.createTextNode(' · '));
        const link = document.createElement('a');
        link.href = result.sourceUrl;
        link.textContent = 'Source';
        link.addEventListener('click', (event) => {
          event.preventDefault();
          window.api.openExternal(result.sourceUrl);
        });
        meta.appendChild(link);
      }
      const actions = document.createElement('div');
      actions.className = 'studio-inline';
      const preview = document.createElement('button');
      preview.type = 'button';
      preview.textContent = 'Preview';
      preview.addEventListener('click', () => previewResult(result.id, card));
      const add = document.createElement('button');
      add.type = 'button';
      add.textContent = 'Add to soundboard';
      add.addEventListener('click', () => importResult(result));
      actions.appendChild(preview);
      actions.appendChild(add);
      const slot = document.createElement('div');
      slot.className = 'ov-preview';
      card.appendChild(title);
      card.appendChild(meta);
      card.appendChild(actions);
      card.appendChild(slot);
      host.appendChild(card);
    });
  }

  async function previewResult(id, card) {
    showError($('#ov-error'), '');
    const slot = card && card.querySelector('.ov-preview');
    if (!slot) return;
    const player = previewPlayer();
    player.pause();
    player.classList.add('hidden');
    if (player.parentNode) player.parentNode.removeChild(player);
    document.querySelectorAll('#ov-results .ov-preview').forEach((node) => {
      if (node !== slot) node.replaceChildren();
    });
    slot.replaceChildren();
    const status = document.createElement('p');
    status.className = 'ov-preview-status';
    status.textContent = 'Loading preview…';
    slot.appendChild(status);
    slot.appendChild(player);
    try {
      const preview = await window.api.openversePreview(id);
      const bytes = preview.bytes;
      const raw = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
      const blob = new Blob([raw], { type: preview.mime || 'audio/mpeg' });
      if (ovAudioUrl) URL.revokeObjectURL(ovAudioUrl);
      ovAudioUrl = URL.createObjectURL(blob);
      if (!slot.isConnected || player.parentNode !== slot) return;
      player.src = ovAudioUrl;
      player.classList.remove('hidden');
      status.remove();
      try {
        await player.play();
      } catch (err) {
        console.error(err);
      }
    } catch (err) {
      player.pause();
      player.classList.add('hidden');
      if (player.parentNode) player.parentNode.removeChild(player);
      if (status.isConnected) status.remove();
      showError($('#ov-error'), err.message || 'Openverse is unreachable. Recording and the soundboard still work offline.');
    }
  }

  async function importResult(result) {
    showError($('#ov-error'), '');
    const sound = await window.api.openverseImport({
      id: result.id,
      name: result.title,
      groupId: selectedGroup('#ov-group'),
    });
    if (window.mithiumRefresh) await window.mithiumRefresh();
    $('#ov-note').textContent = `Added “${sound.name}” · ${sound.attribution_license || result.license}`;
  }

  $('#ov-search').addEventListener('click', () => {
    runSearch(1).catch((err) => showError($('#ov-error'), err.message));
  });
  $('#ov-query').addEventListener('keydown', (event) => {
    if (event.key === 'Enter') runSearch(1).catch((err) => showError($('#ov-error'), err.message));
  });
  $('#ov-prev').addEventListener('click', () => runSearch(Math.max(1, ovPage - 1)));
  $('#ov-next').addEventListener('click', () => runSearch(ovPage + 1));
  $('#ov-cap').addEventListener('change', () => {
    if (!ovSearched) return;
    showCappedResults();
  });

  window.mithiumEditClip = (id) => {
    const tab = document.querySelector('.tab[data-tab="record"]');
    if (tab) tab.click();
    if (window.mithiumLoadVoice) window.mithiumLoadVoice(id);
  };
  window.mithiumStudioRefresh = () => {
    fillGroups($('#edit-group'));
    fillGroups($('#ov-group'));
    if (window.mithiumMixRefresh) window.mithiumMixRefresh();
  };

  if (!window.MithiumMixEditor) redraw();
  enumerateInputs().catch((err) => showError(errorEl, err.message));
  window.mithiumStudioRefresh();
}
