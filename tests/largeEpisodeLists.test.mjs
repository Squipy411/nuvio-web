import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const details = readFileSync(new URL("../src/components/Details.tsx", import.meta.url), "utf8");
const incrementalList = readFileSync(new URL("../src/lib/useIncrementalList.ts", import.meta.url), "utf8");
const styles = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");

test("very large seasons mount in bounded chunks instead of all at once", () => {
  assert.match(details, /useIncrementalList\(visibleEpisodes/);
  assert.match(details, /first:\s*40/);
  assert.match(details, /chunk:\s*40/);
  assert.match(details, /renderedEpisodes\.map/);
  assert.doesNotMatch(details, /visibleEpisodes\.map/);
  assert.match(incrementalList, /IntersectionObserver/);
  assert.match(incrementalList, /items\.slice\(0, limit\)/);
});

test("source selectors occupy their own bounded row", () => {
  assert.match(styles, /\.source-column > header\s*\{[^}]*display:\s*grid/s);
  assert.match(styles, /\.source-sheet-tools\s*\{[^}]*grid-column:\s*1\s*\/\s*-1[^}]*grid-row:\s*2/s);
  assert.match(styles, /\.source-sheet-tools select\s*\{[^}]*min-width:\s*0[^}]*width:\s*100%[^}]*max-width:\s*100%/s);
});
