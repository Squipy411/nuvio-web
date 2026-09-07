import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const discover = readFileSync(
  fileURLToPath(new URL("../src/components/Discover.tsx", import.meta.url)),
  "utf8",
);

/**
 * The heading rule, lifted out of the component so the shape can be asserted
 * on rather than described. Kept identical on purpose: this file is the guard,
 * and a divergence here is the failure it exists to catch.
 */
const heading = (name, type, count) => {
  const typeLabel =
    type === "movie"
      ? "Movies"
      : type === "series"
        ? "Series"
        : type.charAt(0).toUpperCase() + type.slice(1);
  return `${name.trim() || "Search"} • ${typeLabel} | ${count}`;
};

test("a result row is named by its catalog, its type and its count", () => {
  assert.equal(heading("Search", "movie", 5), "Search • Movies | 5");
  assert.equal(heading("Search", "series", 12), "Search • Series | 12");
  assert.equal(heading("Popular", "anime", 1), "Popular • Anime | 1");
  // A catalog with no name of its own still reads as something.
  assert.equal(heading("  ", "movie", 3), "Search • Movies | 3");

  // The component builds the same string, and no longer prints the addon's
  // name beside a type it has already said.
  assert.match(
    discover,
    /\$\{group\.name\.trim\(\) \|\| "Search"\} • \$\{typeLabel\(group\.type\)\} \| \$\{group\.items\.length\}/,
  );
  assert.doesNotMatch(discover, /subtitle=\{`\$\{group\.addonName\}/);
});

test("catalogs that found nothing are dropped, and finding nothing is said once", () => {
  // Only populated groups reach the page.
  assert.match(
    discover,
    /resultGroups\.filter\(\(group\) => group\.items\.length > 0\)/,
  );
  assert.match(discover, /\{foundGroups\.map\(\(group\) => \(/);
  assert.doesNotMatch(discover, /No matches from this catalog/);

  // And when none of them found anything, one line carries the whole answer —
  // with no "0 titles across 0 catalogs" above it.
  assert.match(discover, /foundGroups\.length === 0 \? \(/);
  assert.match(discover, /No results for “\{query\}”/);
  assert.match(
    discover,
    /\(!searching \|\| searchPending \|\| foundGroups\.length > 0\) && \(/,
  );
});
