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
  assert.match(styles, /--detail-art-height:\s*min\(720px, 82vh\)/);
  assert.match(styles, /--detail-art-height:\s*clamp\(620px, 84svh, 880px\)/);
  assert.doesNotMatch(detailHeroMarkup, /backgroundImage/);
  assert.match(detailHeroMarkup, /"--detail-backdrop"/);
});
