import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { menuPosition, readOptions } from "../src/lib/selectMenu.ts";
import { tooltipPosition } from "../src/lib/tooltip.ts";

const view = { width: 1280, height: 800 };

test("options are read through the conditionals they are written with", () => {
  // What `Children.toArray` is for: a list is almost never a flat run of
  // literal elements, and an option that never reached the menu would be a
  // value you could hold but not choose.
  // Real elements, not a hand-rolled shape: React identifies its own by a
  // symbol that has changed name between versions, and a fake one is read as
  // a plain object and thrown out.
  const option = (value, label, disabled) =>
    createElement("option", { key: value, value, disabled }, label);
  const options = readOptions([
    option("all", "All seasons"),
    [option("1", "Season 1"), option("2", "Season 2")],
    false,
    null,
    option("0", "Specials", true),
    "stray text",
  ]);
  assert.deepEqual(
    options.map((entry) => entry.value),
    ["all", "1", "2", "0"],
  );
  assert.equal(options[0].label, "All seasons");
  assert.equal(options[3].disabled, true);
  assert.equal(options[1].disabled, false);
});

test("an option with no value of its own is named by its text", () => {
  const options = readOptions([
    createElement("option", { key: "a" }, "Not supported"),
  ]);
  assert.equal(options[0].value, "Not supported");
});

test("a list opens downwards, and upwards only when it would not fit", () => {
  const field = { top: 100, bottom: 140, left: 40, width: 200 };
  assert.equal(menuPosition(field, 200, view).top, 144);

  // Near the bottom there is no room underneath, so it goes above the field
  // rather than off the window.
  const low = { top: 700, bottom: 740, left: 40, width: 200 };
  assert.equal(menuPosition(low, 200, view).top, 496);
});

test("a list is never narrower than readable, nor off the side", () => {
  const narrow = { top: 10, bottom: 50, left: 20, width: 60 };
  assert.equal(menuPosition(narrow, 100, view).width, 160);

  // A field against the right edge opens a list that stays on screen.
  const edge = { top: 10, bottom: 50, left: 1240, width: 200 };
  const placed = menuPosition(edge, 100, view);
  assert.ok(placed.left + placed.width <= view.width, "runs off the right");
  assert.ok(placed.left >= 8, "runs off the left");
});

test("a tooltip sits above its target until there is no room", () => {
  const middle = { top: 400, bottom: 430, left: 600, width: 40 };
  const above = tooltipPosition(middle, { width: 120, height: 28 }, view);
  assert.equal(above.placement, "above");
  assert.equal(above.top, 364);
  // Centred on the target.
  assert.equal(above.left, 560);

  const top = { top: 4, bottom: 34, left: 600, width: 40 };
  assert.equal(tooltipPosition(top, { width: 120, height: 28 }, view).placement, "below");
});

test("a tooltip in a corner stays inside the window", () => {
  const corner = { top: 400, bottom: 430, left: 2, width: 30 };
  assert.equal(tooltipPosition(corner, { width: 200, height: 28 }, view).left, 8);

  const far = { top: 400, bottom: 430, left: 1250, width: 30 };
  const placed = tooltipPosition(far, { width: 200, height: 28 }, view);
  assert.ok(placed.left + 200 <= view.width);
});

test("the platform list is suppressed, and only where there is a mouse", () => {
  const source = readFileSync(
    fileURLToPath(new URL("../src/components/Select.tsx", import.meta.url)),
    "utf8",
  );
  // Preventing the mousedown default is the only way to stop the platform
  // drawing its own list over ours.
  assert.match(source, /event\.preventDefault\(\);\s*\n\s*if \(rest\.disabled\) return;/);
  // A phone keeps its own picker, which is better than anything here.
  assert.match(source, /\(hover: hover\) and \(pointer: fine\)/);
  // And the element itself stays: it is what the stylesheets target, what a
  // screen reader announces, and what holds the value.
  assert.match(source, /<select\n\s*\{\.\.\.rest\}/);
});

test("nothing renders a native select any more", () => {
  for (const file of [
    "../src/App.tsx",
    "../src/components/Collections.tsx",
    "../src/components/Details.tsx",
    "../src/components/Discover.tsx",
    "../src/components/PlaybackPolicySettings.tsx",
    "../src/components/Player.tsx",
    "../src/components/PluginSettings.tsx",
  ]) {
    const source = readFileSync(fileURLToPath(new URL(file, import.meta.url)), "utf8");
    assert.doesNotMatch(source, /<select[\s>]/, `${file} still opens a native list`);
  }
});
