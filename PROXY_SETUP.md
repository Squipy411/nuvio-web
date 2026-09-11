# HTTPS access: Nginx Proxy Manager and Cloudflare Tunnel

Use a dedicated hostname such as **https://watch.example.com/**. Keep the app at
the domain root, not `/nuvio/`. Only the web container's port **3075** is exposed;
never route directly to companion port 3101. No backend account migration or
separate companion hostname is needed.

## First: keep access private

In the existing Zima app's Docker configuration, add these companion environment
values using **your own** domain and Nuvio account ID:

```yaml
COMPANION_PUBLIC_ORIGINS: "https://watch.example.com"
COMPANION_ALLOWED_USERS: "YOUR_NUVIO_USER_ID"
```

The origin is the complete browser scheme, hostname and optional port, with no
path or wildcard. To retain LAN access as well, explicitly include its address,
for example `https://watch.example.com,http://192.168.1.10:3075`. Do not copy that
example IP unless it is actually yours. Empty origins preserve the same-Host LAN
behavior; empty allowed users permit any valid account on the configured Nuvio
backend, not anonymous access. Set both before public exposure.

The outer proxy must preserve the browser's **Host** header. The companion checks
it against the exact browser **Origin**, then the configured origin allowlist.
It does not trust client-supplied `Forwarded` or `X-Forwarded-*` values. HTTPS
browser sessions receive `Secure; HttpOnly; SameSite=Strict` cookies even though
the private Docker hop is HTTP. Playback mutations still require their CSRF
token. Do not enable wildcard CORS or strip cookies/Authorization headers.

## Nginx Proxy Manager: simple setup

Create or edit the Nuvio Proxy Host:

| Setting | Value |
| --- | --- |
| Domain Names | Your dedicated hostname, e.g. `watch.example.com` |
| Scheme | `http` |
| Forward Hostname / IP | Your Zima LAN IP |
| Forward Port | `3075` |
| Cache Assets | **Off** |
| SSL | Valid certificate for that hostname; Force SSL for direct HTTPS access |
| Advanced | Paste [nginx-proxy-manager-advanced.conf](deployment/nginx-proxy-manager-advanced.conf) |

