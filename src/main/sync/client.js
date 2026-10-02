// HTTP client for mithium-sound-library.
// Wire format is API.md: Bearer auth, revision cursor, no Discord token,
// and no client-supplied createdAt / updatedAt.

const { assertWireBody } = require('./merge');

const MAX_AUDIO_BYTES = 32 * 1024 * 1024;

class HomeServerError extends Error {
  constructor(message, status, httpStatus) {
    super(message);
    this.name = 'HomeServerError';
    this.status = status === 'offline' ? 'offline' : 'error';
    this.httpStatus = httpStatus || null;
  }
}

function parseBaseUrl(input) {
  let url;
  try {
    url = new URL(String(input || '').trim());
  } catch {
    throw new HomeServerError('Home Server URL is not valid', 'error');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new HomeServerError('Home Server URL must start with http:// or https://', 'error');
  }
  if (url.username || url.password) {
    throw new HomeServerError('Put the secret in the token field, not the URL', 'error');
  }
  const path = url.pathname.replace(/\/+$/, '');
  return url.origin + path;
}

function classifyNetwork(err) {
  if (!err) return 'error';
  if (err.name === 'AbortError') return 'offline';
  const code = err.code || (err.cause && (err.cause.code || err.cause.errno));
  const offlineCodes = new Set([
    'ECONNREFUSED',
    'ENOTFOUND',
    'EHOSTUNREACH',
    'ENETUNREACH',
    'EAI_AGAIN',
    'ETIMEDOUT',
    'ECONNRESET',
    'UND_ERR_CONNECT_TIMEOUT',
    'UND_ERR_SOCKET',
    'UND_ERR_HEADERS_TIMEOUT',
  ]);
  if (offlineCodes.has(code)) return 'offline';
  const message = String(err.message || '');
  if (/fetch failed|network|timed out|timeout|ECONNREFUSED|ENOTFOUND|socket hang up/i.test(message)) {
    return 'offline';
  }
  return 'error';
}

function assertNoSecrets(text, secrets) {
  for (const secret of secrets) {
    if (!secret || String(secret).length < 8) continue;
    if (String(text).includes(String(secret))) {
      throw new HomeServerError(
        'Refusing to send the Discord bot token to the Home Server',
        'error'
      );
    }
  }
}

function filenameFromClip(clip) {
  const raw = clip && (clip.filename || clip.audioPath) ? String(clip.filename || clip.audioPath) : '';
  const base = raw.split(/[/\\]/).pop();
  if (base && base !== '.' && base !== '..') return base;
  return 'clip.wav';
}

function audioForm(fields, bytes, filename) {
  assertWireBody(fields);
  const form = new FormData();
  for (const [key, value] of Object.entries(fields)) {
    if (value == null || value === '') continue;
    form.append(key, String(value));
  }
  const body = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes || []);
  form.append('file', new Blob([body]), filename || 'clip.wav');
  return form;
}

