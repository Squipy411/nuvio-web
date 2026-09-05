import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";

const repository = process.env.GITHUB_REPOSITORY?.toLowerCase();
const commit = process.env.GITHUB_SHA;
assert.match(repository || "", /^[a-z0-9_.-]+\/[a-z0-9_.-]+$/);
assert.match(commit || "", /^[a-f0-9]{40}$/);
for (const component of ["web", "companion"]) {
  const name = `${repository}-${component}`;
  const image = `ghcr.io/${name}:sha-${commit}`;
  // Uses the job's short-lived Docker registry login, never a token in Compose.
  execFileSync("docker", ["pull", image], { stdio: "inherit" });
  execFileSync("docker", ["tag", image, `nuvio-${component}:ci`], { stdio: "inherit" });
  const anonymous = await fetch(`https://ghcr.io/token?service=ghcr.io&scope=${encodeURIComponent(`repository:${name}:pull`)}`, { signal: AbortSignal.timeout(15_000) });
  assert.ok([401, 403].includes(anonymous.status), `Anonymous pulls were not denied for ${name}; review package visibility before releasing.`);
  console.info(`Verified authenticated pull and denied anonymous access: ${image}`);
}
execFileSync(process.execPath, ["scripts/docker-smoke.mjs"], { stdio: "inherit" });