NPM's standard proxy template preserves the hostname. Use standard HTTPS port
443; if you intentionally expose a nonstandard browser port, the outer proxy
must preserve that port in Host as well. No custom location or extra proxy path
is necessary. WebSocket support is not required for companion HTTP/HLS playback.
NPM can instead reach the web container on a shared private Docker network, but
the LAN-IP setup avoids changing an existing stack's networks.
[NPM proxy defaults](https://github.com/NginxProxyManager/nginx-proxy-manager/blob/develop/docker/rootfs/etc/nginx/conf.d/include/proxy.conf),
[NPM networking guidance](https://nginxproxymanager.com/advanced-config/).

Keep **Cache Assets off**: NPM's asset-cache configuration can ignore upstream
cache and cookie controls. This can also make an old service-worker script or
app bundle linger after an update. The app already caches its versioned static
assets. API responses and private media explicitly send no-store controls;
media bytes should flow immediately, with `Range`/`If-Range` preserved.
[NPM asset-cache configuration](https://github.com/NginxProxyManager/nginx-proxy-manager/blob/develop/docker/rootfs/etc/nginx/conf.d/include/assets.conf).

If using Cloudflare DNS with direct NPM access for video, **DNS-only** traffic to
NPM is distinct from Cloudflare's proxied CDN/Tunnel path. It requires your own
reachable network/TLS configuration and does not hide your origin IP. A private
VPN is another option; this guide does not open router ports automatically.

## Cloudflare Tunnel: application access

**Important:** technical compatibility is not unlimited video-delivery permission.
Cloudflare's current Tunnel documentation says public-hostname routes on Free,
Pro and Business require an appropriate paid service for video/large-file
delivery. Cache bypass does not remove that requirement. A direct TorBox/provider
request from the browser does not traverse this app's tunnel, but **companion
relay, remux and conversion media do**. For that traffic, use a permitted setup
such as private access/VPN, direct NPM access, or an arrangement Cloudflare
explicitly permits. Do not assume a paid web plan alone allows this workload.
[Cloudflare Tunnel routing and video restrictions](https://developers.cloudflare.com/tunnel/routing/).

For an existing tunnel, configure the public hostname route:

| Setting | Value |
| --- | --- |
| Public hostname | The same dedicated hostname in `COMPANION_PUBLIC_ORIGINS` |
| Service type | HTTP |
| Service URL | `ZIMA-IP:3075`, reachable from the cloudflared container |
| HTTP Host Header | The public hostname, e.g. `watch.example.com` |
| Disable Chunked Encoding | Off |
| HTTP/2 to origin | Off for this HTTP origin |

Pointing directly to the web port avoids an unnecessary NPM hop. If you choose
Tunnel → NPM, preserve the same Host and avoid a Force SSL redirect loop on an
HTTP origin; use a correctly verified HTTPS NPM origin if its host forces HTTPS.
Do not disable TLS certificate validation to conceal a certificate mismatch.
Inside a cloudflared container, `localhost` identifies that container, not Zima.
A locally managed example is in
[cloudflared.example.yml](deployment/cloudflared.example.yml).
[Cloudflare origin settings](https://developers.cloudflare.com/tunnel/advanced/origin-parameters/).

Create a **Cache Rule: Bypass cache** for the Nuvio hostname while validating the
deployment. At minimum `/api/companion/*`, the app shell and service-worker files
must never be forced into an edge cache. Do not use Cache Everything or override
the origin's no-store directives. Optional optimization later can target only
hashed `/assets/` files. Companion responses include `Cache-Control`,
`CDN-Cache-Control`, and `Cloudflare-CDN-Cache-Control: no-store`. Review existing
rules for the hostname; a tunnel inherits them.
[Cloudflare cache behavior](https://developers.cloudflare.com/cache/concepts/default-cache-behavior/),
[Tunnel hostname settings](https://developers.cloudflare.com/tunnel/routing/).

Keep Cloudflare Access, WAF, and bot challenges consistent across the hostname.
If Access is enabled, complete its login in the same browser before opening
Nuvio; an HTML login/challenge response cannot be played as a video segment.
Do not add blanket WAF/Access bypasses as a playback fix. External player handoff
cannot be assumed to carry a browser's Access or companion cookies.

Timeout changes cannot make slow CPU conversion real-time. The app uses bounded
requests and short HLS segments; NPM's 90-second timeout is an idle upstream-read
limit, not a movie-duration limit. Cloudflare edge limits are separate and are
not raised by editing Nginx. A 524/502 needs diagnosis of the source, conversion
speed, and proxy path; do not solve it with unbounded timeouts.
[Cloudflare connection limits](https://developers.cloudflare.com/fundamentals/reference/connection-limits/).

## Check it without losing your data

1. Open the HTTPS hostname and sign into the same Nuvio account and profile.
2. In Settings → Playback, check that the companion is reachable. Test one
   known-good source, pause/resume, and seek in both directions.
3. Confirm `/api/companion/healthz` returns JSON, not a proxy login/error page.
   Private playback URLs opened without a Nuvio session must reject access.
4. Check a companion media response in browser Network tools: no-store headers,
   no edge cache HIT, and byte-range requests returning 206 where applicable.
5. Open another device on the same account/profile and check the last saved
   progress. Keep one canonical hostname for daily use: local-only preferences
   and installed PWA storage are separate for each origin, even when cloud
   account/profile data is the same.

Proxy authentication/origin behavior is regression-tested with simulated HTTPS
headers over HTTP. Real NPM, a live Cloudflare account/tunnel, and the user's
Zima dashboard configuration still need this deployment-side check. No tunnel
token, GitHub token, or Nuvio credential belongs in these example files.
