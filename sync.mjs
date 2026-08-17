#!/usr/bin/env node
/**
 * Main playlist = union(source playlists). Recomputed every run, so adds and
 * removes both fall out of one idempotent diff. Liked Songs is append-only:
 * this script saves, it never unsaves.
 *
 * Flags:
 *   --dry-run   print the plan, change nothing
 *   --force     bypass the mass-removal guard
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Spotify, readJson, chunk, log } from './spotify.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DRY_RUN = process.argv.includes('--dry-run');
const FORCE = process.argv.includes('--force');

const config = await readJson(path.join(HERE, 'config.json'));
const sp = new Spotify({
  clientId: config.clientId,
  tokensPath: path.join(HERE, '.tokens.json'),
});

const MAIN = config.mainPlaylistId;
if (!MAIN) throw new Error('config.json is missing mainPlaylistId');

/**
 * Feb 2026 renamed the playlist item wrapper from `track` to `item`.
 * Local files cannot be added to another playlist via the API, so they are
 * excluded from both sides of the diff and left alone wherever they sit.
 */
function itemUri(row) {
  const item = row?.item ?? row?.track;
  if (!item || !item.uri) return null;
  if (item.is_local || item.uri.startsWith('spotify:local:')) return null;
  return item.uri;
}

async function playlistUris(id) {
  const rows = await sp.getAll(`/playlists/${id}/items`);
  return rows.map(itemUri).filter(Boolean);
}

async function resolveSourceIds() {
  const ids = new Set(config.sources?.ids ?? []);

  if (config.sources?.namePattern) {
    const re = new RegExp(config.sources.namePattern);
    const me = await sp.request('GET', '/me');
    const mine = await sp.getAll('/me/playlists');
    for (const pl of mine) {
      if (!pl?.name || !re.test(pl.name)) continue;
      // GET /playlists/{id}/items only returns contents for playlists you
      // own or collaborate on, so followed playlists are useless as sources.
      if (pl.owner?.id !== me.id && !pl.collaborative) continue;
      ids.add(pl.id);
    }
  }

  ids.delete(MAIN);
  return [...ids];
}

// ---- gather -----------------------------------------------------------------

const sourceIds = await resolveSourceIds();
if (sourceIds.length === 0) throw new Error('no source playlists resolved, refusing to run');

const desired = [];
const desiredSet = new Set();
for (const id of sourceIds) {
  const uris = await playlistUris(id); // throws on failure, which aborts before any write
  log(`source ${id}: ${uris.length} items`);
  for (const uri of uris) {
    if (desiredSet.has(uri)) continue;
    desiredSet.add(uri);
    desired.push(uri);
  }
}

const mainUris = await playlistUris(MAIN);
log(`main ${MAIN}: ${mainUris.length} items, union of sources: ${desired.length}`);

// ---- diff -------------------------------------------------------------------

const counts = new Map();
for (const uri of mainUris) counts.set(uri, (counts.get(uri) ?? 0) + 1);

// DELETE removes every occurrence of a URI, so duplicates are removed wholesale
// and re-added once below.
const toRemove = [];
for (const [uri, n] of counts) {
  if (!desiredSet.has(uri) || n > 1) toRemove.push(uri);
}
const removeSet = new Set(toRemove);
const toAdd = desired.filter((uri) => !counts.has(uri) || removeSet.has(uri));

log(`plan: +${toAdd.length} / -${toRemove.length}`);

// ---- guard ------------------------------------------------------------------

const minRemovals = config.minRemovalsForGuard ?? 20;
const maxRatio = config.maxRemovalRatio ?? 0.5;
const ratio = mainUris.length ? toRemove.length / mainUris.length : 0;

if (!FORCE && toRemove.length >= minRemovals && ratio > maxRatio) {
  throw new Error(
    `refusing to remove ${toRemove.length} of ${mainUris.length} items (${Math.round(ratio * 100)}%). ` +
      `Check that every source playlist still exists, then re-run with --force if this is intended.`,
  );
}

if (DRY_RUN) {
  for (const uri of toAdd) console.log(`  + ${uri}`);
  for (const uri of toRemove) console.log(`  - ${uri}`);
  log('dry run, no changes made');
  process.exit(0);
}

// ---- apply ------------------------------------------------------------------

for (const batch of chunk(toRemove, 100)) {
  await sp.request('DELETE', `/playlists/${MAIN}/items`, {
    body: { items: batch.map((uri) => ({ uri })) },
  });
}

for (const batch of chunk(toAdd, 100)) {
  await sp.request('POST', `/playlists/${MAIN}/items`, { body: { uris: batch } });
}

// ---- liked songs (append only) ----------------------------------------------

let saved = 0;
if (config.likeSongs !== false) {
  const tracks = desired.filter((uri) => uri.startsWith('spotify:track:'));
  const missing = [];

  for (const batch of chunk(tracks, 50)) {
    const res = await sp.request('GET', '/me/library/contains', {
      query: { uris: batch.join(',') },
    });
    const flags = Array.isArray(res) ? res : (res?.results ?? res?.contains ?? []);
    batch.forEach((uri, i) => {
      if (!flags[i]) missing.push(uri);
    });
  }

  for (const batch of chunk(missing, 50)) {
    await sp.request('PUT', '/me/library', { body: { uris: batch } });
  }
  saved = missing.length;
}

log(`done: added ${toAdd.length}, removed ${toRemove.length}, newly liked ${saved}`);
