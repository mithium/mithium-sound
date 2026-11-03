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
      const grabPanel = $('#grab-panel');
      if (grabPanel) grabPanel.classList.toggle('hidden', panel !== 'grab');
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
    fillGroups($('#grab-group'));
    if (window.mithiumMixRefresh) window.mithiumMixRefresh();
  };

  let ovPage = 1;
  let ovPageCount = 1;
  let ovResults = [];
  let ovSearched = false;

  function lengthCapMs() {
    const caps = window.MithiumLengthCap;
    const select = $('#ov-cap');
    return caps && select ? caps.capMs(select.value) : 30000;
  }

  function resultsForCap(results) {
    const caps = window.MithiumLengthCap;
    const cap = lengthCapMs();
    return (results || []).filter((result) => (caps ? caps.matches(result.durationMs, cap) : true));
  }

  async function runSearch(page) {
    showBox($('#ov-error'), '');
    $('#ov-note').textContent = 'Searching…';
    try {
      const data = await api(`/api/library/search?q=${encodeURIComponent($('#ov-query').value.trim())}&page=${page}`);
      ovPage = data.page || page;
      ovPageCount = data.pageCount || 1;
      ovResults = data.results || [];
      ovSearched = true;
      const visible = resultsForCap(ovResults);
      $('#ov-note').textContent = visible.length
        ? (lengthCapMs() === 10000 ? '10 seconds and under' : '30 seconds and under')
        : (ovPage < ovPageCount ? 'No short sound effects on this page.' : 'No short sound effects.');
      if (data.freesoundError) showBox($('#ov-error'), data.freesoundError);
      renderResults(visible);
      $('#ov-prev').classList.toggle('hidden', ovPage <= 1);
      $('#ov-next').classList.toggle('hidden', ovPage >= ovPageCount);
    } catch (err) {
      $('#ov-note').textContent = '';
      ovSearched = true;
      ovResults = [];
      showBox($('#ov-error'), err.message || 'Sound search is unreachable.');
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
      meta.textContent = `${result.source || 'MyInstants'} · ${result.creator} · ${result.license || 'License unknown'}`;
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
      preview.addEventListener('click', () => previewResult(result.id, card).catch((err) => showBox($('#ov-error'), err.message)));
      const add = document.createElement('button');
      add.type = 'button';
      add.textContent = 'Add';
      add.addEventListener('click', () => importResult(result).catch((err) => showBox($('#ov-error'), err.message)));
      const slot = document.createElement('div');
      slot.className = 'ov-preview';
      actions.appendChild(preview);
      actions.appendChild(add);
      card.appendChild(title);
      card.appendChild(meta);
      card.appendChild(actions);
      card.appendChild(slot);
      host.appendChild(card);
    });
  }

  async function previewResult(id, card) {
    const slot = card && card.querySelector('.ov-preview');
    if (slot) {
      slot.replaceChildren();
      const status = document.createElement('p');
      status.className = 'ov-preview-status';
      status.textContent = 'Loading preview…';
      slot.appendChild(status);
    }
    if (window.mithiumHearOnPhone && window.mithiumHearOnPhone()) {
      const headers = state().authHeaders();
      const response = await fetch(`/api/library/preview/${encodeURIComponent(id)}`, { headers });
      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(data.error || 'Preview failed');
      }
      const blob = await response.blob();
      if (slot) {
        slot.replaceChildren();
        const player = document.createElement('audio');
        player.controls = true;
        player.src = URL.createObjectURL(blob);
        slot.appendChild(player);
        try { await player.play(); } catch (err) { console.error(err); }
      } else if (window.mithiumPlayOnPhone) {
        await window.mithiumPlayOnPhone(blob);
      }
      return;
    }
    if (window.mithiumStopPhonePlayback) window.mithiumStopPhonePlayback();
    await api(`/api/library/preview/${encodeURIComponent(id)}/play`, { method: 'POST' });
    if (slot) {
      slot.replaceChildren();
      const status = document.createElement('p');
      status.className = 'ov-preview-status';
      status.textContent = 'Playing on the Windows PC.';
      slot.appendChild(status);
    }
  }

  async function importResult(result) {
    const data = await api('/api/library/import', {
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
  const ovCap = $('#ov-cap');
  if (ovCap) {
    ovCap.addEventListener('change', () => {
      if (!ovSearched) return;
      const visible = resultsForCap(ovResults);
      $('#ov-note').textContent = visible.length
        ? (lengthCapMs() === 10000 ? '10 seconds and under' : '30 seconds and under')
        : 'Nothing on this page matches that length.';
      renderResults(visible);
    });
  }

  let grabSkip = [];
  let grabRequest = '';
  let grabId = '';
  let grabMode = 'quick';

  async function playGrabPreview(preview) {
    grabId = preview.grabId;
    $('#grab-card').classList.remove('hidden');
    const slot = $('#grab-preview');
    slot.replaceChildren();
    if (window.mithiumHearOnPhone && window.mithiumHearOnPhone()) {
      const headers = state().authHeaders();
      const response = await fetch(`/api/grab/${encodeURIComponent(grabId)}/audio`, { headers });
      if (!response.ok) throw new Error('Preview failed');
      const blob = await response.blob();
      const player = document.createElement('audio');
      player.controls = true;
      player.src = URL.createObjectURL(blob);
      slot.appendChild(player);
      try { await player.play(); } catch (err) { console.error(err); }
    } else {
      if (window.mithiumStopPhonePlayback) window.mithiumStopPhonePlayback();
      await api(`/api/grab/${encodeURIComponent(grabId)}/play`, { method: 'POST' });
      const status = document.createElement('p');
      status.className = 'ov-preview-status';
      status.textContent = 'Playing on the Windows PC.';
      slot.appendChild(status);
    }
  }

  async function runGrab(skipIds) {
    showBox($('#grab-error'), '');
    const query = (skipIds && skipIds.length) ? grabRequest : $('#grab-query').value.trim();
    if (!query) {
      showBox($('#grab-error'), 'Type a sound to grab');
      return;
    }
    grabRequest = query;
    $('#grab-note').textContent = 'Searching YouTube for a short bite…';
    const preview = await api('/api/grab', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, skipIds: skipIds || [] }),
    });
    grabMode = 'quick';
    const nudge = $('#grab-nudge');
    if (nudge) nudge.classList.add('hidden');
    grabSkip = (skipIds || []).concat(preview.videoId ? [preview.videoId] : []);
    $('#grab-title').textContent = preview.title || query;
    $('#grab-meta').textContent = [preview.lengthLabel, preview.shapedQuery].filter(Boolean).join(' · ');
    await playGrabPreview(preview);
    $('#grab-note').textContent = 'Preview is under the result. Save it, or try another match.';
  }

  async function runSmart(extra) {
    const body = extra || {};
    showBox($('#grab-error'), '');
    const query = body.another || body.nudge ? grabRequest : $('#grab-query').value.trim();
    if (!query) {
      showBox($('#grab-error'), 'Type a sound to grab');
      return;
    }
    grabRequest = query;
    $('#grab-note').textContent = body.nudge
      ? 'Cutting that section again…'
      : (body.another ? 'Trying the next moment…' : 'Finding that moment…');
    const preview = await api('/api/grab', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        mode: 'smart',
        query,
        grabId: body.another || body.nudge ? grabId : '',
        another: !!body.another,
        nudge: body.nudge || '',
      }),
    });
    grabMode = 'smart';
    const nudge = $('#grab-nudge');
    if (nudge) nudge.classList.remove('hidden');
    $('#grab-title').textContent = preview.title || query;
    $('#grab-meta').textContent = [preview.rangeLabel, preview.lengthLabel, preview.viaLabel].filter(Boolean).join(' · ');
    await playGrabPreview(preview);
    const when = preview.startLabel || 'the chosen time';
    $('#grab-note').textContent = `Starts at ${when} in “${preview.title || 'the video'}”. Save it, nudge the cut, or try another.`;
  }

  $('#grab-go').addEventListener('click', () => {
    grabSkip = [];
    runGrab([]).catch((err) => showBox($('#grab-error'), err.message));
  });
  const grabSmart = $('#grab-smart');
  if (grabSmart) {
    grabSmart.addEventListener('click', () => {
      runSmart({}).catch((err) => showBox($('#grab-error'), err.message));
    });
  }
  $('#grab-another').addEventListener('click', () => {
    const run = grabMode === 'smart' ? runSmart({ another: true }) : runGrab(grabSkip);
    Promise.resolve(run).catch((err) => showBox($('#grab-error'), err.message));
  });
  ['earlier', 'later', 'shorter', 'longer'].forEach((direction) => {
    const button = $(`#grab-${direction}`);
    if (!button) return;
    button.addEventListener('click', () => {
      runSmart({ nudge: direction }).catch((err) => showBox($('#grab-error'), err.message));
    });
  });
  $('#grab-save').addEventListener('click', async () => {
    if (!grabId) return;
    try {
      const data = await api(`/api/grab/${encodeURIComponent(grabId)}/save`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: grabRequest,
          groupId: $('#grab-group').value || null,
        }),
      });
      $('#grab-note').textContent = `Saved “${data.sound.name}”.`;
    } catch (err) {
      showBox($('#grab-error'), err.message || 'Could not save that sound.');
    }
  });

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
