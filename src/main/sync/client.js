// HTTP client for the Mithium Sound Home Server.
// Sends only library records. The Discord bot token is never attached.

const BANNED_KEYS = new Set([
  'botToken',
  'bot_token',
  'discordToken',
  'discord_token',
]);

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

function stripBanned(value) {
  if (Array.isArray(value)) return value.map(stripBanned);
  if (value && typeof value === 'object' && !Buffer.isBuffer(value)) {
    const out = {};
    for (const [key, child] of Object.entries(value)) {
      if (BANNED_KEYS.has(key)) continue;
      out[key] = stripBanned(child);
    }
    return out;
  }
  return value;
}

function assertNoSecrets(text, secrets) {
  for (const secret of secrets) {
    if (!secret || String(secret).length < 8) continue;
    if (text.includes(String(secret))) {
      throw new HomeServerError(
        'Refusing to send the Discord bot token to the Home Server',
        'error'
      );
    }
  }
}

function createClient({ baseUrl, token, forbiddenSecrets, fetchImpl } = {}) {
  const secrets = (forbiddenSecrets || []).map((s) => String(s || '')).filter((s) => s.length >= 8);
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

  async function request(pathname, { method = 'GET', json, body, headers, timeoutMs = 15000, expect = 'json' } = {}) {
    const url = base() + pathname;
    assertNoSecrets(url, secrets);
    const finalHeaders = { ...authHeaders(), ...(headers || {}) };
    let payload = body;
    if (json !== undefined) {
      const safe = stripBanned(json);
      const text = JSON.stringify(safe);
      assertNoSecrets(text, secrets);
      payload = text;
      finalHeaders['Content-Type'] = 'application/json';
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response;
    try {
      response = await doFetch(url, {
        method,
        headers: finalHeaders,
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
      throw new HomeServerError(message, offlineHttp ? 'offline' : 'error', response.status);
    }

    if (expect === 'buffer') {
      const arrayBuffer = await response.arrayBuffer();
      const buffer = Buffer.from(arrayBuffer);
      if (buffer.length > 100 * 1024 * 1024) {
        throw new HomeServerError('Audio file is too large', 'error');
      }
      return buffer;
    }
    if (expect === 'empty') return null;
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
    async getLibrary({ since } = {}) {
      if (since) {
        try {
          return await request(`/api/sync?since=${encodeURIComponent(since)}`);
        } catch (err) {
          if (err.httpStatus === 404 || err.httpStatus === 400) {
            return request('/api/library');
          }
          throw err;
        }
      }
      return request('/api/library');
    },
    getAudio(id) {
      return request(`/api/clips/${encodeURIComponent(id)}/audio`, {
        expect: 'buffer',
        timeoutMs: 60000,
      });
    },
    putClip(clip) {
      return request(`/api/clips/${encodeURIComponent(clip.id)}`, {
        method: 'PUT',
        json: clip,
      });
    },
    putAudio(id, bytes, contentHash) {
      const body = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
      return request(`/api/clips/${encodeURIComponent(id)}/audio`, {
        method: 'PUT',
        body,
        expect: 'json',
        timeoutMs: 60000,
        headers: {
          'Content-Type': 'application/octet-stream',
          'X-Content-Hash': contentHash || '',
        },
      });
    },
    deleteClip(id) {
      return request(`/api/clips/${encodeURIComponent(id)}`, { method: 'DELETE' });
    },
    putGroup(group) {
      return request(`/api/groups/${encodeURIComponent(group.id)}`, {
        method: 'PUT',
        json: group,
      });
    },
    deleteGroup(id) {
      return request(`/api/groups/${encodeURIComponent(id)}`, { method: 'DELETE' });
    },
  };
}

module.exports = {
  HomeServerError,
  createClient,
  parseBaseUrl,
  classifyNetwork,
};
