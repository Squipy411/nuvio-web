# Nuvio Web PWA

Mobile-first browser proof of concept for Nuvio accounts and Stremio addons.

## Personal self-hosted fork

This checkout builds on **[lucaboox/nuvio-web](https://github.com/lucaboox/nuvio-web)**,
not the earlier unrelated Next.js site. The original account, addon, profile,
library, progress, source-selection and PWA architecture remains in place.
It adds a same-origin FFmpeg companion for relay, remux, audio conversion and
last-resort video conversion. It is not an official Nuvio Media release.

See [SELF_HOSTING.md](SELF_HOSTING.md) for the two-container deployment,
[VERIFICATION.md](VERIFICATION.md) for measured results and outstanding checks,
and [UPSTREAM_NOTICE.md](UPSTREAM_NOTICE.md) before distributing builds.

**Installer status:** images are not published yet. The publishing workflow
generates `docker-compose.zima.yml` from the actual personal fork; the source
template is not an install-ready substitute.

## Run

```powershell
npm install
npm run dev
```

This fork supplies the upstream public client's backend configuration by default.
It can be overridden with `NUVIO_SUPABASE_URL` and
`NUVIO_SUPABASE_ANON_KEY` in `.env.local`. You can also select **Self-hosted**
on the sign-in screen and enter a URL and publishable key on the device.

## Translations

Interface text lives in `src/locales/`, one JSON file per language — never in a
component. Correcting a word is a one-line change and a pull request, with no
TypeScript involved. See [TRANSLATING.md](TRANSLATING.md).

The translations were written by an AI rather than by native speakers, so
corrections from people who actually speak the language are welcome and
expected.

## Current scope

- Persistent sign-in and session refresh. Account creation is delegated to
  nuvio.tv; this client only signs in.
- Synced profiles, installed addons, library, watch progress and collections
- Home ordering and per-catalog visibility read from Nuvio's synced home layout
- Direct addon manifest/catalog/meta/stream calls
- Responsive home, discover, library and settings views (addons live inside
  settings), with paginated catalogs and collection folders
- Series episodes, source selection, and marking episodes watched via a
  right-click menu or a touch hold
- Native video/HLS.js playback with external handoff, plus codec diagnostics
  for Matroska audio the browser cannot decode
- Installable PWA shell with a prompted update flow

Library, watched and progress writes mirror the desktop client's sync payloads
field for field. The home layout and collections are read-only here: this
client never pushes them, so it cannot overwrite what another device saved.
See [ARCHITECTURE.md](./ARCHITECTURE.md) for the full design and limitations.
