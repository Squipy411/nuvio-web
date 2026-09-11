# Update your existing Nuvio app

Release: `c823071939707f1618d97d3a28eea88b6046e5ff`.
Apply only after the [release workflow](https://github.com/Squipy411/nuvio-web/actions/runs/34553360693)
shows **Success**. Both images stay private.

## 1. Download the update on Zima

Stop playback first. Paste these two commands into the **Zima terminal**, one
at a time. Your successful registry login is already saved in `/DATA/docker-auth`.

```sh
sudo docker --config /DATA/docker-auth pull ghcr.io/squipy411/nuvio-web-web:sha-c823071939707f1618d97d3a28eea88b6046e5ff
sudo docker --config /DATA/docker-auth pull ghcr.io/squipy411/nuvio-web-companion:sha-c823071939707f1618d97d3a28eea88b6046e5ff
```

If both finish successfully, continue. If access is denied, renew the registry
login using [the existing instructions](SELF_HOSTING.md#ghcr-publishing-and-updates).
Do not paste your token into chat or the Docker configuration.

## 2. Edit the existing dashboard app

Open Nuvio's **Edit / Docker configuration** in ZimaOS. Save a copy of the current
configuration so you can roll back. Replace only these two image values:

**Web image**

```text
ghcr.io/squipy411/nuvio-web-web:sha-c823071939707f1618d97d3a28eea88b6046e5ff
```

**Companion image**

```text
ghcr.io/squipy411/nuvio-web-companion:sha-c823071939707f1618d97d3a28eea88b6046e5ff
```

Keep your existing ports, network, environment values and limits. Save/apply the
edit to recreate both containers. **Do not delete the app or reinstall it.** A
plain Restart keeps running the old image. ZimaOS versions differ; if the editor
shows only one container, check the existing configuration before proceeding.

## 3. Open Nuvio and check it

Use the same dashboard icon/address as before (normally `http://YOUR-ZIMA-IP:3075`).
Close and reopen old Nuvio tabs once for this upgrade. Sign into the same Nuvio
account and profile. In Settings → Playback, use **Automatic**, choose **1080p**
for compatibility conversion, and confirm the companion is connected. Direct
playback and remux keep original video quality.

Test a working cached source, pause, seek, change audio/subtitles, then close
playback and check its saved progress on your other device. These are the live
account/provider checks that generated-media tests cannot replace.

For your public hostname, follow [Nginx Proxy Manager / Cloudflare setup](PROXY_SETUP.md).
Set your exact allowed origin and Nuvio user ID before exposing it publicly.
Cloudflare public-tunnel video restrictions still apply to companion media.

To roll back, restore **both** old image values from your saved configuration and
apply it. Updating/restarting removes temporary playback sessions, not your cloud
account data; choose the source again to resume from the last saved checkpoint.
