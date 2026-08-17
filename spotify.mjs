import { readFile, writeFile, chmod } from 'node:fs/promises';

const TOKEN_URL = 'https://accounts.spotify.com/api/token';
const API = 'https://api.spotify.com/v1';

export const SCOPES = [
  'playlist-read-private',
  'playlist-read-collaborative',
  'playlist-modify-private',
  'playlist-modify-public',
  'user-library-read',
  'user-library-modify',
];

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function log(...args) {
  console.log(new Date().toISOString(), ...args);
}

export function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

export async function readJson(file) {
  return JSON.parse(await readFile(file, 'utf8'));
}

export async function writeTokens(file, tokens) {
  await writeFile(file, JSON.stringify(tokens, null, 2) + '\n', { mode: 0o600 });
  await chmod(file, 0o600);
}

export class Spotify {
  #clientId;
  #tokensPath;
  #tokens = null;
  #accessToken = null;
  #expiresAt = 0;

  constructor({ clientId, tokensPath }) {
    this.#clientId = clientId;
    this.#tokensPath = tokensPath;
  }

  async #refresh() {
    if (!this.#tokens) this.#tokens = await readJson(this.#tokensPath);

    const res = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: this.#tokens.refresh_token,
        client_id: this.#clientId,
      }),
    });

    if (!res.ok) {
      throw new Error(`token refresh failed: ${res.status} ${await res.text()}`);
    }

    const data = await res.json();
    this.#accessToken = data.access_token;
    this.#expiresAt = Date.now() + (data.expires_in - 60) * 1000;

    // PKCE clients get a rotated refresh token. Losing it means re-running auth.mjs.
    if (data.refresh_token && data.refresh_token !== this.#tokens.refresh_token) {
      this.#tokens.refresh_token = data.refresh_token;
      await writeTokens(this.#tokensPath, this.#tokens);
    }
  }

  async #token() {
    if (!this.#accessToken || Date.now() >= this.#expiresAt) await this.#refresh();
    return this.#accessToken;
  }

  async request(method, pathOrUrl, { query, body, retries = 5 } = {}) {
    const url = pathOrUrl.startsWith('http')
      ? new URL(pathOrUrl)
      : new URL(API + pathOrUrl);

    if (query) {
      for (const [k, v] of Object.entries(query)) {
        if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
      }
    }

    for (let attempt = 0; ; attempt++) {
      const res = await fetch(url, {
        method,
        headers: {
          Authorization: `Bearer ${await this.#token()}`,
          ...(body ? { 'Content-Type': 'application/json' } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
      });

      if (res.status === 401 && attempt === 0) {
        this.#expiresAt = 0;
        continue;
      }

      if (res.status === 429 && attempt < retries) {
        const wait = (Number(res.headers.get('retry-after') || 2) + 1) * 1000;
        log(`rate limited on ${method} ${url.pathname}, waiting ${wait}ms`);
        await sleep(wait);
        continue;
      }

      if (res.status >= 500 && attempt < retries) {
        await sleep(2 ** attempt * 500);
        continue;
      }

      if (!res.ok) {
        throw new Error(`${method} ${url.pathname} -> ${res.status} ${await res.text()}`);
      }

      const text = await res.text();
      return text ? JSON.parse(text) : null;
    }
  }

  /** Follows `next` until the paging object is exhausted. */
  async getAll(path, query) {
    const out = [];
    let page = await this.request('GET', path, { query: { limit: 50, ...query } });
    while (page) {
      out.push(...(page.items ?? []));
      page = page.next ? await this.request('GET', page.next) : null;
    }
    return out;
  }
}
