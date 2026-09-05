# Personal self-hosted Nuvio Web

## Verified private release

The personal fork is **[Squipy411/nuvio-web](https://github.com/Squipy411/nuvio-web)**.
Its [successful release workflow](https://github.com/Squipy411/nuvio-web/actions/runs/33984101019) published
`ghcr.io/squipy411/nuvio-web-web` and `ghcr.io/squipy411/nuvio-web-companion`.
**Both images were authenticated-pulled, anonymous access was denied, and the
freshly pulled Docker stack passed startup and restart checks.** The installer
is pinned to `ff5a372dcd773fcd1ec7f0735c15268b34704c49`.
Actual ZimaOS dashboard import still requires the host's registry login and a
live host-side check; it has not been claimed as completed.
Do not import `deployment/compose.zima.template.yml` into ZimaOS.

## One-file installation after registry sign-in

Use the checked-in [docker-compose.zima.yml](docker-compose.zima.yml), or download
the successful workflow's **zimaos-installer** artifact. It contains the same complete file,
with prebuilt amd64 images named from the actual repository and pinned to that
commit. First complete the private registry sign-in described below. Then, in
ZimaOS choose Add/Import Custom App, paste that one file and install.
Open **http://ZIMA-IP:3075** or click the Nuvio Web dashboard icon.

There is no npm, Node, FFmpeg or Nginx installation on the Zima host. The frontend
image serves the built PWA; the companion image includes Node 24, FFmpeg and
ffprobe. Both use non-root users, read-only filesystems, dropped capabilities,
healthchecks and automatic restart. Neither needs privileged mode, host
networking, a Docker socket mount, a GPU, a database or a second exposed port.

The dedicated Docker bridge is private to the stack, but intentionally **not**
`internal: true`: the companion needs outbound internet for Nuvio authentication
and authorized media. It has no host port mapping.

### Ports and storage

- Public Web UI: **3075** → frontend **8080**.
- Companion **3101** is reachable only inside the Docker network.
- To change the public port, change both `web.ports` and `x-casaos.port_map` in
  the generated file; keep `port_map` a quoted string.
- Persistent ZimaOS paths: **none required**. Account data stays with Nuvio;
  browser preferences and refresh-session storage retain the upstream design.
- Temporary streams: companion `/tmp/nuvio-companion`, inside a **1200 MiB tmpfs**.
  The application enforces a **1 GiB** segment budget and removes expired sessions.
  No streamed movies are saved under `/DATA/AppData/`.
- Maximum concurrent FFmpeg conversions: **2**, maximum playback sessions **8**,
  per-account sessions **3**, idle timeout **90 seconds**, absolute session age **8 hours**.
- Pausing suspends segment production. Stop, source change, logout, page exit,
  timeout and container shutdown terminate work and remove temporary segments.
  A vanished browser is cleaned up after its heartbeat expires.

The 3 GiB companion memory limit includes its tmpfs usage. High bitrate or 4K
conversion can exceed a small server's CPU/RAM budget. Select 1080p or 720p under
Playback settings when needed; direct, remux and audio-only paths keep the video
resolution and do not use that downscale setting.

### Internet access and account restrictions

Use your existing HTTPS reverse proxy for a public domain. Forward the original
Host header and preserve streaming responses; disable proxy buffering. Do not
expose the companion directly. Set `COMPANION_ALLOWED_USERS` to your comma-separated
Nuvio user IDs before public exposure. Empty means any valid account on the
configured Nuvio backend can authenticate; it does **not** mean anonymous access.

The auth Worker exchanges the current Nuvio access token for a short-lived
HttpOnly, SameSite cookie and CSRF value. UI code never receives the Nuvio token.
All media reads require that cookie; mutations also require same-origin and CSRF
checks. Sources and headers are held in memory behind opaque resource IDs.
DNS answers and redirect destinations are checked and pinned; private, loopback,
link-local, metadata, multicast and reserved addresses are blocked. Arbitrary
LAN media URLs are intentionally unsupported. FFmpeg only accesses the internal
validated reader, never an unfiltered user URL. Inputs use argument arrays, not
shell commands. No passwords, bearer tokens or complete source URLs are logged.

An alternate Nuvio backend needs the companion's `NUVIO_SUPABASE_URL` and
`NUVIO_SUPABASE_ANON_KEY` set consistently. The frontend reads its public runtime
configuration from the companion. Never use a service-role or secret key.

### GHCR publishing and updates

`.github/workflows/containers.yml` checks types, upstream tests, generated-media
FFmpeg tests, real-browser player tests, container builds, health, authentication
and restart before publishing. Pull requests do not publish. Default-branch
pushes publish `latest` and `sha-<full-commit>`; version tags also publish the tag.
The installer generator uses `GITHUB_REPOSITORY`, or a verified GitHub `origin`
when run locally, and refuses the upstream repository as its publishing target.

**The owner chose to keep both images private.** The workflow does not change
visibility: it pulls each published image using its temporary job login, verifies
anonymous access is denied, then starts and restarts that freshly pulled stack.
This private-image gate intentionally prevents claiming an anonymous installer.

Before importing the Compose file, authenticate the Zima host to `ghcr.io` as
`Squipy411` using a GitHub personal access token (classic) with only
`read:packages`. Enter that credential in the host's registry login, **never**
in Compose, this repository, a command-line password argument, or this chat.
Docker's interactive command is `docker login ghcr.io --username Squipy411`;
paste the token only at its hidden password prompt. The credential must belong
to the Docker environment that actually pulls the Zima app images.
If the dashboard does not use that login, pull both exact image references from
the installer on the host first, then import the app. Dashboard-specific private
registry handling has not been verified on a live ZimaOS install in this task.

Private images necessarily add this one-time sign-in step. No manual application
build, Node/FFmpeg/Nginx installation, or container-file editing is needed.
Making both packages public later would remove the registry sign-in requirement,
but needs the redistribution permission described in
[UPSTREAM_NOTICE.md](UPSTREAM_NOTICE.md), an explicit owner decision, and removal
of the workflow's intentional private-image gate before an anonymous pull check.
See [GitHub's registry documentation](https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-container-registry).

To update, import the generated installer from the next successful workflow run
or update both image tags together. Commit-pinned images make rollback explicit.
Restart removes ephemeral playback sessions; reselect the source to resume from
the last Nuvio checkpoint. PWA updates use the existing prompted replacement flow;
the server does not cache index/service-worker files, and private media is never
stored in the service-worker cache.

## Playback behavior

Automatic first tries the browser. Native HLS is retained where supported;
HLS.js is available through MSE and can recover from an unsuccessful native HLS
attempt before any extra encoding. Required provider headers, mixed-content
restrictions or decoding failures engage the companion.

| Source when browser access/decoding fails | Companion action |
| --- | --- |
| Browser-compatible MP4/HLS, blocked CORS or required headers | Authenticated relay, preserving byte ranges and rewriting HLS resource URLs |
| H.264/AAC in incompatible Matroska/container | Video and audio copy into fMP4 HLS |
| Supported H.264/HEVC video with unsupported EAC3/AC3/DTS/TrueHD audio | Copy video; selected audio becomes AAC stereo |
| Unsupported HEVC/AV1/video codec | H.264/AAC compatibility conversion |
| Supported HEVC Main10, HDR or AV1 | Keep direct/copy path where reported supported; no global codec ban |
| Unreachable, damaged, encrypted or ultimately incompatible source | Bounded recovery, explanation and existing external-player options |

Remux and audio-only conversion preserve original video quality. Software full
conversion uses the `veryfast` preset, progressive 2-second fMP4 HLS segments and
a rolling window; it does not download or preconvert the whole movie first.
Seek/resume restarts generated output at the requested source offset, while
progress reporting stays in original-media time. Audio language, codec, channels
and titles are exposed; selecting a different companion audio track creates real
new output rather than changing only the selector.

Stream-copy seeking is constrained by the source's keyframes and can land close
to, rather than exactly on, the requested frame. Non-seekable source hosts cannot
gain reliable arbitrary seeking merely by being relayed.

Text subtitle addon resources and stream-provided subtitles support WebVTT and
SRT; the companion can also flatten ASS/SSA dialogue to text. Styling is not
identical to ASS rendering. Embedded subtitle tracks are probed, but this version
does **not** extract embedded MKV text/image subtitles; use an addon subtitle or
the existing external-player handoff. No automatic subtitle burn-in is performed.
Atmos/object audio is not preserved when converting to AAC stereo.

HDR-to-SDR tone mapping is limited to full conversion using FFmpeg zscale/tonemap.
Unreliable Dolby Vision-only conversion is rejected. Actual HDR displays, Dolby
Vision profiles, multihour media, high-bitrate 4K and Apple mobile playback still
need device testing; synthetic 180p results do not prove real-time 4K performance.

Settings → Playback adds automatic/direct/compatibility preference, original/
1080p/720p fallback resolution, companion status and secret-stripped diagnostics.
The upstream audio/subtitle language and autoplay settings remain in place.
Copy diagnostics also has a plain-HTTP clipboard fallback. Picture-in-picture
is only offered when the browser exposes it. Keyboard controls: Space/K play,
Left/Right seek, Up/Down volume outside inputs, M mute, F fullscreen, Escape closes
menus while preserving browser fullscreen behavior.

PWA installation and service workers require HTTPS (or localhost). Plain LAN
HTTP opens the web app, but does not supply installable-PWA capabilities on phones.
Safari/iOS system media controls and codec availability remain device-dependent.

## Developer verification (not Zima installation instructions)

```sh
npm ci
npm --prefix companion ci
npm run check
npm test
npm run build
npm --prefix companion run check
NUVIO_MEDIA_TEST=1 npm --prefix companion test
```

Media tests need FFmpeg on the developer machine. On a Docker host, build
`companion/Dockerfile --target test` instead; FFmpeg is included there. The
browser fixture server (`node companion/tests/browser-server.ts`) binds ports
4311 and 4320 on loopback and uses generated media and isolated test auth. Start
Vite on 4175 with `COMPANION_DEV_URL=http://127.0.0.1:4311`, then run
`npx playwright test`. Test code and mock authentication are excluded from the
production companion image and frontend bundle.

Build `nuvio-web:ci` from the root Dockerfile and `nuvio-companion:ci` from the
companion Dockerfile, then run `node scripts/docker-smoke.mjs`. The script validates
the exact installer template, starts only its own temporary test project, checks
health/auth/cache policy, restarts it, checks again and removes that project.
`--config-only` checks the Compose schema without needing a Docker daemon.
