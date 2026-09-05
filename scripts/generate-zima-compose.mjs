import { execFileSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";

// This build-time generator intentionally refuses to invent a repository or published image.
let repository = process.env.GITHUB_REPOSITORY;
if (!repository) {
  const remote = execFileSync("git", ["remote", "get-url", "origin"], { encoding: "utf8" }).trim();
  repository = /github\.com[/:]([\w.-]+\/[\w.-]+?)(?:\.git)?$/.exec(remote)?.[1];
}
if (!repository || !/^[\w.-]+\/[\w.-]+$/.test(repository) || repository.toLowerCase() === "lucaboox/nuvio-web") throw new Error("Set origin to your actual personal fork before generating the installer.");
const tag = process.env.IMAGE_TAG || "latest";
if (!/^[\w.-]+$/.test(tag)) throw new Error("Invalid image tag");
const prefix = `ghcr.io/${repository.toLowerCase()}`;
const template = await readFile(new URL("../deployment/compose.zima.template.yml", import.meta.url), "utf8");
const compose = template.replace(/^# Release workflow[^\n]*\n# Do not import[^\n]*\n/, "# Personal Nuvio Web fork. Requires published images; see SELF_HOSTING.md.\n")
  .replaceAll("@@WEB_IMAGE@@", `${prefix}-web:${tag}`).replaceAll("@@COMPANION_IMAGE@@", `${prefix}-companion:${tag}`)
  .replaceAll("@@ICON_URL@@", "https://lucaboox.github.io/nuvio-web/app-icon-1024.png");
await writeFile("docker-compose.zima.yml", compose);
console.info(`Generated docker-compose.zima.yml for ${repository} (${tag}); this does not publish images.`);
