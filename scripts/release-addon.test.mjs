import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { entryFor, nameOf, nextBundle, retag, setTocVersion, subjects } from "./release-addon.mjs";

const bundle = () => ({
  addons: [
    { folder: "Ryna_Core", repo: "Ryna-Mods/core", tag: "v0.5.1", sha256: "a".repeat(64) },
    { folder: "Ryna_Chronicle", repo: "Ryna-Mods/chronicle", tag: "v0.7.1", sha256: "b".repeat(64), minApp: "0.5.1" },
  ],
});

test("the next bundle is one patch past the newest tag, whatever order they come in", () => {
  assert.equal(nextBundle(["v0.5.9", "v0.5.10", "v0.5.2", "not-a-version", ""]), "0.5.11");
  assert.equal(nextBundle(["v0.5.1"]), "0.5.2");
  assert.throws(() => nextBundle(["nightly"]), /no vX\.Y\.Z tag/);
  assert.throws(() => nextBundle(["v0.5.999"]), /under 1000/);
});

test("an addon is found by its repository's name, and only once", () => {
  assert.equal(entryFor(bundle(), "chronicle").folder, "Ryna_Chronicle");
  assert.throws(() => entryFor(bundle(), "meter"), /0 addons from Ryna-Mods\/meter/);
  assert.throws(() => entryFor(bundle(), "Ryna_Chronicle"), /named as its repository/);
  assert.throws(() => entryFor(bundle(), "../chronicle"), /named as its repository/);
});

test("retagging moves one addon's tag and leaves everything else as it was", () => {
  const before = bundle();
  const after = retag(before, "chronicle", "0.7.2");
  assert.equal(after.addons[1].tag, "v0.7.2");
  assert.equal(after.addons[1].minApp, "0.5.1");
  assert.deepEqual(after.addons[0], before.addons[0]);
  assert.equal(before.addons[1].tag, "v0.7.1", "the bundle passed in isn't changed");
});

test("a version that isn't newer, or isn't a version, is refused", () => {
  assert.throws(() => retag(bundle(), "chronicle", "0.7.1"), /isn't newer/);
  assert.throws(() => retag(bundle(), "chronicle", "0.6.9"), /isn't newer/);
  assert.throws(() => retag(bundle(), "chronicle", "0.8"), /X\.Y\.Z/);
  assert.throws(() => retag(bundle(), "chronicle", "v0.8.0"), /X\.Y\.Z/);
});

test("a TOC's version is set in place, whatever its line endings", () => {
  const toc = "## Interface: 16001\r\n## Version: 0.7.1\r\n## Dependencies: Ryna_Core\r\n";
  assert.equal(setTocVersion(toc, "0.7.2"), toc.replace("0.7.1", "0.7.2"));
  assert.equal(setTocVersion(toc, "0.7.1"), toc);
  assert.throws(() => setTocVersion("## Interface: 16001\n", "1.0.0"), /no ## Version/);
});

test("the commit subjects name the addon as people do", () => {
  assert.equal(nameOf("Ryna_Core"), "Ryna Core");
  assert.deepEqual(subjects({ folder: "Ryna_Chronicle", repo: "Ryna-Mods/chronicle", version: "0.7.2", what: "a fix" }), {
    addon: "Chronicle 0.7.2: a fix",
    bundle: "Chronicle 0.7.2 joins the bundle: Ryna-Mods/chronicle v0.7.2 (a fix)",
    app: "mods: the app carries Chronicle 0.7.2 (a fix)",
  });
});

test("every addon in the real bundle.json can be named for a release", () => {
  const real = JSON.parse(readFileSync(new URL("../bundle.json", import.meta.url), "utf8"));
  for (const a of real.addons) assert.equal(entryFor(real, a.repo.replace("Ryna-Mods/", "")).folder, a.folder);
});
