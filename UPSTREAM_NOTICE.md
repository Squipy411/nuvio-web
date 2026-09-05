# Upstream and personal-fork notice

Original project: [lucaboox/nuvio-web](https://github.com/lucaboox/nuvio-web).
Baseline inspected: `3769f5b31c3f3d9194c28571a6bb67f93ac05996` (2026-09-04).
Existing credits, logos, source structure and documentation are retained.
This personal modification is **not an official Nuvio Media release**.

No repository-level LICENSE or COPYING file was present at that revision.
Public source availability does not by itself supply a redistribution license.
Do not treat these modifications as permission to distribute upstream code,
logos, fonts or public container builds. Obtain the appropriate permission or
license before wider distribution. Do not add a blanket MIT license to this fork.

The public backend URL and **anonymous client key**, in
`deployment/defaults.json`, match the upstream public web client's configuration
observed on 2026-09-05. They are not server secrets or service-role credentials.
The companion validates the user's bearer session with that backend; merely
knowing the anonymous key cannot authorize playback sessions. A configured
privileged backend key is rejected at companion startup.

The test videos are locally generated color bars and sine waves. No commercial
movies, subscription credentials or protected media are included. Encrypted HLS
is rejected; no DRM decryption or access-control bypass is implemented.

## Updating from upstream

Keep `origin` pointed to your personal fork and `upstream` pointed to the original.
Make a clean checkpoint or safely stash your changes before merging.

```sh
git remote add upstream https://github.com/lucaboox/nuvio-web.git # only if missing
git fetch upstream
git switch -c codex/upstream-update
git merge upstream/main
npm ci
npm --prefix companion ci
npm run check
npm test
npm run build
npm --prefix companion run check
NUVIO_MEDIA_TEST=1 npm --prefix companion test
```

Review conflicts especially at `Player.tsx`, the optional platform auth method,
the auth Worker, addon subtitle mapping and Vite's PWA configuration. Do not
replace account payloads with a new schema. Native desktop playback continues
through the original platform capability. If the web companion is unavailable,
the original browser fallback remains available.
