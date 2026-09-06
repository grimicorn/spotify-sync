# spotify-playlist-sync

Rolls a set of genre playlists up into one main playlist, and saves everything in them to Liked Songs.

- Add a track to any genre playlist → it appears in the main playlist and in Liked Songs.
- Remove it from the genre playlist → it disappears from the main playlist, and stays in Liked Songs.

The main playlist is mostly **derived**: every run recomputes it as `union(sources)`. It also feeds two kinds of edit back to the sources:

- **Remove a track from the main playlist** → it's removed from every genre playlist that held it (so it doesn't just reappear next run).
- **Add a track to the main playlist** → it's added to the `Genre: Sort` playlist (`sortPlaylistId`), where you can later file it into a real genre.

These two are detected by comparing the current main playlist against a snapshot of how the script last left it (`.main-snapshot.json`, git-ignored). The **first run** has no snapshot, so it skips propagation and just records the baseline. Any other direct edit to main that isn't one of the two above still gets reconciled away on the next run.

Zero dependencies. Node 20+ (uses native `fetch`), no build step, no `npm install`.

## Setup

### 1. Register the app

At <https://developer.spotify.com/dashboard>, create an app.

- Redirect URI: `http://127.0.0.1:8888/callback` (exactly this; Spotify rejects `localhost` now, loopback IPs are the only non-HTTPS redirect allowed)
- APIs used: Web API
- Development Mode requires the app owner to hold an active Premium subscription. If Premium lapses, the app stops working until you resubscribe.

Copy the Client ID. There is no client secret; this uses PKCE.

### 2. Configure

```bash
cp config.example.json config.json
```

| Field                 | Meaning                                                                                     |
| --------------------- | ------------------------------------------------------------------------------------------- |
| `clientId`            | From the dashboard.                                                                          |
| `mainPlaylistId`      | The derived playlist. Must be one you own.                                                   |
| `sortPlaylistId`      | Where tracks added directly to the main playlist are routed. Must be one you own.             |
| `sources.ids`         | Explicit list of genre playlist IDs.                                                         |
| `sources.namePattern` | Regex against your own playlist names. Anything matching is treated as a source.              |
| `likeSongs`           | `false` disables the Liked Songs half.                                                       |
| `maxRemovalRatio`     | Abort if a run would remove more than this fraction of the main playlist. See Safety below.   |
| `minRemovalsForGuard` | The guard only trips once removals reach this count, so small playlists aren't blocked.       |

Use `ids`, `namePattern`, or both. `namePattern` is the low-maintenance option: name your playlists `Genre: Shoegaze`, `Genre: Dub`, and new ones join the union with no config edit. Playlists you follow but do not own are skipped, because the API no longer returns contents for other people's playlists.

Playlist IDs come from the share link: `https://open.spotify.com/playlist/<ID>?si=...`

### 3. Authorize

```bash
node auth.mjs
```

Open the printed URL, approve, done. Writes `.tokens.json` (mode 600) next to the script.

On a headless box you have two options: run `auth.mjs` on your laptop and `scp .tokens.json` over, or SSH in with `-L 8888:127.0.0.1:8888` and open the URL locally.

### 4. Verify before you let it write

```bash
node sync.mjs --dry-run
```

Prints the exact adds and removes and exits without touching anything. Run this first, every time you change the source list.

### 5. Schedule it

Edit `dev.grimicorn.spotify-sync.plist` (three `CHANGEME` paths, plus the node path if you aren't on Homebrew ARM), then:

```bash
cp dev.grimicorn.spotify-sync.plist ~/Library/LaunchAgents/
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/dev.grimicorn.spotify-sync.plist
launchctl kickstart -p gui/$(id -u)/dev.grimicorn.spotify-sync   # run once now
tail -f sync.log
```

To reload after an edit:

```bash
launchctl bootout gui/$(id -u)/dev.grimicorn.spotify-sync
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/dev.grimicorn.spotify-sync.plist
```

Default interval is 900s (15 min). Nothing here is expensive, but the whole run is a handful of paged GETs plus the diff, so tightening below ~5 min mostly just burns rate limit.

If the repo lives on an external or network volume, point `StandardOutPath`/`StandardErrorPath` at a path on the internal disk (e.g. `~/Library/Logs/spotify-sync.log`). launchd will run the script from the external volume fine, but it can't create the log file there and fails the whole job with `EX_CONFIG` (exit 78) before Node even starts. Also note that while the volume is unmounted every tick fails and self-heals on remount, so nothing syncs until it's back. If your `node` comes from nvm rather than Homebrew, use its absolute path (`~/.nvm/versions/node/<version>/bin/node`) since launchd doesn't load nvm — and remember it breaks when you remove that node version.

## Safety

The realistic failure mode is not bad diff logic, it's a source playlist that fails to load or gets deleted, making the union look artificially small and quietly emptying the main playlist.

Three defenses:

1. Any failed fetch throws before a single write happens.
2. Zero resolved sources is a hard error, not an empty union.
3. The removal guard aborts a run that would delete more than `maxRemovalRatio` of the main playlist once removals hit `minRemovalsForGuard`. Override deliberately with `--force`.

Liked Songs is append-only by construction. The script calls `PUT /me/library` and never `DELETE /me/library`.

## Behavior notes

- **Duplicates in the main playlist** are collapsed. The API removes every occurrence of a URI, so a duplicated track is deleted and re-added once.
- **Local files** are excluded from both sides of the diff and left untouched. They can't be added to a playlist through the API.
- **Order** is preserved for tracks that stay. New tracks append to the end. Existing `added_at` values survive, because the script diffs instead of replacing wholesale.
- **Unliking is not respected.** If you unlike a track that's still in a genre playlist, the next run re-likes it, because the script asks Spotify what's saved rather than keeping its own state. Remove it from the genre playlist first, or set `likeSongs: false`.
- **Refresh tokens rotate** on PKCE. The client persists the new one on every refresh, so don't check `.tokens.json` into git or replace it with a stale copy.
- **Main-edit propagation is snapshot-based.** `.main-snapshot.json` records main's non-local URIs as the script last left them. Deleting the snapshot forces a no-propagation bootstrap on the next run (a safe reset). Editing both a genre playlist and the main playlist between runs is fine; the snapshot only ever compares against main.

## API baseline

Written against the Web API as of the February 2026 Development Mode changes: `/playlists/{id}/tracks` renamed to `/playlists/{id}/items`, the `tracks` field renamed to `items` (and `.track` to `.item`), and the per-type library endpoints replaced by URI-based `PUT`/`DELETE /me/library` and `GET /me/library/contains`. The item reader accepts both the old and new field names, so it survives a partial rollout either way.

The one shape not confirmed against live traffic is the `GET /me/library/contains` response; the code accepts a bare array or a `results`/`contains` wrapper. If Liked Songs never fills up, log that response first.
