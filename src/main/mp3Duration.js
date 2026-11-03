// Read an MP3 length from a short prefix plus the full file size.
// Search uses this so a result can show its length before the file is saved.

const BITRATE_MPEG1_L3 = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 0];
const BITRATE_MPEG2_L3 = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160, 0];
const SAMPLE_RATES = {
  0: [44100, 48000, 32000],
  2: [22050, 24000, 16000],
  3: [11025, 12000, 8000],
};

function id3v2Size(buf) {
  if (!buf || buf.length < 10) return 0;
  if (buf[0] !== 0x49 || buf[1] !== 0x44 || buf[2] !== 0x33) return 0;
  const size = ((buf[6] & 0x7f) << 21)
    | ((buf[7] & 0x7f) << 14)
    | ((buf[8] & 0x7f) << 7)
    | (buf[9] & 0x7f);
  const footer = (buf[5] & 0x10) ? 10 : 0;
  return 10 + size + footer;
}

function frameAt(buf, offset) {
  if (offset < 0 || offset + 4 > buf.length) return null;
  if (buf[offset] !== 0xff || (buf[offset + 1] & 0xe0) !== 0xe0) return null;
  const header = buf.readUInt32BE(offset);
  const version = (header >> 19) & 3;
  const layer = (header >> 17) & 3;
  const bitrateIndex = (header >> 12) & 0xf;
  const sampleIndex = (header >> 10) & 3;
  const padding = (header >> 9) & 1;
  const channel = (header >> 6) & 3;
  if (version === 1 || layer !== 1 || bitrateIndex === 0 || bitrateIndex === 15 || sampleIndex === 3) {
    return null;
  }
  const sampleRate = (SAMPLE_RATES[version] || [])[sampleIndex];
  const table = version === 3 ? BITRATE_MPEG1_L3 : BITRATE_MPEG2_L3;
  const bitrate = table[bitrateIndex] * 1000;
  if (!sampleRate || !bitrate) return null;
  const samples = version === 3 ? 1152 : 576;
  const frameLength = Math.floor((samples / 8 * bitrate) / sampleRate) + padding;
  if (frameLength < 24) return null;
  return {
    offset,
    version,
    sampleRate,
    bitrate,
    samples,
    frameLength,
    sideInfo: version === 3 ? (channel === 3 ? 17 : 32) : (channel === 3 ? 9 : 17),
  };
}

function findFrame(buf, start) {
  const from = Math.max(0, start);
  const last = Math.min(buf.length - 4, from + 8192);
  for (let i = from; i <= last; i += 1) {
    const frame = frameAt(buf, i);
    if (!frame) continue;
    const next = frameAt(buf, i + frame.frameLength);
    if (next || i + frame.frameLength + 4 > buf.length) return frame;
  }
  return null;
}

function xingFrames(buf, frame) {
  const base = frame.offset + 4 + frame.sideInfo;
  if (base + 16 > buf.length) return null;
  const tag = buf.slice(base, base + 4).toString('latin1');
  if (tag !== 'Xing' && tag !== 'Info') return null;
  const flags = buf.readUInt32BE(base + 4);
  if ((flags & 1) === 0) return null;
  const frames = buf.readUInt32BE(base + 8);
  if (!frames) return null;
  return frames;
}

function durationFromMp3(prefix, totalBytes) {
  const buf = Buffer.isBuffer(prefix) ? prefix : Buffer.from(prefix || []);
  const total = Number(totalBytes);
  if (buf.length < 16 || !Number.isFinite(total) || total < 16) return null;
  const id3 = Math.min(id3v2Size(buf), buf.length);
  const frame = findFrame(buf, id3);
  if (!frame) return null;
  const frames = xingFrames(buf, frame);
  if (frames) {
    const ms = Math.round((frames * frame.samples * 1000) / frame.sampleRate);
    return ms > 0 ? ms : null;
  }
  const audioBytes = Math.max(0, total - id3);
  if (!audioBytes) return null;
  const ms = Math.round((audioBytes * 8 * 1000) / frame.bitrate);
  return ms > 0 ? ms : null;
}

module.exports = {
  durationFromMp3,
  id3v2Size,
};
