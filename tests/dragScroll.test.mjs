import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

const src = readFileSync(
  new URL("../src/lib/useDragScroll.ts", import.meta.url),
  "utf8",
);

test("drag scrolling binds when a conditional row arrives after its owner", () => {
  // Search opens Details before its enriched cast is available. A listener
  // effect keyed to [] therefore only observed a null ref, leaving the later
  // cast row unable to drag-scroll on desktop.
  assert.match(
    src,
    /useLayoutEffect\(\(\) => \{\s*setNode\(/,
    "the ref node must be refreshed after every render",
  );
  assert.match(
    src,
    /node\.addEventListener\("pointerdown"/,
    "the mouse drag listener must remain attached to the resolved node",
  );
  assert.match(
    src,
    /\}, \[node\]\);/,
    "the listener effect must follow the current row node",
  );
  assert.doesNotMatch(
    src,
    /\}, \[\]\);/,
    "a mount-only effect cannot see a cast row rendered after search loading",
  );
});
