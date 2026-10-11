// Match a saved Windows playback or recording device after a restart.
// Chromium/Electron device ids are only stable once media permission sticks,
// and they can still change between sessions. The id is tried first. The
// device label is the fallback, and a missing device must not be overwritten
// with the system default.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.MithiumAudioDevices = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  var attempts = typeof WeakSet === 'function' ? new WeakSet() : null;
  var pending = null;

  function usableLabel(label) {
    var text = String(label || '').replace(/\s+/g, ' ').trim();
    if (!text) return '';
    if (/^device(?:\s+[0-9a-f]{1,12})?(?:\s*\.{3})?$/i.test(text)) return '';
    if (/^microphone\s+\d+$/i.test(text)) return '';
    return text;
  }

  function normalizeLabel(label) {
    return usableLabel(label).toLowerCase();
  }

  function coreLabel(label) {
    return normalizeLabel(label).replace(/^(?:default|communications)\s*-\s*/, '');
  }

  function isConcreteDevice(device) {
    if (!device || !device.deviceId) return false;
    if (device.deviceId === 'default' || device.deviceId === 'communications') return false;
    return true;
  }

  function realDevices(devices, kind) {
    return (devices || []).filter(function (device) {
      return device && device.kind === kind && isConcreteDevice(device);
    });
  }

  function needsLabelUnlock(devices) {
    var inputs = realDevices(devices, 'audioinput');
    var outputs = realDevices(devices, 'audiooutput');
    if (!inputs.length && !outputs.length) {
      return (devices || []).some(function (device) {
        return device && (device.kind === 'audioinput' || device.kind === 'audiooutput');
      });
    }
    return inputs.concat(outputs).some(function (device) {
      return !usableLabel(device.label);
    });
  }

  function outputsNeedLabel(devices) {
    var outputs = realDevices(devices, 'audiooutput');
    if (!outputs.length) return false;
    return outputs.some(function (device) { return !usableLabel(device.label); });
  }

  function missingNote(label, kind) {
    var name = usableLabel(label);
    if (kind === 'input') {
      return name
        ? '“' + name + '” is not connected. Recording is using the default microphone until that device is back.'
        : 'The saved microphone is not available. Recording is using the default microphone until it is back.';
    }
    return name
      ? '“' + name + '” is not connected. Playback is using the system default until that device is back.'
      : 'The saved output device is not available. Playback is using the system default until it is back.';
  }

  function preferConcrete(matches) {
    return matches.find(isConcreteDevice) || null;
  }

  function labelMatches(devices, savedLabel, loose) {
    var wanted = loose ? coreLabel(savedLabel) : normalizeLabel(savedLabel);
    if (!wanted) return null;
    var matches = (devices || []).filter(function (device) {
      if (!isConcreteDevice(device)) return false;
      var current = loose ? coreLabel(device.label) : normalizeLabel(device.label);
      return current && current === wanted;
    });
    return preferConcrete(matches);
  }

  function resolveSavedDevice(devices, saved, kind) {
    var list = Array.isArray(devices) ? devices : [];
    var savedId = saved && saved.deviceId != null ? String(saved.deviceId) : '';
    var savedLabel = usableLabel(saved && saved.label);

    if ((!savedId || savedId === 'default') && !savedLabel) {
      return {
        status: 'default',
        activeDeviceId: 'default',
        saved: { deviceId: 'default', label: '' },
        note: '',
        persist: false,
      };
    }

    var byId = savedId && savedId !== 'default'
      ? list.find(function (device) { return device && device.deviceId === savedId; })
      : null;
    if (byId) {
      var idLabel = usableLabel(byId.label) || savedLabel;
      var idSaved = { deviceId: byId.deviceId, label: idLabel };
      return {
        status: 'matched',
        activeDeviceId: byId.deviceId,
        saved: idSaved,
        note: '',
        persist: idSaved.deviceId !== savedId || normalizeLabel(idLabel) !== normalizeLabel(saved && saved.label),
      };
    }

    var byLabel = savedLabel ? (labelMatches(list, savedLabel, false) || labelMatches(list, savedLabel, true)) : null;
    if (byLabel) {
      var nextLabel = usableLabel(byLabel.label) || savedLabel;
      return {
        status: 'matched',
        activeDeviceId: byLabel.deviceId,
        saved: { deviceId: byLabel.deviceId, label: nextLabel },
        note: '',
        persist: true,
      };
    }

    if (!savedId || savedId === 'default') {
      return {
        status: 'default',
        activeDeviceId: 'default',
        saved: { deviceId: 'default', label: '' },
        note: '',
        persist: false,
      };
    }

    return {
      status: 'missing',
      activeDeviceId: 'default',
      saved: { deviceId: savedId, label: savedLabel },
      note: missingNote(savedLabel, kind),
      persist: false,
    };
  }

  function choiceFromOption(deviceId, label) {
    var id = deviceId ? String(deviceId) : '';
    if (!id || id === 'default') return { deviceId: 'default', label: '' };
    return { deviceId: id, label: usableLabel(label) };
  }

  function sinkIdFor(deviceId) {
    if (!deviceId || deviceId === 'default') return '';
    return String(deviceId);
  }

  function tried(mediaDevices) {
    return !!(attempts && mediaDevices && attempts.has(mediaDevices));
  }

  function mark(mediaDevices) {
    if (attempts && mediaDevices) attempts.add(mediaDevices);
  }

  function listDevices(mediaDevices, opts) {
    if (!mediaDevices || typeof mediaDevices.enumerateDevices !== 'function') {
      return Promise.resolve([]);
    }
    var force = !!(opts && opts.force);
    if (pending && !force) return pending;
    var run = listOnce(mediaDevices, force).then(function (devices) {
      return devices || [];
    }, function () {
      return [];
    });
    var tracked = run.finally(function () {
      if (pending === tracked) pending = null;
    });
    pending = tracked;
    return tracked;
  }

  function listOnce(mediaDevices, force) {
    return mediaDevices.enumerateDevices().then(function (first) {
      var devices = first || [];
      if (!needsLabelUnlock(devices)) return devices;
      if (!force && tried(mediaDevices)) return devices;
      if (typeof mediaDevices.getUserMedia !== 'function') return devices;
      mark(mediaDevices);
      return mediaDevices.getUserMedia({ audio: true }).then(function (stream) {
        var tracks = stream && stream.getTracks ? stream.getTracks() : [];
        tracks.forEach(function (track) {
          if (track && track.stop) track.stop();
        });
        return mediaDevices.enumerateDevices().then(function (second) {
          return second || devices;
        });
      }, function () {
        return devices;
      });
    });
  }

  return {
    usableLabel: usableLabel,
    normalizeLabel: normalizeLabel,
    needsLabelUnlock: needsLabelUnlock,
    outputsNeedLabel: outputsNeedLabel,
    resolveSavedDevice: resolveSavedDevice,
    choiceFromOption: choiceFromOption,
    sinkIdFor: sinkIdFor,
    missingNote: missingNote,
    listDevices: listDevices,
  };
});
