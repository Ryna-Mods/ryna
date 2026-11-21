#!/usr/bin/env node
// One addon change, released all the way to the Ryna app, in one command:
//
//   node scripts/release-addon.mjs <addon> <version> "<what changed>" [--dry-run] [--no-app-pin]
//   node scripts/release-addon.mjs chronicle 0.7.2 "a run keeps its place across a login"
//
// An addon reaches a player only after two releases: its own (a zip on Ryna-Mods/<addon>) and then
// this repository's (the signed index the app reads, which names that zip by hash). RELEASING.md has
// the steps by hand; this runs them in order and stops at the first thing that isn't right:
//
//   1. the addon: its TOC's version, its own checks, a signed commit and tag, its release;
//   2. the bundle: bundle.json's tag and pin (one addon changed, nothing else), the tests, a signed
//      commit and the next bundle tag, its release, and the published index read back;
//   3. the app's pin in ryna_agent (a mod's pin.json and mod.json), its checks, a signed commit.
//      Not a release: the next Ryna app carries it. Left to a person for Ryna Core, whose pin moves
//      with the API levels in cores/wow/core.json.
//
// It changes nothing about who may publish: both tags are signed with the key git already uses (so
// 1Password must be unlocked), and each release workflow still checks its tag is signed and on main.
// It is a person's decision to run it: a release needs Maddison's word each time, as before.
//
// Where it looks: the addon's clone beside this one (../<addon>, or $RYNA_MODS_DIR/<addon>) and
// ryna_agent at ../../MaddisonM79/ryna_agent (or $RYNA_AGENT_DIR). Every clone must be on main, clean
// and level with origin. --dry-run checks all of that and prints what it would do.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { CORE, OWN, compareVersions, readBundle, serialOf } from "./publish.mjs";

const VERSION = /^\d+\.\d+\.\d+$/;

/** The bundle version after the newest `vX.Y.Z` tag: one patch up. */
export function nextBundle(tags) {
  const versions = tags.map((t) => /^v(\d+\.\d+\.\d+)$/.exec(t.trim())?.[1]).filter(Boolean);
  if (versions.length === 0) throw new Error("the bundle has no vX.Y.Z tag to count up from");
  const [a, b, c] = versions.sort(compareVersions).at(-1).split(".").map(Number);
  const next = `${a}.${b}.${c + 1}`;
  serialOf(next); // refuses a version the index couldn't carry
  return next;
}

/** The addon's entry in bundle.json, by its repository's short name ("chronicle"). */
export function entryFor(bundle, addon) {
  if (!/^[a-z][a-z0-9-]*$/.test(addon)) throw new Error(`an addon is named as its repository is (not ${addon})`);
  const found = bundle.addons.filter((a) => a.repo === `${OWN}${addon}`);
  if (found.length !== 1) throw new Error(`bundle.json has ${found.length} addons from ${OWN}${addon}`);
  return found[0];
}

/** bundle.json with that addon at `version`, and nothing else touched (pin fills in the hash). */
export function retag(bundle, addon, version) {
  if (!VERSION.test(version)) throw new Error(`a version is X.Y.Z (not ${version})`);
  const entry = entryFor(bundle, addon);
  const now = entry.tag.replace(/^v/, "");
  if (compareVersions(version, now) <= 0) throw new Error(`${entry.folder} is at ${now}: ${version} isn't newer`);
  return { ...bundle, addons: bundle.addons.map((a) => (a === entry ? { ...a, tag: `v${version}` } : a)) };
}

/** An addon as people name it: Ryna_Chronicle is Chronicle, Ryna_Core is Ryna Core. */
export function nameOf(folder) {
  return folder === CORE ? "Ryna Core" : folder.replace(/^Ryna_/, "");
}

