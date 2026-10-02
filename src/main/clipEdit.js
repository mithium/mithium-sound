const { spawn } = require('child_process');

function buildRenderPlan(timeline, filesByClipId) {
  if (!Array.isArray(timeline) || !timeline.length) {
    throw new Error('Nothing to render');
  }
  const order = [];
  for (const piece of timeline) {
    const id = piece.clipId;
    if (!Object.prototype.hasOwnProperty.call(filesByClipId, id) && !Object.prototype.hasOwnProperty.call(filesByClipId, String(id))) {
      throw new Error('A clip in this edit is missing its audio file');
    }
    if (!order.includes(id)) order.push(id);
  }
  const indexOf = new Map(order.map((id, index) => [id, index]));
  const filters = [];
  const labels = [];
  timeline.forEach((piece, index) => {
    const input = indexOf.get(piece.clipId);
    const label = `p${index}`;
    const format = 'aformat=sample_fmts=s16:sample_rates=44100:channel_layouts=stereo,asetpts=PTS-STARTPTS';
    if (piece.kind === 'base') {
      const start = (Number(piece.startMs) / 1000).toFixed(3);
      const end = (Number(piece.endMs) / 1000).toFixed(3);
      filters.push(`[${input}:a]atrim=start=${start}:end=${end},${format}[${label}]`);
    } else {
      filters.push(`[${input}:a]${format}[${label}]`);
    }
    labels.push(`[${label}]`);
  });
  filters.push(`${labels.join('')}concat=n=${labels.length}:v=0:a=1[out]`);
  return {
    inputs: order.map((id) => filesByClipId[id] || filesByClipId[String(id)]),
    filter: filters.join(';'),
    inputOrder: order,
  };
}

function parseDurationMs(stderr) {
  const match = String(stderr || '').match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
  if (!match) return null;
  const ms = (Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3])) * 1000;
  return Number.isFinite(ms) ? ms : null;
}

function runFfmpeg(ffmpegPath, args, { allowFail = false, timeoutMs = 120000 } = {}) {
  return new Promise((resolve, reject) => {
    const proc = spawn(ffmpegPath, args, { windowsHide: true });
    let stderr = '';
    let settled = false;
    const timer = setTimeout(() => {
      try { proc.kill(); } catch { /* already gone */ }
    }, timeoutMs);
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn(value);
    };
    proc.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
      if (stderr.length > 200000) stderr = stderr.slice(-100000);
    });
    proc.on('error', (err) => {
      if (err.code === 'ENOENT') {
        finish(reject, new Error('FFmpeg was not found. Clip editing needs the bundled FFmpeg.'));
      } else {
        finish(reject, err);
      }
    });
    proc.on('close', (code) => {
      if (code === 0 || allowFail) finish(resolve, stderr);
      else finish(reject, new Error((stderr || `FFmpeg exited ${code}`).slice(-500)));
    });
  });
}

async function probeDurationMs(ffmpegPath, filePath) {
  if (!ffmpegPath) throw new Error('FFmpeg was not found. Clip editing needs the bundled FFmpeg.');
  const stderr = await runFfmpeg(ffmpegPath, ['-hide_banner', '-i', filePath], { allowFail: true, timeoutMs: 20000 });
  const duration = parseDurationMs(stderr);
  if (!duration || duration <= 0) throw new Error('Could not read the clip length');
  return duration;
}

async function renderTimeline({ ffmpegPath, timeline, filesByClipId, outputPath }) {
  if (!ffmpegPath) throw new Error('FFmpeg was not found. Clip editing needs the bundled FFmpeg.');
  const plan = buildRenderPlan(timeline, filesByClipId);
  const args = ['-y', '-hide_banner'];
  for (const input of plan.inputs) {
    args.push('-i', input);
  }
  args.push('-filter_complex', plan.filter, '-map', '[out]', '-c:a', 'pcm_s16le', outputPath);
  await runFfmpeg(ffmpegPath, args, { timeoutMs: 180000 });
  return plan;
}

module.exports = {
  buildRenderPlan,
  parseDurationMs,
  probeDurationMs,
  renderTimeline,
  runFfmpeg,
};
