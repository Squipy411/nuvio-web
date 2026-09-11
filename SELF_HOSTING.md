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
New browser installations default to Automatic with a 1080p full-conversion cap;
an explicitly saved resolution is retained. Generated server playback runs at
normal 1× speed to match bounded segment production. The saved speed preference
is kept and restored for direct/relay playback.

### Internet access and account restrictions

Use your existing HTTPS reverse proxy for a public domain. Forward the original
Host header and preserve streaming responses; disable proxy buffering. Do not
expose the companion directly. Set `COMPANION_ALLOWED_USERS` to your comma-separated
Nuvio user IDs before public exposure. Empty means any valid account on the
configured Nuvio backend can authenticate; it does **not** mean anonymous access.
For HTTPS domains also set `COMPANION_PUBLIC_ORIGINS` to the exact allowed browser
origin(s), for example `https://watch.example.com`. No wildcard origins or trusted
client forwarding headers are used. See [Nginx Proxy Manager and Cloudflare Tunnel
setup](PROXY_SETUP.md) for exact settings, cache exclusions, and Cloudflare's
video-delivery restrictions. A tunnel is not a guarantee of unrestricted video
delivery, and proxying cannot overcome an overloaded CPU or slow source.

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
On this ZimaOS installation `/root` is read-only. Use the writable login directory
that already worked, not Docker's default `/root/.docker` location:

```sh
sudo mkdir -p /DATA/docker-auth
sudo chmod 700 /DATA/docker-auth
sudo docker --config /DATA/docker-auth login ghcr.io --username Squipy411
```

Enter the Zima password if `sudo` asks, then the GitHub token at Docker's hidden
password prompt. The credential must belong to the Docker environment that
actually pulls the Zima app images. Docker's unencrypted-credential warning is
expected without a credential helper: the directory is root-only, but the saved
token must still be protected. Do not print or share its `config.json`.
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

### Update the existing Zima app without deleting it

1. Wait for GitHub's **Verify and publish personal self-hosted images** workflow
   to finish successfully. Open
   its generated `docker-compose.zima.yml` installer and copy both complete
   `image:` values. Both should have the same `sha-…` release tag.
2. Download both images on Zima, one at a time, using the saved login:

   ```sh
   sudo docker --config /DATA/docker-auth pull ghcr.io/squipy411/nuvio-web-web:sha-RELEASE_COMMIT
   sudo docker --config /DATA/docker-auth pull ghcr.io/squipy411/nuvio-web-companion:sha-RELEASE_COMMIT
   ```

   **Replace `sha-RELEASE_COMMIT` with the full tag from that successful release.**
   Do not copy an old tag from an earlier chat message. If a pull says denied,
   repeat the login above only if necessary; private images cannot use anonymous
   download mirrors. A dashboard may not read this custom login directory.
3. Open the **existing Nuvio app's Edit/Docker configuration** on the Zima
   dashboard. Save a copy of its current configuration for rollback. Change the
   web image and companion image together to those exact newly downloaded tags.
   Preserve its port, network, memory settings and any personal environment
   values. Do **not** delete the app or create a second stack on the same port.
4. Save/apply the edit so Zima recreates the two containers. Open the same app
   address; a new PWA build applies automatically when all Nuvio tabs have closed
   playback and finished queued sync writes. For the first upgrade from an older
   build, close/reopen old tabs or accept their existing update prompt. Merely
   restarting an old commit-pinned image does not install a new version.
5. Check companion status and play a known-good source. If the dashboard still
   forces an anonymous pull despite images being present, stop and inspect its
   new error; do not make the packages public or remove account data to fix it.

The user verified registry login and the previous web-image pull on the actual
Zima terminal. The dashboard's edit flow/private-registry integration remains
host-version-dependent and has not been exercised by these repository tests.
Commit-pinned images make rollback explicit: restore **both** previous image tags
from the saved configuration. Keep the same Nuvio account, selected profile and
browser address to retain cloud sync and origin-local preferences.
Restart removes ephemeral playback sessions; reselect the source to resume from
the last Nuvio checkpoint. PWA updates download in the background, then activate
only after all open tabs acknowledge that playback and queued sync writes are idle;
the server does not cache index/service-worker files, and private media is never
stored in the service-worker cache.

## Playback behavior

Automatic first tries the browser. Native HLS is retained where supported;
HLS.js is available through MSE and can recover from an unsuccessful native HLS
attempt before any extra encoding. Required provider headers, mixed-content
restrictions or decoding failures engage the companion.

Torrentio and DuckStreams remain normal Nuvio addons: keep their existing TorBox
configuration. Redirected/extensionless HLS links and required provider headers
are handled without hard-coding CDN hostnames. A brief network failure retries
the same playback mode instead of needlessly escalating to CPU-heavy conversion;
an unavailable or uncached provider file still needs a different working source.
The app does not automatically submit torrents or change provider credentials.

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
The initial read burst covers 20 seconds, followed by bounded real-time reading;
the rolling window retains up to 24 segments within the existing memory budget.
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

## September playback and sync update

This update includes the original project's newer player controls, subtitle
preferences, source picker and large-season rendering improvements. It preserves
the existing Nuvio account/profile, addon and progress formats; it does not replace
the app with the earlier experimental website.

Account/profile-scoped incremental sync, ordered progress saves, session-change
guards and quiet foreground refresh reduce stale progress and cross-account
races. Cloud writes still need connectivity: this is not a durable offline sync
outbox, and simultaneous edits from different devices follow the backend's rules.

Verification uses generated, authorized test media and isolated authentication
fixtures. No live TorBox account, user's Nuvio account, physical iPhone, high-bitrate
4K movie, live tunnel, or existing Zima dashboard was tested here. The generated
long-keyframe 320×180 remux fixture produced its first segment in about 0.13 seconds
with the new burst versus 8.1 seconds with the old burst on the test host; this
is a narrow regression measurement, not a promise about every source or Zima CPU.

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