/** A TOC's text with its version set; the same text when it already says so. */
export function setTocVersion(toc, version) {
  if (!/^## Version:\s*\S+\s*$/m.test(toc)) throw new Error("the TOC has no ## Version line");
  return toc.replace(/^(## Version:\s*)\S+(\s*)$/m, `$1${version}$2`);
}

/** The three commit subjects, so a dry run shows exactly what would be written. */
export function subjects({ folder, repo, version, what }) {
  const name = nameOf(folder);
  return {
    addon: `${name} ${version}: ${what}`,
    bundle: `${name} ${version} joins the bundle: ${repo} v${version} (${what})`,
    app: `mods: the app carries ${name} ${version} (${what})`,
  };
}

// Everything below runs commands. ---------------------------------------------------------------

function run(cwd, cmd, args, { quiet = false } = {}) {
  if (!quiet) console.log(`  $ ${cmd} ${args.join(" ")}   (${cwd})`);
  return execFileSync(cmd, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"], maxBuffer: 64 * 1024 * 1024 }).trim();
}

/** A clone fit to release from: on main, nothing uncommitted, level with origin, the tag not taken. */
function ready(dir, tag) {
  if (!existsSync(join(dir, ".git"))) throw new Error(`${dir} isn't a git clone`);
  run(dir, "git", ["fetch", "--quiet", "--tags", "origin"], { quiet: true });
  const branch = run(dir, "git", ["rev-parse", "--abbrev-ref", "HEAD"], { quiet: true });
  if (branch !== "main") throw new Error(`${dir} is on ${branch}, not main`);
  if (run(dir, "git", ["status", "--porcelain"], { quiet: true })) throw new Error(`${dir} has uncommitted changes`);
  const head = run(dir, "git", ["rev-parse", "HEAD"], { quiet: true });
  if (head !== run(dir, "git", ["rev-parse", "origin/main"], { quiet: true })) {
    throw new Error(`${dir} isn't level with origin/main: pull or push first`);
  }
  if (tag && run(dir, "git", ["tag", "--list", tag], { quiet: true })) throw new Error(`${dir} already has the tag ${tag}`);
  return head;
}

/** Push main, prove it landed, then the signed tag: never a tag on a commit that isn't on main. */
function pushAndTag(dir, tag) {
  run(dir, "git", ["push", "--quiet", "origin", "main"]);
  const head = run(dir, "git", ["rev-parse", "HEAD"], { quiet: true });
  run(dir, "git", ["fetch", "--quiet", "origin"], { quiet: true });
  if (head !== run(dir, "git", ["rev-parse", "origin/main"], { quiet: true })) throw new Error(`${dir}: main didn't land on origin`);
  run(dir, "git", ["tag", "-s", tag, "-m", tag]);
  run(dir, "git", ["push", "--quiet", "origin", tag]);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Wait for the release workflow the tag started, and fail if it does. */
async function released(dir, tag) {
  let id;
  for (let i = 0; i < 30 && !id; i++) {
    await sleep(4000);
    const runs = JSON.parse(run(dir, "gh", ["run", "list", "--workflow", "release.yml", "--limit", "10", "--json", "databaseId,headBranch"], { quiet: true }));
    id = runs.find((r) => r.headBranch === tag)?.databaseId;
  }
  if (!id) throw new Error(`${dir}: no release run started for ${tag}`);
  console.log(`  waiting for the release workflow (${tag}, run ${id})`);
  execFileSync("gh", ["run", "watch", String(id), "--exit-status"], { cwd: dir, stdio: "ignore" });
  return JSON.parse(run(dir, "gh", ["release", "view", tag, "--json", "isDraft,assets"], { quiet: true }));
}

/** The addon's main must have passed its own check on the commit being released from. */
function checked(dir, head) {
  const runs = JSON.parse(run(dir, "gh", ["run", "list", "--workflow", "check.yml", "--branch", "main", "--limit", "5", "--json", "headSha,status,conclusion"], { quiet: true }));
  const mine = runs.find((r) => r.headSha === head);
  if (!mine) throw new Error(`${dir}: no check has run on ${head.slice(0, 7)} yet`);
  if (mine.status !== "completed" || mine.conclusion !== "success") {
    throw new Error(`${dir}: the check on ${head.slice(0, 7)} is ${mine.status} ${mine.conclusion ?? ""}`.trim());
  }
}

async function main(argv) {
  const flags = new Set(argv.filter((a) => a.startsWith("--")));
  const [addon, version, what] = argv.filter((a) => !a.startsWith("--"));
  const dryRun = flags.has("--dry-run");
  if (!addon || !version || !what) {
    throw new Error('usage: node scripts/release-addon.mjs <addon> <version> "<what changed>" [--dry-run] [--no-app-pin]');
  }
  const root = dirname(dirname(fileURLToPath(import.meta.url)));
  const bundlePath = join(root, "bundle.json");
  const bundle = JSON.parse(readFileSync(bundlePath, "utf8"));
  readBundle(bundle);
  const next = retag(bundle, addon, version);
  const entry = entryFor(bundle, addon);
  const { folder, repo } = entry;
  const tag = `v${version}`;
  const says = subjects({ folder, repo, version, what });

  const addonDir = resolve(process.env.RYNA_MODS_DIR ?? dirname(root), addon);
  const agentDir = resolve(process.env.RYNA_AGENT_DIR ?? join(dirname(dirname(root)), "MaddisonM79", "ryna_agent"));
  const pinApp = !flags.has("--no-app-pin") && folder !== CORE;

  console.log("Checking the clones");
  const addonHead = ready(addonDir, tag);
  checked(addonDir, addonHead);
  ready(root);
  const bundleVersion = nextBundle(run(root, "git", ["tag", "--list", "v*"], { quiet: true }).split("\n"));
  const bundleTag = `v${bundleVersion}`;
  if (pinApp) ready(agentDir);

  console.log(`\n${nameOf(folder)} ${entry.tag.replace(/^v/, "")} -> ${version}, bundle ${bundleVersion}`);
  console.log(`  ${addonDir}: "${says.addon}", tag ${tag}`);
  console.log(`  ${root}: "${says.bundle}", tag ${bundleTag}`);
  console.log(pinApp ? `  ${agentDir}: "${says.app}"` : `  the app's pin: left to a person${folder === CORE ? " (Ryna Core moves with the API levels)" : ""}`);
  if (dryRun) {
    console.log("\nDry run: nothing was changed.");
    return;
  }

  console.log(`\n1. ${repo} ${tag}`);
  const tocPath = join(addonDir, folder, `${folder}.toc`);
  const toc = readFileSync(tocPath, "utf8");
  const bumped = setTocVersion(toc, version);
  if (bumped !== toc) writeFileSync(tocPath, bumped);
  run(addonDir, "node", ["scripts/version.mjs", "--tag", tag]);
  const check = run(addonDir, "scripts/check.sh", []);
  if (!check.endsWith("all green")) throw new Error(`${addonDir}: scripts/check.sh didn't end "all green"`);
  if (bumped !== toc) {
    run(addonDir, "git", ["add", tocPath]);
    run(addonDir, "git", ["commit", "--quiet", "-m", says.addon]);
  }
  pushAndTag(addonDir, tag);
  const zip = `${folder}-${version}.zip`;
  const addonRelease = await released(addonDir, tag);
  if (addonRelease.isDraft || !addonRelease.assets.some((a) => a.name === zip)) throw new Error(`${repo} ${tag} has no ${zip}`);

  console.log(`\n2. the bundle ${bundleTag}`);
  writeFileSync(bundlePath, `${JSON.stringify(next, null, 2)}\n`);
  run(root, "node", ["scripts/publish.mjs", "pin"]);
  const changed = run(root, "git", ["diff", "--numstat", "--", "bundle.json"], { quiet: true });
  if (!/^2\t2\t/.test(changed)) throw new Error(`bundle.json changed by more than one addon's tag and hash (${changed || "nothing"})`);
  run(root, "node", ["--test", "scripts/publish.test.mjs", "scripts/release-addon.test.mjs"], { quiet: true });
  run(root, "git", ["add", "bundle.json"]);
  run(root, "git", ["commit", "--quiet", "-m", says.bundle]);
  pushAndTag(root, bundleTag);
  await released(root, bundleTag);
  const index = await (await fetch(`https://github.com/${OWN}ryna/releases/download/${bundleTag}/addons.json`)).json();
  const listed = index.addons.find((a) => a.folder === folder);
  if (index.serial !== serialOf(bundleVersion) || listed?.version !== version) {
    throw new Error(`the published index doesn't name ${folder} ${version} (serial ${index.serial}, ${listed?.version})`);
  }
  console.log(`  the index (serial ${index.serial}) names ${folder} ${version}`);

  if (pinApp) {
    console.log("\n3. the app's pin");
    const sha256 = entryFor(JSON.parse(readFileSync(bundlePath, "utf8")), addon).sha256;
    const pinPath = join(agentDir, "mods", "wow", addon, "pin.json");
    const modPath = join(agentDir, "mods", "wow", addon, "mod.json");
    const pin = JSON.parse(readFileSync(pinPath, "utf8"));
    writeFileSync(pinPath, `${JSON.stringify({ ...pin, tag, sha256 }, null, 2)}\n`);
    const mod = readFileSync(modPath, "utf8");
    const modNow = mod.replace(/("version":\s*")[^"]+(")/, `$1${version}$2`);
    if (modNow === mod) throw new Error(`${modPath} has no version to move`);
    writeFileSync(modPath, modNow);
    run(agentDir, "node", ["scripts/fetch-addons.mjs"], { quiet: true });
    run(agentDir, "node", ["scripts/check-versions.mjs"]);
    run(agentDir, "scripts/pinned-tests.sh", [], { quiet: true });
    run(agentDir, "git", ["add", pinPath, modPath]);
    run(agentDir, "git", ["commit", "--quiet", "-m", says.app]);
    run(agentDir, "git", ["push", "--quiet", "origin", "main"]);
  }
  console.log(`\nDone: ${nameOf(folder)} ${version} is in the index the app reads.`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main(process.argv.slice(2)).catch((e) => {
    console.error(`\nStopped: ${e.message}`);
    process.exit(1);
  });
}
