import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const details = readFileSync(new URL("../src/components/Details.tsx", import.meta.url), "utf8");
const styles = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");

test("detail artwork uses the same top-biased crop as the home hero", () => {
  assert.match(styles, /\.hero\s*\{[\s\S]*?background-position:\s*top center;/);
  assert.match(styles, /\.detail-hero::before\s*\{[\s\S]*?background-position:\s*top center;/);
});

test("detail artwork height is independent from description height", () => {
  const detailHeroStart = details.indexOf('className="detail-hero"');
  const detailHeroMarkup = details.slice(detailHeroStart, details.indexOf(">", detailHeroStart));

  assert.match(styles, /\.detail-hero::before\s*\{[\s\S]*?height:\s*var\(--detail-art-height\);/);
  assert.match(styles, /--detail-hero-height:\s*min\(720px, 82vh\)/);
  assert.match(styles, /--detail-hero-height:\s*clamp\(620px, 84svh, 880px\)/);
  assert.doesNotMatch(detailHeroMarkup, /backgroundImage/);
  assert.match(detailHeroMarkup, /"--detail-backdrop"/);
});

test("desktop details reveal the full-width backdrop behind credits and cast", () => {
  assert.match(styles, /\.detail-view \.detail-hero::before\s*\{[\s\S]*?aspect-ratio:\s*16 \/ 9;/);
  assert.match(styles, /background-size:\s*100% 100%, 100% 100%, 100% auto;/);
  assert.match(styles, /\.detail-view\.background-cinematic \.detail-sections\s*\{\s*background:\s*transparent;/);
  assert.match(styles, /\.detail-credits\s*\{[\s\S]*?border-top:\s*0;/);
});
