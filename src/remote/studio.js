(function () {
  const $ = (sel) => document.querySelector(sel);
  const wave = $('#rec-wave');
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
  let takeBlob = null;
  let unsavedTake = false;
  let baseId = null;
  let inserts = [];
  let insertUid = 1;

  function state() {
    return window.mithiumRemoteState ? window.mithiumRemoteState() : { sounds: [], groups: [], showError, authHeaders: () => ({}), authToken: '' };
  }

  function sounds() { return state().sounds || []; }
  function groups() { return state().groups || []; }

  function showBox(el, message) {
    if (!el) return;
    if (!message) {
      el.textContent = '';
      el.classList.add('hidden');
      return;
    }
    el.textContent = message;
    el.classList.remove('hidden');
  }

  async function api(path, options) {
    const headers = state().authHeaders((options && options.headers) || {});
    const response = await fetch(path, { ...(options || {}), headers });
    const type = response.headers.get('content-type') || '';
    if (!response.ok) {
      let message = `Request failed (${response.status})`;
      if (type.includes('json')) {
        const data = await response.json().catch(() => ({}));
        message = data.error || message;
      }
      const error = new Error(message);
      error.offline = response.status === 503;
      throw error;
    }
    if (type.includes('json')) return response.json();
    return response.arrayBuffer();
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
    if (current) select.value = current;
  }

  function fillClips(select) {
    if (!select) return;
    const current = select.value;
    select.innerHTML = '<option value="">Choose a clip</option>';
    sounds().forEach((sound) => {
      const option = document.createElement('option');
      option.value = String(sound.id);
      option.textContent = sound.name;
      select.appendChild(option);
    });
    if (current) select.value = current;
  }

  function redraw() {
    draw(wave, peaks.length ? peaks : livePeaks, recording ? null : markerRatio);
    const at = durationMs ? Math.round(markerRatio * durationMs) : 0;
    $('#rec-marker').textContent = durationMs
      ? `Insert point ${window.MithiumEdit.formatMs(at)}. Tap the waveform to move it.`
      : 'Tap the waveform to choose an insert point.';
  }

  function activeBaseId() {
    if (baseId) return Number(baseId);
    if (unsavedTake) return 'take';
    return null;
  }

  function renderOrder() {
    const list = $('#edit-order');
    list.innerHTML = '';
    const editId = activeBaseId();
    if (!editId || !durationMs) {
      $('#edit-render').disabled = true;
      return;
    }
    let timeline = [];
    try {
      timeline = buildTimeline({ baseId: editId, baseDurationMs: durationMs, inserts });
    } catch (err) {
      showBox($('#edit-error'), err.message);
      $('#edit-render').disabled = true;
      return;
    }
    const names = { take: $('#rec-name').value.trim() || 'Voice' };
    sounds().forEach((sound) => { names[sound.id] = sound.name; });
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
      list.appendChild(li);
    });
    $('#edit-render').disabled = inserts.length === 0;
  }

  function stopMeter() {
    if (recordContext) recordContext.close().catch(() => {});
    recordContext = null;
    if (recordStream) recordStream.getTracks().forEach((track) => track.stop());
    recordStream = null;
  }

  async function startRecording() {
    showBox($('#rec-error'), '');
    if (!window.isSecureContext) {
      throw new Error('This browser blocks the microphone on plain HTTP. Open the secure remote link.');
    }
    recordStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    recordContext = new AudioContext();
    const source = recordContext.createMediaStreamSource(recordStream);
    const analyser = recordContext.createAnalyser();
    analyser.fftSize = 2048;
    source.connect(analyser);
    const mime = window.MediaRecorder && MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
      ? 'audio/webm;codecs=opus'
      : '';
    recorder = mime ? new MediaRecorder(recordStream, { mimeType: mime }) : new MediaRecorder(recordStream);
    recordChunks = [];
    livePeaks = [];
    peaks = [];
    durationMs = 0;
    takeBlob = null;
    unsavedTake = false;
    baseId = null;
    inserts = [];
    recorder.ondataavailable = (event) => {
      if (event.data && event.data.size) recordChunks.push(event.data);
    };
    recorder.start(200);
    recording = true;
    $('#rec-start').disabled = true;
    $('#rec-stop').disabled = false;
    $('#rec-save').disabled = true;
    $('#rec-status').textContent = 'Recording';
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
    takeBlob = blob;
    unsavedTake = true;
    const raw = await blob.arrayBuffer();
    try {
      const ctx = new AudioContext();
      const audio = await ctx.decodeAudioData(raw.slice(0));
      durationMs = Math.round(audio.duration * 1000);
      peaks = peaksFromAudio(audio, 160);
      await ctx.close();
    } catch (err) {
      peaks = livePeaks.slice();
      console.error(err);
    }
    if (!$('#rec-name').value.trim()) $('#rec-name').value = 'Voice take';
    $('#rec-save').disabled = false;
    $('#rec-status').textContent = durationMs ? `Stopped · ${window.MithiumEdit.formatMs(durationMs)}` : 'Stopped';
    redraw();
    renderOrder();
  }

  async function saveTake(opts) {
    if (!takeBlob) return null;
    const name = $('#rec-name').value.trim() || 'Voice take';
    const groupId = $('#rec-group').value || '';
    const params = new URLSearchParams({ name, durationMs: String(durationMs || '') });
    if (groupId) params.set('groupId', groupId);
    const data = await api(`/api/recordings?${params.toString()}`, {
      method: 'POST',
      headers: { 'Content-Type': takeBlob.type || 'audio/webm' },
      body: takeBlob,
    });
    unsavedTake = false;
    $('#rec-save').disabled = true;
    $('#rec-status').textContent = `Saved “${data.sound.name}”`;
    await loadBase(data.sound.id, { keepInserts: !!(opts && opts.keepInserts) });
    return data.sound;
  }

  async function loadBase(id, opts) {
    baseId = id ? Number(id) : null;
    if (!opts || !opts.keepInserts) inserts = [];
    fillClips($('#edit-base'));
    fillClips($('#edit-insert'));
    if (baseId) $('#edit-base').value = String(baseId);
    showBox($('#edit-error'), '');
    if (!baseId) {
      renderOrder();
      redraw();
      return;
    }
    const [raw, probe] = await Promise.all([
      api(`/api/sounds/${baseId}/audio`),
      api(`/api/sounds/${baseId}/probe`).catch(() => null),
    ]);
    try {
      const ctx = new AudioContext();
      const audio = await ctx.decodeAudioData(raw.slice(0));
      durationMs = Math.round(audio.duration * 1000);
      peaks = peaksFromAudio(audio, 160);
      await ctx.close();
    } catch (err) {
      peaks = [];
      durationMs = probe && probe.durationMs ? Math.round(probe.durationMs) : 0;
      if (!durationMs) throw err;
    }
    const match = sounds().find((sound) => Number(sound.id) === Number(baseId));
    if (match && !$('#edit-name').value.trim()) $('#edit-name').value = `${match.name} edit`;
    redraw();
    renderOrder();
  }

  function addInsert(placement) {
    const clipId = Number($('#edit-insert').value);
    if (!activeBaseId()) {
      showBox($('#edit-error'), 'Record a take or choose a clip to edit.');
      return;
    }
    if (!clipId) {
      showBox($('#edit-error'), 'Choose a clip to insert.');
      return;
    }
    if (!durationMs) {
      showBox($('#edit-error'), 'Clip length is unknown.');
      return;
    }
    showBox($('#edit-error'), '');
    inserts.push({
      uid: insertUid,
      clipId,
      placement,
      atMs: placement === 'at' ? Math.round(markerRatio * durationMs) : null,
    });
    insertUid += 1;
    renderOrder();
  }

  if (window.MithiumMixEditor) {
    window.MithiumMixEditor.mount({
      $: $,
      sounds: () => sounds(),
      showError: (message) => showBox($('#rec-error'), message),
      openMic: async () => {
        if (!window.isSecureContext) {
          throw new Error('This browser blocks the microphone on plain HTTP. Open the secure remote link.');
        }
        return navigator.mediaDevices.getUserMedia({ audio: true });
      },
      loadClipBytes: (id) => api(`/api/sounds/${id}/audio`),
      probeDuration: async (id) => (await api(`/api/sounds/${id}/probe`)).durationMs,
      groupId: () => ($('#edit-group').value ? Number($('#edit-group').value) : null),
      preferLocalPreview: () => !!(window.mithiumHearOnPhone && window.mithiumHearOnPhone()),
      uploadScratch: async (blob, mime) => {
        const data = await api('/api/edits/scratch', {
          method: 'POST',
          headers: { 'Content-Type': mime || blob.type || 'audio/webm' },
          body: blob,
        });
        return data.id;
      },
      playThroughWindows: (payload) => api('/api/edits/preview', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(Object.assign({ hearOnPhone: false }, payload)),
      }),
      saveMix: async (payload) => (await api('/api/edits/mix', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })).sound,
      onSaved: () => {},
      leaveEditor: () => {
        const tab = document.querySelector('.remote-tab[data-panel="board"]');
        if (tab) tab.click();
      },
    });
  }

  document.querySelectorAll('.remote-tab').forEach((button) => {
    button.addEventListener('click', () => {
      document.querySelectorAll('.remote-tab').forEach((tab) => tab.classList.remove('active'));
      button.classList.add('active');
      const panel = button.dataset.panel;
      $('#main').classList.toggle('hidden', panel !== 'board');
      $('#record-panel').classList.toggle('hidden', panel !== 'record');
      $('#openverse-panel').classList.toggle('hidden', panel !== 'openverse');
    });
  });

  window.mithiumRemoteEdit = (id) => {
    const tab = document.querySelector('.remote-tab[data-panel="record"]');
    if (tab) tab.click();
    if (window.mithiumLoadVoice) window.mithiumLoadVoice(id);
  };
  window.mithiumRemoteRefresh = () => {
    fillGroups($('#edit-group'));
    fillGroups($('#ov-group'));
    if (window.mithiumMixRefresh) window.mithiumMixRefresh();
  };

  let ovPage = 1;
  let ovPageCount = 1;

  async function runSearch(page) {
    showBox($('#ov-error'), '');
    $('#ov-note').textContent = 'Searching…';
    try {
      const data = await api(`/api/openverse/search?q=${encodeURIComponent($('#ov-query').value.trim())}&page=${page}`);
      ovPage = data.page || page;
      ovPageCount = data.pageCount || 1;
      const count = data.results && data.results.length;
      $('#ov-note').textContent = count
        ? 'Short sound effects'
        : (ovPage < ovPageCount ? 'No short sound effects on this page.' : 'No short sound effects.');
      renderResults(data.results || []);
      $('#ov-prev').classList.toggle('hidden', ovPage <= 1);
      $('#ov-next').classList.toggle('hidden', ovPage >= ovPageCount);
    } catch (err) {
      $('#ov-note').textContent = '';
      showBox($('#ov-error'), err.message || 'Openverse is unreachable.');
      renderResults([]);
    }
  }

  function renderResults(results) {
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
        link.target = '_blank';
        link.rel = 'noopener';
        link.textContent = 'Source';
        meta.appendChild(link);
      }
      const actions = document.createElement('div');
      actions.className = 'studio-inline';
      const preview = document.createElement('button');
      preview.type = 'button';
      preview.textContent = 'Preview';
      preview.addEventListener('click', () => previewResult(result.id).catch((err) => showBox($('#ov-error'), err.message)));
      const add = document.createElement('button');
      add.type = 'button';
      add.textContent = 'Add';
      add.addEventListener('click', () => importResult(result).catch((err) => showBox($('#ov-error'), err.message)));
      actions.appendChild(preview);
      actions.appendChild(add);
      card.appendChild(title);
      card.appendChild(meta);
      card.appendChild(actions);
      host.appendChild(card);
    });
  }

  async function previewResult(id) {
    if (window.mithiumHearOnPhone && window.mithiumHearOnPhone()) {
      const headers = state().authHeaders();
      const response = await fetch(`/api/openverse/preview/${encodeURIComponent(id)}`, { headers });
      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(data.error || 'Preview failed');
      }
      await window.mithiumPlayOnPhone(await response.blob());
      return;
    }
    if (window.mithiumStopPhonePlayback) window.mithiumStopPhonePlayback();
    await api(`/api/openverse/preview/${encodeURIComponent(id)}/play`, { method: 'POST' });
  }

  async function importResult(result) {
    const data = await api('/api/openverse/import', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: result.id,
        name: result.title,
        groupId: $('#ov-group').value || null,
      }),
    });
    $('#ov-note').textContent = `Added “${data.sound.name}” · ${data.sound.attribution_license || result.license}`;
  }

  $('#ov-search').addEventListener('click', () => runSearch(1));
  $('#ov-query').addEventListener('keydown', (event) => {
    if (event.key === 'Enter') runSearch(1);
  });
  $('#ov-prev').addEventListener('click', () => runSearch(Math.max(1, ovPage - 1)));
  $('#ov-next').addEventListener('click', () => runSearch(ovPage + 1));

  async function showSecureBanner() {
    if (window.isSecureContext) return;
    try {
      const data = await api('/api/status');
      const banner = $('#secure-banner');
      const urls = data.secureUrls || [];
      banner.classList.remove('hidden');
      if (!urls.length) {
        banner.textContent = 'This browser blocks the microphone on plain HTTP, and the secure remote port is not running.';
        return;
      }
      const token = state().authToken;
      const href = token ? `${urls[0]}?token=${encodeURIComponent(token)}` : urls[0];
      banner.textContent = 'Phone recording needs the secure link. Accept the certificate warning once. ';
      const link = document.createElement('a');
      link.href = href;
      link.textContent = href;
      banner.appendChild(link);
    } catch (err) {
      console.error(err);
    }
  }

  if (!window.MithiumMixEditor) redraw();
  window.mithiumRemoteRefresh();
  showSecureBanner();
})();
