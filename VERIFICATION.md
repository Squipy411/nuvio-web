# Verification record

## 2026-09-10 update — verified private release

**Published and verified:** release commit
`c823071939707f1618d97d3a28eea88b6046e5ff`, merged via [PR #2](https://github.com/Squipy411/nuvio-web/pull/2).
[Release run 34553360693](https://github.com/Squipy411/nuvio-web/actions/runs/34553360693)
passed frontend, real media, browser, production PWA and Docker checks. The publish
job authenticated-pulled both images, denied anonymous access, and verified a fresh
stack and restart including HTTPS-origin restrictions and no-store proxy headers.
The actual existing Zima app was not modified remotely.

Merged original `lucaboox/nuvio-web` through
`a16757a2c1785d93ce824b220e8aa54ae71fe71b`, preserving the personal companion.
The old experimental website remains separate and was not used as the base.

| Check | Current update result |
| --- | --- |
| Frontend and companion TypeScript | Passed |
| Frontend regression tests | 361 passed, 0 failed |
| Real FFmpeg 6.1.1 companion tests | 45 passed, 0 skipped |
| Real Chrome playback | 17 scenarios passed on native-HLS and again on forced-MSE paths; Linux CI also passed |
| Production browser | 3 passed: offline/private cache boundary, plain-LAN auth worker, real two-tab update/cache retirement |
| Proxy authentication | Exact HTTPS origin/Host, spoof rejection, cookie/CSRF renewal and account switch regressions passed |
| Visual check | 390px player and 1440px settings inspected; no viewport overflow |
| Impeccable detector | No findings on changed player/settings components |
| Live Zima, TorBox, Nuvio account, NPM or Cloudflare | Not exercised; deployment-side check required |

Playback regression coverage now includes redirected extensionless HLS, paused
seeks, brief 502 heartbeat recovery, 401 renewal, source switching with exactly
one active video element, and normal-speed conversion without losing the saved
direct-play speed. Sync tests cover account/profile isolation, ordered settings,
addons and progress, delayed logout/sign-in races, stale 401 responses and late
profile reads. Tests use generated media and synthetic authentication only.

The production build is 580.67 kB main JS (182.61 kB gzip), with a 1,277.74 KiB PWA
precache. It is larger than the September 5 build because this update integrates
new upstream controls and decoder code; no overall bundle-size reduction is
claimed. HLS and AC3 engines remain lazy. First-segment timing for a generated
320×180 long-keyframe remux fixture improved from about 8.1 s to 0.13 s after changing
the bounded initial read burst from 12 s to 20 s. This does not predict real TorBox,
high-bitrate 4K, hardware-accelerated or multihour playback performance.

PWA activation waits for all open tabs' player views and queued account writes,
and for focused editing to finish. Replacing Docker containers still terminates
ephemeral playback sessions; stop playback before applying the container update.
An uncached optional old-build chunk cannot be guaranteed after a server upgrade.

Release digests:

- Web: `sha256:b2e9948c08c408ff93c46e8da884439a4d4582234ac585e3e2d47b970094177a`.
- Companion: `sha256:3fe73dc7d10e13a89fbcb856cd8e3d0c1e4d0ba69e93229ec4a4adf477a9060d`.
- Installer artifact `10181755917`: ZIP SHA256 `65cecb0f23586a9b863bd05a646062d3674170fa6245891108639902711bb0e7`, verified against GitHub's digest.
- Extracted installer matches the checked-in file byte for byte: YAML SHA256 `252d75fe705cab2837dbd957f7035d81b1791526898272f0efbb021b5cc55356`.

The first CI attempt exposed a test-only close/teardown race; it was corrected,
not waived. Forced-MSE playback then exposed and fixed autoplay overriding a
paused seek. The final release contains both regressions and passed all gates.

## Previous verified release — 2026-09-05

## Status

**Private images published and fresh Docker startup/restart verified.
Live ZimaOS dashboard installation remains unverified and needs registry sign-in.**
The source includes lucaboox/nuvio-web through `ec8e3cf10c78eeba6e26a2520b96ace78950e881`,
with companion additions merged into `Squipy411/nuvio-web` main via pull request #1.
The failed Next.js site, including its previous Git history and local data,
was preserved in the sibling `NUVIO-previous-20260905` directory. It is not the
application's foundation. Its security, generated-media testing and single-port
deployment lessons were reused, not its UI or account model.

## Baseline and current results

| Check | Result |
| --- | --- |
| Original upstream install/typecheck/test/build before changes | Passed; 246 tests |
| Current strict frontend typecheck | Passed |
| Current regression suite | **254 passed, 0 failed**, including the author's latest decoder lifecycle fixes and LAN-safe worker IDs |
| Companion strict typecheck | Passed |
| Companion policy/security and real FFmpeg integration suite | **24 passed, 0 failed, 0 skipped** with `NUVIO_MEDIA_TEST=1`, also passed inside the production-equivalent Docker build |
| Real Chrome player suite | **10 scenarios passed** after review fixes; preceding nine-scenario suite also passed twice consecutively |
| Post-polish responsive settings/player check | Passed |
| Production build | Passed; existing large-chunk and English-locale import warnings remain |
| Built PWA shell/offline/private-cache test | **1 passed** |
| Plain LAN HTTP real auth-worker check | **1 passed**; synthetic rejection round-trip, not a live account sign-in |
| Dependency audit, frontend and companion | 0 known vulnerabilities reported at verification time |
| Compose schema and configuration | Passed using Docker Compose **5.5.1** |
| Docker image build/container startup/restart | **Passed** in [release run 33984101019](https://github.com/Squipy411/nuvio-web/actions/runs/33984101019), including the freshly published and pulled images |
| Personal fork | Verified `Squipy411/nuvio-web`; connected as origin with push permission |
| GHCR publishing/authenticated pull | **Both images published and pulled successfully**, pinned to `sha-ff5a372dcd773fcd1ec7f0735c15268b34704c49` |
| GHCR privacy | **Both package settings private; fresh anonymous access denied** locally and in the successful release job |
| Live account sync and physical Apple/Android/Edge devices | **Not tested in this task** |

Compose's downloaded executable was checked against its official release SHA256:
`db1889184726840f75c4f9c001048430d4f25b3be3cb084d3ddd762bc0aed576`.
The validation uses local **test image names** with the exact template, not
fabricated GHCR addresses. Dashboard port_map is a string matching the only
published port, 3075. The icon URL returned HTTP 200.

## Media evidence

Linux x86_64 verification used Node 24.20 and FFmpeg 6.1.1. Fixtures are generated
320×180/24fps color bars with 440Hz and 880Hz audio, generally 24 seconds long.
They are small correctness fixtures, **not 4K performance benchmarks**.

| Fixture | Verified result |
| --- | --- |
| H.264/AAC MP4 | Real browser frames on direct path |
| H.264/AAC HLS | Real native-HLS/HLS.js browser frames; authenticated relay rewrites child resources |
| H.264/AAC MKV | fMP4 HLS remux; ffprobe and FFmpeg decode confirm video/audio copy output |
| H.264/EAC3 MKV | Video stays H.264 copy; audio becomes AAC; real browser frames |
| HEVC/AAC MKV | H.264/AAC conversion when capabilities/preferences require it; real browser frames |
| HEVC Main10/EAC3 MKV | HEVC retained with AAC output when Main10 capability is enabled |
| AV1/Opus WebM | Real H.264/AAC output when AV1 capability is disabled |
| Required Referer/no browser CORS | Same-origin authenticated relay; exact bytes 100–199 and Content-Range match original |
| Multiaudio source | Selecting second track changes decoded audio from approximately 440Hz to 880Hz |
| SRT/ASS text | Timestamp conversion verified; browser loads and displays a two-cue subtitle track |
| Broken source | Finite error; external handoff remains visible; session/temp directory removed |

Measured server startup in representative repeated runs (probe → first generated
fragment fetched/probed/decoded) was approximately **0.4–0.52 seconds** for remux
and H.264 audio-only conversion, and **0.6–0.95 seconds** for these small HEVC/AV1
fixtures. Browser scenario times include navigation, frame checks and close; they
are not isolated playback startup metrics. No before/after time is claimed for
upstream companion playback because upstream did not have this server path.

The browser suite checks actual decoded-frame counts and media time, not just a
Play button. It exercises pause/resume, 4-second resume, repeated seeks to 16/5/12
seconds, real audio-output change requests, subtitle cues, keyboard mute/volume,
fullscreen, closing and the final original-timeline progress checkpoint.
The server independently tests seeks to 16/4/20 seconds, FFmpeg process suspension
on pause, resumed production, conversion concurrency rejection, cancellation and
empty temporary session directories after stop.

The tests caught and fixed native-HLS transport recovery, temporary pause versus
user pause during rapid seeking, queued source changes, stale-generation
heartbeats and retaining original-timeline progress through player teardown.
The release checks also reproduced and fixed the original worker's HTTP-LAN
`randomUUID` startup failure without weakening randomness. HLS reader URLs now
retain safe media-type suffixes for FFmpeg 7's extension checks while keeping
provider paths and secrets opaque; TS, fMP4 and extensionless HLS are tested.
Review regressions verify that progress continues after falling back to the
original browser player, and that 15,000 two-second live-playlist windows do not
exhaust the opaque-resource registry. The latter is a simulated clock test of
resource retention, not an eight-hour high-bitrate streaming benchmark.

## Performance and visual evidence

- Initial JavaScript: **913.97 KB → 536.90 KB** minified (about **41% smaller**).
  Gzip: **268.29 KB → 168.73 KB** (about **37% smaller**).
- PWA initial precache: approximately **2803 KiB → 753.82 KiB** (about **73% smaller**).
  HLS.js and MediaBunny/AC3 engines load and cache on demand. Total optional
  decoder code was not removed; startup no longer fetches/parses it all eagerly.
- The actual production build registers a service worker, reloads its sign-in
  shell offline, and refuses to supply a cached companion API response offline.
- Desktop sign-in and playback settings, plus 390px mobile player, were visually
  checked. Settings retain the existing palette, controls and spacing. No
  horizontal viewport overflow was detected. Browser page-error collections
  were empty in the successful playback cases.
- Impeccable's mechanical detector returned no findings for the changed player
  and companion settings components. React review drove lazy loading, cleanup
  ownership, secret-free worker integration and accessible capability-gated UI.

## Honest remaining limits / next release gates

1. The owner explicitly chose private images. Authenticate the actual Zima
   Docker environment to GHCR once before importing the installer. Never put
   a token in Compose, source, a command-line password argument or this chat.
   Upstream has no explicit redistribution license; obtain permission before
   any later public distribution.
2. Docker build and production-stack smoke checks now pass on GitHub's Docker
   host. Still perform an actual ZimaOS import, dashboard launch and restart test.
   The root `docker-compose.zima.yml` matches the workflow's generated installer
   and references the actual verified private images. It requires registry
   authentication, not a local build or any manual FFmpeg/Node installation.
3. Sign in with a real Nuvio account and verify profiles, addons, home, search,
   details, episode/source navigation, cloud progress and reload. Existing
   contracts pass regression tests; the browser player fixture uses explicitly
   test-only authentication and is **not** evidence of live cloud sign-in.
4. Test physical iOS/iPadOS Safari, Android standalone, desktop Safari/Firefox/
   Edge, PWA update replacement and multiple browser tabs. Chrome's native-HLS
   reporting is not evidence that Safari was tested.
5. Exercise long-running/high-bitrate media, real 4K/HDR/Dolby Vision devices,
   and interrupted internet connections. Validate storage-cap eviction under
   sustained load, not just normal stop cleanup. Embedded MKV subtitle extraction
   and image subtitles are not implemented; addon text subtitles and external
   handoff are the supported alternatives.

The initial GHCR packages were briefly publicly pullable; the release privacy
check blocked installer emission. Both package settings were changed to private,
fresh anonymous requests were denied, and the publishing job was rerun successfully.
The images contain code and public backend configuration, not personal account data.
No personal account credentials were requested, copied or committed. No changes
were pushed to the original author's repository.

Verified registry digests for the released commit tag:

- Web: `sha256:e626f221509c89f906aae3bc5407c40a7dc13c52ac64187efbe486961a06fef5`.
- Companion: `sha256:1212e417ec6226032a519a8d784eb0c71d01fd16d85e3076bbc0c4e72840bc6b`.
- Installer ZIP: `sha256:47e7ec8e0620914080f1e4fd34d9e5a9cb212247f6a97207b413f5b8f395c829`.