function createClient({ baseUrl, token, forbiddenSecrets, fetchImpl } = {}) {
  const secrets = (forbiddenSecrets || []).map((value) => String(value || '')).filter((value) => value.length >= 8);
  const doFetch = fetchImpl || fetch;
  let resolvedBase = null;

  function base() {
    if (!resolvedBase) resolvedBase = parseBaseUrl(baseUrl);
    return resolvedBase;
  }

  function authHeaders() {
    const homeToken = String(token || '');
    if (homeToken && secrets.includes(homeToken)) {
      throw new HomeServerError(
        'Home Server token must not be the Discord bot token',
        'error'
      );
    }
    if (!homeToken) return {};
    return {
      Authorization: `Bearer ${homeToken}`,
      'X-Api-Key': homeToken,
    };
  }

  async function request(pathname, { method = 'GET', json, form, timeoutMs = 15000, expect = 'json' } = {}) {
    const url = base() + pathname;
    assertNoSecrets(url, secrets);
    const headers = { ...authHeaders() };
    let payload;
    if (json !== undefined) {
      assertWireBody(json);
      const text = JSON.stringify(json);
      assertNoSecrets(text, secrets);
      payload = text;
      headers['Content-Type'] = 'application/json';
    } else if (form) {
      payload = form;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response;
    try {
      response = await doFetch(url, {
        method,
        headers,
        body: payload,
        signal: controller.signal,
        redirect: 'error',
      });
    } catch (err) {
      if (err instanceof HomeServerError) throw err;
      const status = classifyNetwork(err);
      throw new HomeServerError(
        status === 'offline' ? 'Home Server is unreachable' : (err.message || 'Home Server request failed'),
        status
      );
    } finally {
      clearTimeout(timer);
    }

    if (!response.ok) {
      let detail = '';
      try {
        detail = await response.text();
      } catch {
        detail = '';
      }
      const offlineHttp = response.status === 502 || response.status === 503 || response.status === 504;
      const message = response.status === 401 || response.status === 403
        ? 'Home Server rejected the token'
        : `Home Server returned HTTP ${response.status}${detail ? `: ${detail.slice(0, 180)}` : ''}`;
      const error = new HomeServerError(message, offlineHttp ? 'offline' : 'error', response.status);
      throw error;
    }

    if (expect === 'buffer') {
      const arrayBuffer = await response.arrayBuffer();
      const buffer = Buffer.from(arrayBuffer);
      if (buffer.length > MAX_AUDIO_BYTES) {
        throw new HomeServerError('Audio file is too large', 'error');
      }
      return buffer;
    }
    if (expect === 'empty' || response.status === 204) return null;
    const text = await response.text();
    if (!text) return {};
    try {
      return JSON.parse(text);
    } catch {
      throw new HomeServerError('Home Server returned invalid JSON', 'error');
    }
  }

  return {
    health() {
      return request('/api/health', { timeoutMs: 3000 });
    },
    getLibrary() {
      return request('/api/library');
    },
    getSync(sinceRevision) {
      return request(`/api/sync?sinceRevision=${encodeURIComponent(sinceRevision)}`);
    },
    getAudio(id) {
      return request(`/api/clips/${encodeURIComponent(id)}/audio`, {
        expect: 'buffer',
        timeoutMs: 60000,
      });
    },
    createGroup(group) {
      return request('/api/groups', { method: 'POST', json: group });
    },
    patchGroup(id, body) {
      return request(`/api/groups/${encodeURIComponent(id)}`, { method: 'PATCH', json: body });
    },
    deleteGroup(id) {
      return request(`/api/groups/${encodeURIComponent(id)}`, { method: 'DELETE', expect: 'empty' });
    },
    createClip({ id, name, groupId, trimStartMs, trimEndMs, filename, bytes }) {
      if (!bytes || !bytes.length) {
        throw new HomeServerError('Clip has no audio to upload', 'error');
      }
      if (bytes.length > MAX_AUDIO_BYTES) {
        throw new HomeServerError('Audio file is too large', 'error');
      }
      const fields = { id, name, groupId };
      if (trimStartMs != null) fields.trimStartMs = trimStartMs;
      if (trimEndMs != null) fields.trimEndMs = trimEndMs;
      assertNoSecrets(JSON.stringify(fields), secrets);
      return request('/api/clips', {
        method: 'POST',
        form: audioForm(fields, bytes, filenameFromClip({ filename })),
        timeoutMs: 60000,
      });
    },
    patchClip(id, body) {
      return request(`/api/clips/${encodeURIComponent(id)}`, { method: 'PATCH', json: body });
    },
    putAudio(id, bytes, filename) {
      if (!bytes || !bytes.length) {
        throw new HomeServerError('Clip has no audio to upload', 'error');
      }
      if (bytes.length > MAX_AUDIO_BYTES) {
        throw new HomeServerError('Audio file is too large', 'error');
      }
      return request(`/api/clips/${encodeURIComponent(id)}/audio`, {
        method: 'PUT',
        form: audioForm({}, bytes, filenameFromClip({ filename })),
        timeoutMs: 60000,
      });
    },
    deleteClip(id) {
      return request(`/api/clips/${encodeURIComponent(id)}`, { method: 'DELETE', expect: 'empty' });
    },
  };
}

module.exports = {
  MAX_AUDIO_BYTES,
  HomeServerError,
  createClient,
  parseBaseUrl,
  classifyNetwork,
};
