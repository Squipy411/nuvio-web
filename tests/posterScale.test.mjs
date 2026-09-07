import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  POSTER_DEFAULTS,
  POSTER_SCALE_MAX,
  POSTER_SCALE_MIN,
  posterScale,
  posterSizeAt,
} from "../src/lib/webSettings.ts";

test("100% is the default card, and the shape never changes", () => {
  assert.deepEqual(posterSizeAt(100), {
    widthDp: POSTER_DEFAULTS.widthDp,
    heightDp: POSTER_DEFAULTS.heightDp,
  });
  const shape = POSTER_DEFAULTS.widthDp / POSTER_DEFAULTS.heightDp;
  for (let percent = POSTER_SCALE_MIN; percent <= POSTER_SCALE_MAX; percent += 5) {
    const size = posterSizeAt(percent);
    // Whole pixels, so the ratio moves a little; a card off by more than this
    // is a different shape, which is the thing this replaced.
    assert.ok(
      Math.abs(size.widthDp / size.heightDp - shape) < 0.01,
      `${percent}% is ${size.widthDp}x${size.heightDp}`,
    );
  }
});

test("every size the picker offers survives the round trip", () => {
  for (let percent = POSTER_SCALE_MIN; percent <= POSTER_SCALE_MAX; percent += 1)
    assert.equal(
      posterScale(posterSizeAt(percent)),
      percent,
      `${percent}% did not come back as itself`,
    );
});

test("the whole range stays inside what the settings will store", () => {
  for (const percent of [POSTER_SCALE_MIN, 100, POSTER_SCALE_MAX]) {
    const size = posterSizeAt(percent);
    // The bounds posterSettings() clamps to. Outside them a stored value is
    // silently rewritten, which is what made these fields jump about.
    assert.ok(size.widthDp >= 88 && size.widthDp <= 260, `width ${size.widthDp}`);
    assert.ok(size.heightDp >= 112 && size.heightDp <= 390, `height ${size.heightDp}`);
  }
});

test("a width from another client is reported as the nearest size it can offer", () => {
  assert.equal(posterScale({ widthDp: 40 }), POSTER_SCALE_MIN);
  assert.equal(posterScale({ widthDp: 4000 }), POSTER_SCALE_MAX);
});

test("the number fields hold what is typed rather than clamping each keystroke", () => {
  const app = readFileSync(
    fileURLToPath(new URL("../src/App.tsx", import.meta.url)),
    "utf8",
  );
  // A draft, committed only once it is a value the setting accepts, and
  // squared up against the stored value when focus leaves.
  assert.match(app, /const \[draft, setDraft\] = useState\(String\(value\)\)/);
  assert.match(app, /parsed >= min &&\s*\n\s*parsed <= max/);
  assert.match(app, /onBlur=\{\(\) => \{\s*\n\s*setEditing\(false\);/);
  // And no raw number input left on the poster settings.
  assert.doesNotMatch(app, /onPosterSetting\(\{ widthDp: Number\(/);
  assert.doesNotMatch(app, /onPosterSetting\(\{ cornerRadiusDp: Number\(/);
});
