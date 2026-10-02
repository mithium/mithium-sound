// Canvas waveform for live recording and the clip shown after stop.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.MithiumWave = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  function fitCanvas(canvas) {
    const rect = canvas.getBoundingClientRect();
    const dpr = (typeof window !== 'undefined' && window.devicePixelRatio) || 1;
    const width = Math.max(1, Math.floor((rect.width || canvas.clientWidth || 300) * dpr));
    const height = Math.max(1, Math.floor((rect.height || 140) * dpr));
    if (canvas.width !== width) canvas.width = width;
    if (canvas.height !== height) canvas.height = height;
  }

  function drawWaveform(canvas, peaks, markerRatio) {
    fitCanvas(canvas);
    const ctx = canvas.getContext('2d');
    const width = canvas.width;
    const height = canvas.height;
    ctx.clearRect(0, 0, width, height);
    ctx.fillStyle = '#181825';
    ctx.fillRect(0, 0, width, height);
    const mid = height / 2;
    ctx.strokeStyle = 'rgba(205, 214, 244, 0.18)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, mid);
    ctx.lineTo(width, mid);
    ctx.stroke();

    const data = peaks && peaks.length ? peaks : [0];
    const slot = width / data.length;
    ctx.fillStyle = '#89b4fa';
    for (let i = 0; i < data.length; i += 1) {
      const amp = Math.max(0, Math.min(1, Number(data[i]) || 0));
      const bar = Math.max(1, amp * (height - 8));
      const x = i * slot;
      ctx.fillRect(x, mid - bar / 2, Math.max(1, slot - 1), bar);
    }

    if (markerRatio != null && Number.isFinite(Number(markerRatio))) {
      const x = Math.max(0, Math.min(1, Number(markerRatio))) * width;
      ctx.strokeStyle = '#f9e2af';
      ctx.lineWidth = Math.max(2, Math.round(width / 400));
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, height);
      ctx.stroke();
    }
  }

  function peakFromTimeDomain(buffer) {
    let peak = 0;
    for (let i = 0; i < buffer.length; i += 1) {
      const value = Math.abs(buffer[i] - 128) / 128;
      if (value > peak) peak = value;
    }
    return peak;
  }

  function peaksFromAudioBuffer(audioBuffer, buckets) {
    const count = Math.max(32, buckets || 160);
    const channel = audioBuffer.getChannelData(0);
    const size = Math.max(1, Math.floor(channel.length / count));
    const peaks = [];
    for (let i = 0; i < count; i += 1) {
      let peak = 0;
      const start = i * size;
      const end = Math.min(channel.length, start + size);
      for (let s = start; s < end; s += 1) {
        const value = Math.abs(channel[s]);
        if (value > peak) peak = value;
      }
      peaks.push(peak);
    }
    return peaks;
  }

  return {
    fitCanvas: fitCanvas,
    drawWaveform: drawWaveform,
    peakFromTimeDomain: peakFromTimeDomain,
    peaksFromAudioBuffer: peaksFromAudioBuffer,
  };
});
