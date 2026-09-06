#!/usr/bin/env node
/**
 * Main playlist = union(source playlists), plus two ways the main playlist
 * feeds edits back to the sources:
 *   - Remove a track from main  -> removed from every source that has it.
 *   - Add a track to main       -> added to the "Genre: Sort" playlist.
 * Both are detected by diffing the current main against a snapshot of main as
 * this script last left it (`.main-snapshot.json`, git-ignored). The first run
 * has no snapshot, so it skips propagation and just records the baseline.
 *
 * Liked Songs is append-only: this script saves, it never unsaves.
 *
 * Flags:
 *   --dry-run   print the plan, change nothing
 *   --force     bypass the mass-removal guard
 */
import path from 'node:path';
import { readFile, writeFile } from 'node:fs/promises';
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

const SORT = config.sortPlaylistId;
if (!SORT) throw new Error('config.json is missing sortPlaylistId');

const SNAPSHOT_PATH = path.join(HERE, '.main-snapshot.json');

// Returns null (not an empty set) on the first run, so callers can tell
// "main was empty last time" from "we have never recorded main".
async function readSnapshot() {
  try {
    const data = JSON.parse(await readFile(SNAPSHOT_PATH, 'utf8'));
    return new Set(data.uris ?? []);
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}

async function writeSnapshot(uris) {
  const data = { updatedAt: new Date().toISOString(), uris: [...uris] };
  await writeFile(SNAPSHOT_PATH, JSON.stringify(data, null, 2) + '\n');
}

function union(sets) {
  const out = new Set();
  for (const set of sets) {
    for (const uri of set) out.add(uri);
  }
  return out;
}

// The old `/me/tracks/contains` took 50 IDs, but the URI-based
// `GET /me/library/contains` 400s ("Too many uris requested") on a batch of 50.
// The limit is undocumented and shared with `PUT /me/library`, so stay
// conservative until confirmed. Both endpoints take `uris` as a query param.
const LIBRARY_URI_LIMIT = 20;

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

const prevMain = await readSnapshot();

const sourceIds = await resolveSourceIds();
if (sourceIds.length === 0) throw new Error('no source playlists resolved, refusing to run');

// Membership is kept per source as a mutable set, so propagating edits back to
// the sources updates the union without another round of fetches.
const membership = new Map();
for (const id of sourceIds) {
  const uris = await playlistUris(id); // throws on failure, which aborts before any write
  log(`source ${id}: ${uris.length} items`);
  membership.set(id, new Set(uris));
}
if (!membership.has(SORT)) membership.set(SORT, new Set());

const mainUris = await playlistUris(MAIN);
const mainSet = new Set(mainUris);

// The union as the sources stand right now, before any main-driven edit. Used
// to tell a genuine manual add to main from a track that is already in a source.
const sourceUnion = union(membership.values());
log(`main ${MAIN}: ${mainUris.length} items, union of sources: ${sourceUnion.size}`);

// ---- propagate main edits back to sources -----------------------------------

const removedFromMain = [];
const addedToMain = [];

if (prevMain) {
  for (const uri of prevMain) {
    if (!mainSet.has(uri)) removedFromMain.push(uri);
  }
  for (const uri of mainSet) {
    if (!prevMain.has(uri) && !sourceUnion.has(uri)) addedToMain.push(uri);
  }
} else {
  log('no snapshot found, bootstrapping without propagation');
}

// uri removed from main -> drop it from every source that still holds it.
const sourceRemovals = new Map();
for (const uri of removedFromMain) {
  for (const [id, set] of membership) {
    if (!set.has(uri)) continue;
    set.delete(uri);
    if (!sourceRemovals.has(id)) sourceRemovals.set(id, []);
    sourceRemovals.get(id).push(uri);
  }
}

// uri added to main -> route it into the Sort playlist.
for (const uri of addedToMain) membership.get(SORT).add(uri);

const removedCount = [...sourceRemovals.values()].reduce((n, uris) => n + uris.length, 0);
log(`main edits: removed ${removedFromMain.length} (${removedCount} source deletions), added ${addedToMain.length} to sort`);

// ---- diff -------------------------------------------------------------------

const desiredSet = union(membership.values());
const desired = [...desiredSet];

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
  for (const [id, uris] of sourceRemovals) {
    for (const uri of uris) console.log(`  source ${id} - ${uri}`);
  }
  for (const uri of addedToMain) console.log(`  sort ${SORT} + ${uri}`);
  for (const uri of toAdd) console.log(`  + ${uri}`);
  for (const uri of toRemove) console.log(`  - ${uri}`);
  log('dry run, no changes made');
  process.exit(0);
}

// ---- apply ------------------------------------------------------------------

// Propagate main-driven edits to the sources first, then reconcile main to the
// resulting union.
for (const [id, uris] of sourceRemovals) {
  for (const batch of chunk(uris, 100)) {
    await sp.request('DELETE', `/playlists/${id}/items`, {
      body: { items: batch.map((uri) => ({ uri })) },
    });
  }
}

for (const batch of chunk(addedToMain, 100)) {
  await sp.request('POST', `/playlists/${SORT}/items`, { body: { uris: batch } });
}

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

  for (const batch of chunk(tracks, LIBRARY_URI_LIMIT)) {
    const res = await sp.request('GET', '/me/library/contains', {
      query: { uris: batch.join(',') },
    });
    const flags = Array.isArray(res) ? res : (res?.results ?? res?.contains ?? []);
    batch.forEach((uri, i) => {
      if (!flags[i]) missing.push(uri);
    });
  }

  for (const batch of chunk(missing, LIBRARY_URI_LIMIT)) {
    await sp.request('PUT', '/me/library', { query: { uris: batch.join(',') } });
  }
  saved = missing.length;
}

// Snapshot main as we just left it: the union is exactly its non-local content.
// Next run diffs the then-current main against this to spot manual edits.
await writeSnapshot(desiredSet);

log(`done: added ${toAdd.length}, removed ${toRemove.length}, newly liked ${saved}`);
