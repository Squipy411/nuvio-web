import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { virtualRange, virtualSpacers } from "../src/lib/useVirtualList.ts";

const details = readFileSync(new URL("../src/components/Details.tsx", import.meta.url), "utf8");
const virtualList = readFileSync(new URL("../src/lib/useVirtualList.ts", import.meta.url), "utf8");
const styles = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");

test("very large seasons keep only a viewport-sized window mounted", () => {
  assert.match(details, /useVirtualList\(visibleEpisodes/);
  assert.match(details, /overscan:\s*8/);
  assert.match(details, /renderedEpisodes\.map/);
  assert.doesNotMatch(details, /visibleEpisodes\.map/);
  assert.match(virtualList, /document\.addEventListener\("scroll", schedule/);
  assert.match(virtualList, /items\.slice\(state\.start, state\.end\)/);
  assert.match(virtualList, /beforeSize/);
  assert.match(virtualList, /afterSize/);

  const window = virtualRange(1_400, 60_000, 60_800, 154, 18, 8);
  assert.ok(window.start > 0);
  assert.ok(window.end < 1_400);
  assert.ok(window.end - window.start <= 22);
  const spacers = virtualSpacers(1_400, window.start, window.end, 154, 18);
  assert.ok(spacers.beforeSize > 0);
  assert.ok(spacers.afterSize > 0);
});

test("source selectors occupy their own bounded row", () => {
  assert.match(styles, /\.source-column > header\s*\{[^}]*display:\s*grid/s);
  assert.match(styles, /\.source-sheet-tools\s*\{[^}]*grid-column:\s*1\s*\/\s*-1[^}]*grid-row:\s*2/s);
  assert.match(styles, /\.source-sheet-tools select\s*\{[^}]*min-width:\s*0[^}]*width:\s*100%[^}]*max-width:\s*100%/s);
});
