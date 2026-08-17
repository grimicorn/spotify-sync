#!/usr/bin/env node
/**
 * One-time login. Produces .tokens.json next to this script.
 * Run it once on a machine with a browser, then copy .tokens.json to the server.
 *
 * The redirect URI below must be registered verbatim in the Spotify dashboard.
 * Spotify requires HTTPS except for literal loopback IPs, so 127.0.0.1 works
 * and "localhost" does not.
 */
import http from 'node:http';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SCOPES, readJson, writeTokens, log } from './spotify.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PORT = 8888;
const REDIRECT_URI = `http://127.0.0.1:${PORT}/callback`;

const config = await readJson(path.join(HERE, 'config.json'));
if (!config.clientId) throw new Error('config.json is missing clientId');

const b64url = (buf) => buf.toString('base64url');
const verifier = b64url(crypto.randomBytes(64));
const challenge = b64url(crypto.createHash('sha256').update(verifier).digest());
const state = b64url(crypto.randomBytes(16));

const authUrl = new URL('https://accounts.spotify.com/authorize');
authUrl.search = new URLSearchParams({
  response_type: 'code',
  client_id: config.clientId,
  scope: SCOPES.join(' '),
  redirect_uri: REDIRECT_URI,
  state,
  code_challenge_method: 'S256',
  code_challenge: challenge,
}).toString();

console.log('\nOpen this URL in a browser on this machine:\n');
console.log(authUrl.toString());
console.log('');

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  if (url.pathname !== '/callback') {
    res.writeHead(404).end();
    return;
  }

  const done = (msg) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' }).end(msg + '\n');
  };

  try {
    if (url.searchParams.get('state') !== state) throw new Error('state mismatch');
    const error = url.searchParams.get('error');
    if (error) throw new Error(`authorization denied: ${error}`);

    const code = url.searchParams.get('code');
    const tokenRes = await fetch('https://accounts.spotify.com/api/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: REDIRECT_URI,
        client_id: config.clientId,
        code_verifier: verifier,
      }),
    });

    if (!tokenRes.ok) throw new Error(`token exchange failed: ${tokenRes.status} ${await tokenRes.text()}`);

    const data = await tokenRes.json();
    const tokensPath = path.join(HERE, '.tokens.json');
    await writeTokens(tokensPath, { refresh_token: data.refresh_token });

    done('Authorized. You can close this tab.');
    log(`wrote ${tokensPath}`);
    server.close(() => process.exit(0));
  } catch (err) {
    done(`Failed: ${err.message}`);
    console.error(err);
    server.close(() => process.exit(1));
  }
});

server.listen(PORT, '127.0.0.1', () => log(`waiting for callback on ${REDIRECT_URI}`));
