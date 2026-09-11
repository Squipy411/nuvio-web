import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request } from "node:http";

const directory = await mkdtemp(join(tmpdir(), "nuvio-compose-check-"));
const path = join(directory, "compose.yml");
const template = await readFile(new URL("../deployment/compose.zima.template.yml", import.meta.url), "utf8");
await writeFile(path, template.replaceAll("@@WEB_IMAGE@@", "nuvio-web:ci").replaceAll("@@COMPANION_IMAGE@@", "nuvio-companion:ci").replaceAll("@@ICON_URL@@", "https://lucaboox.github.io/nuvio-web/app-icon-1024.png").replace('COMPANION_PUBLIC_ORIGINS: ""', 'COMPANION_PUBLIC_ORIGINS: "https://watch.nuvio.invalid"'));
const binary = process.env.COMPOSE_BINARY || "docker";
const prefix = process.env.COMPOSE_BINARY ? [] : ["compose"];
const args = [...prefix, "-p", "nuvio-ci-smoke", "-f", path];
const compose = (...tail) => execFileSync(binary, [...args, ...tail], { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] });
const configOnly = process.argv.includes("--config-only");
let started = false;
try {
  const config = JSON.parse(compose("config", "--format", "json"));
  assert.equal(config.services.web.ports.length, 1);
  assert.equal(config.services.web.ports[0].published, "3075");
  assert.equal(config.services.companion.ports, undefined);
  assert.equal(config["x-casaos"].port_map, "3075");
  assert.equal(config.services.companion.build, undefined);
  assert.equal(config.services.companion.environment.COMPANION_PUBLIC_ORIGINS, "https://watch.nuvio.invalid");
  console.info("Compose validated: one published port, private companion, matching dashboard metadata, prebuilt images only.");
  if (!configOnly) {
    started = true; compose("up", "-d", "--wait", "--wait-timeout", "90", "--pull", "never");
    const check = async () => {
      const base = "http://127.0.0.1:3075";
      assert.equal((await fetch(base)).status, 200);
      const healthResponse = await fetch(base + "/api/companion/healthz");
      const health = await healthResponse.json(); assert.match(health.ffmpeg, /ffmpeg version/);
      for (const header of ["cache-control", "cdn-cache-control", "cloudflare-cdn-cache-control"]) assert.equal(healthResponse.headers.get(header), "no-store", header);
      assert.equal(healthResponse.headers.get("x-accel-buffering"), "no");
      assert.equal((await fetch(base + "/api/companion/sessions", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).status, 401);
      const publicConfig = await (await fetch(base + "/api/companion/config")).json();
      // Use node:http: the Fetch implementation may ignore an explicit Host.
      const auth = (origin, host = "watch.nuvio.invalid", forwarded = {}) => new Promise((resolve, reject) => {
        const req = request(base + "/api/companion/auth", { method: "POST", headers: { host, origin, "content-type": "application/json", ...forwarded } }, (res) => {
          res.resume(); res.on("end", () => resolve(res.statusCode)); res.on("error", reject);
        });
        req.on("error", reject); req.end(JSON.stringify({ backend: publicConfig.backendUrl }));
      });
      // No live account/token: a valid origin reaches the missing-login check,
      // while a wrong scheme, hostname or spoofed forwarding chain fails CSRF.
      assert.equal(await auth("https://watch.nuvio.invalid"), 401);
      assert.equal(await auth("http://watch.nuvio.invalid"), 403);
      assert.equal(await auth("https://evil.invalid", "evil.invalid"), 403);
      assert.equal(await auth("https://watch.nuvio.invalid", "companion:3101", { "x-forwarded-host": "watch.nuvio.invalid", "x-forwarded-proto": "https", forwarded: "host=watch.nuvio.invalid;proto=https" }), 403);
      const shell = await fetch(base + "/index.html"); assert.match(shell.headers.get("cache-control"), /no-cache/);
      assert.ok(shell.headers.get("content-security-policy"));
    };
    await check(); compose("restart"); compose("up", "-d", "--wait", "--wait-timeout", "90"); await check();
    console.info("Production containers healthy before and after restart; authentication, public-origin allowlist, no-store CDN policy, and unbuffered proxy headers verified.");
  }
} finally { if (started) compose("down", "--remove-orphans"); await rm(directory, { recursive: true, force: true }); }
