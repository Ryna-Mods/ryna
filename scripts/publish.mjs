#!/usr/bin/env node
// The publisher: from bundle.json (which release of each addon the next bundle holds) it makes
//   - Ryna-<version>-forever.zip, every addon's folder side by side, for an addon manager, and
//   - addons.json, the index the Ryna app reads to update each addon on its own
//     (MaddisonM79/ryna_agent docs/ryna-agent-cores-mods.md 6.2).
// The release workflow signs addons.json and publishes both; this file never sees a key.
//
//   node scripts/publish.mjs pin                      fill in each addon's sha256 in bundle.json
//   node scripts/publish.mjs build --version X.Y.Z --out dist [--previous addons.json]
//   node scripts/publish.mjs verify <dir>             <dir>/addons.json against its .sig and addons.pub
//                                    [--pub <file>]   (another key: tests only)
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { publicKey, verifyFile } from "./sig.mjs";
import { readZip, writeZip } from "./zip.mjs";

export const SCHEMA = 1;
export const INDEX_FILE = "addons.json";
export const CORE = "Ryna_Core";
/** The app takes a zip only from under here, so only these addons get an index entry. */
export const OWN = "Ryna-Mods/";
/** Where an addon may come from: its own repository, or (until it has one) ryna_agent's release. */
const SOURCE = /^(Ryna-Mods\/[a-z][a-z0-9-]*|MaddisonM79\/ryna_agent)$/;
const FOLDER = /^Ryna_[A-Za-z]+$/;
const VERSION = /^\d+(\.\d+){0,3}$/;
const ASSET = /^[A-Za-z0-9_][A-Za-z0-9_.-]*\.zip$/;
const SHA = /^[0-9a-f]{64}$/;
/** One part of a path inside an addon: nothing hidden, nothing that climbs, nothing a shell reads. */
const PART = /^[A-Za-z0-9_][A-Za-z0-9_. -]*$/;
/** The app refuses a larger zip. */
export const MAX_ZIP_BYTES = 128 * 1024 * 1024;

const sha256 = (b) => createHash("sha256").update(b).digest("hex");

export function compareVersions(a, b) {
  const x = a.split(".").map(Number);
  const y = b.split(".").map(Number);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d) return Math.sign(d);
  }
  return 0;
}

/**
 * The index's serial for a bundle version: 0.5.1 is 5001. The app refuses an index whose serial is
 * below the last it took, so the number has to rise with the version; three parts, each under 1000.
 */
const FIRST_SERIAL = 5001;

export function serialOf(version) {
  const part = "(0|[1-9]\\d{0,2})";
  const m = new RegExp(`^${part}\\.${part}\\.${part}$`).exec(String(version));
  const serial = m ? Number(m[1]) * 1_000_000 + Number(m[2]) * 1_000 + Number(m[3]) : 0;
  if (!m) throw new Error(`a bundle's version is X.Y.Z, each part under 1000 (not ${version})`);
  // 0.5.0 was the last release every addon shared (ryna_agent's); the bundle's own line starts after it.
  if (serial < FIRST_SERIAL) throw new Error(`a bundle's version starts at 0.5.1 (not ${version}): 0.5.0 is already released`);
  return serial;
}

/** The bundle version a serial stands for. */
export function versionOf(serial) {
  return `${Math.floor(serial / 1_000_000)}.${Math.floor(serial / 1_000) % 1_000}.${serial % 1_000}`;
}

/** Check bundle.json's shape and return its addons, each with `version`, `asset` and `url` worked out. */
export function readBundle(json) {
  const addons = json?.addons;
  if (!Array.isArray(addons) || !addons.length) throw new Error("bundle.json lists no addons");
  const seen = new Set();
  const out = addons.map((a) => {
    const who = typeof a?.folder === "string" ? a.folder : "an addon";
    const fail = (why) => {
      throw new Error(`bundle.json, ${who}: ${why}`);
    };
    for (const k of Object.keys(a ?? {})) {
      if (!["folder", "repo", "tag", "asset", "sha256", "minApp"].includes(k)) fail(`${k} isn't a field`);
    }
    if (typeof a?.folder !== "string" || !FOLDER.test(a.folder)) fail("its folder isn't Ryna_<Name>");
    if (seen.has(a.folder)) fail("listed twice");
    seen.add(a.folder);
    if (typeof a.repo !== "string" || !SOURCE.test(a.repo)) fail("its repo isn't one addons come from");
    if (typeof a.tag !== "string" || !VERSION.test(a.tag.replace(/^v/, "")) || !a.tag.startsWith("v")) {
      fail("its tag isn't v<numbers and dots>");
    }
    const version = a.tag.slice(1);
    const asset = a.asset ?? `${a.folder}-${version}.zip`;
    if (typeof asset !== "string" || !ASSET.test(asset) || asset.includes("..")) fail("its asset isn't a plain .zip name");
    if (a.sha256 !== undefined && (typeof a.sha256 !== "string" || !SHA.test(a.sha256))) {
      fail("its sha256 isn't 64 lowercase hex characters");
    }
    if (a.minApp !== undefined && (typeof a.minApp !== "string" || !VERSION.test(a.minApp))) {
      fail("its minApp isn't numbers and dots");
    }
    return {
      folder: a.folder,
      repo: a.repo,
      tag: a.tag,
      version,
      asset,
      sha256: a.sha256,
      minApp: a.minApp,
      own: a.repo.startsWith(OWN),
      url: `https://github.com/${a.repo}/releases/download/${a.tag}/${asset}`,
    };
  });
  if (!seen.has(CORE)) throw new Error(`bundle.json lists no ${CORE}`);
  return out;
}

/** A `## Key: value` line of a TOC. */
export function tocField(toc, key) {
  for (const line of toc.split(/\r?\n/)) {
    const m = /^##\s*([^:]+?)\s*:\s*(.*?)\s*$/.exec(line);
    if (m && m[1] === key) return m[2];
  }
  return undefined;
}

function level(toc, key, who) {
  const v = tocField(toc, key);
  if (v === undefined) return undefined;
  if (!/^[1-9]\d{0,5}$/.test(v)) throw new Error(`${who}: its TOC's ${key} isn't a level`);
  return Number(v);
}

/**
 * One addon's folder out of a zip's entries: `[{ name, data }]` with names from the folder down,
 * folders first where the zip had them. `alone`: the zip must hold nothing else (an addon's own
 * release, which the app unpacks and holds to the same rule).
 */
export function takeFolder(entries, folder, { alone }) {
  const out = [];
  for (const e of entries) {
    const parts = e.name.replace(/\/$/, "").split("/");
    if (!e.name || e.name.startsWith("/") || parts.some((p) => !PART.test(p) || p.endsWith(".") || p.endsWith(" "))) {
      // Refused wherever it sits: a zip with such a name isn't one of ours.
      throw new Error(`it holds ${JSON.stringify(e.name)}, a name an addon can't have`);
    }
    if (parts[0] !== folder) {
      if (alone) throw new Error(`it holds ${e.name}, which isn't in ${folder}/`);
      continue;
    }
    if ((e.mode & 0o170000) === 0o120000) throw new Error(`it holds a link (${e.name})`);
    if (!e.dir && parts.length === 1) throw new Error(`${folder} is a file in it, not a folder`);
    out.push({ name: e.name, data: e.data });
  }
  if (!out.some((e) => e.name === `${folder}/${folder}.toc`)) throw new Error(`it has no ${folder}/${folder}.toc`);
  return out;
}

/**
 * Build release `version`. `fetch(url)` resolves to the asset's bytes; `previous` is the last published
 * index (already checked), when there is one. Returns `{ index, files, notes }`: `files` maps a
 * name to its bytes (the index and the bundle zip), `notes` is the release's text.
 */
export async function build({ bundle, version, fetch, generated, previous }) {
  const serial = serialOf(version);
  const addons = readBundle(bundle);

  const assets = new Map();
  const taken = [];
  for (const a of addons) {
    const fail = (why) => {
      throw new Error(`${a.folder} ${a.version}: ${why}`);
    };
    if (!a.sha256) fail("bundle.json pins no sha256 for it (node scripts/publish.mjs pin)");
    if (!assets.has(a.url)) {
      const bytes = Buffer.from(await fetch(a.url));
      assets.set(a.url, { bytes, sha256: sha256(bytes), entries: undefined });
    }
    const asset = assets.get(a.url);
    if (asset.sha256 !== a.sha256) fail(`${a.url} isn't the file bundle.json pins (it is ${asset.sha256})`);
    if (a.own && asset.bytes.length > MAX_ZIP_BYTES) fail("its zip is larger than the app takes");
    let files;
    try {
      asset.entries ??= readZip(asset.bytes);
      files = takeFolder(asset.entries, a.folder, { alone: a.own });
    } catch (e) {
      fail(`${a.asset}: ${e.message}`);
    }
    const toc = files.find((f) => f.name === `${a.folder}/${a.folder}.toc`).data.toString("utf8");
    if (tocField(toc, "Version") !== a.version) {
      fail(`its TOC says version ${tocField(toc, "Version")}, its tag says ${a.version}`);
    }
    const api = level(toc, "X-Ryna-API", a.folder);
    if (api === undefined) fail("its TOC has no X-Ryna-API");
    let apiMin;
    if (a.folder === CORE) {
      apiMin = level(toc, "X-Ryna-API-Min", a.folder);
      // The core released as 0.5.0 predates the line; the app only ever carries that one.
      if (apiMin === undefined && a.own) fail("its TOC has no X-Ryna-API-Min");
      apiMin ??= api;
      if (apiMin > api) fail("its lowest API level is above its level");
    }
    taken.push({ ...a, api, apiMin, files, size: asset.bytes.length });
  }

  // A bundle is installed whole, so everything in it has to work together.
  const core = taken.find((t) => t.folder === CORE);
  for (const t of taken) {
    if (t.folder !== CORE && (t.api < core.apiMin || t.api > core.api)) {
      throw new Error(
        `${t.folder} ${t.version} needs API level ${t.api}; ${CORE} ${core.version} serves ${core.apiMin} to ${core.api}`,
      );
    }
  }

  const entries = taken
    .filter((t) => t.own)
    .map((t) => ({
      folder: t.folder,
      version: t.version,
      api: t.api,
      ...(t.folder === CORE ? { apiMin: t.apiMin } : {}),
      ...(t.minApp ? { minApp: t.minApp } : {}),
      url: t.url,
      sha256: t.sha256,
      size: t.size,
    }));

  if (previous) {
    if (!(serial > previous.serial)) {
      throw new Error(`${version} isn't above the published bundle (${versionOf(previous.serial)})`);
    }
    for (const was of previous.addons ?? []) {
      const now = entries.find((e) => e.folder === was.folder);
      if (!now) throw new Error(`${was.folder} is in the published index and not in this one`);
      if (compareVersions(now.version, was.version) < 0) {
        throw new Error(`${was.folder} would go back from ${was.version} to ${now.version}`);
      }
    }
  }

  const index = { schema: SCHEMA, serial, generated, addons: entries };
  // Sorted, so the zip depends on the addons alone and not on how each release was packed.
  const zipped = taken
    .flatMap((t) => t.files)
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const notes = [
    "Every Ryna addon in one download, for an addon manager. Unzip it into `Interface/AddOns`.",
    "",
    "| Addon | Version | From |",
    "|---|---|---|",
    ...taken.map((t) => `| \`${t.folder}\` | ${t.version} | [${t.repo} ${t.tag}](https://github.com/${t.repo}/releases/tag/${t.tag}) |`),
    "",
    entries.length
      ? `The Ryna app updates ${entries.map((e) => `\`${e.folder}\``).join(", ")} from this release's \`addons.json\`.`
      : `\`addons.json\` lists nothing yet: the app carries these versions itself.`,
    "",
  ].join("\n");
  return {
    index,
    notes,
    files: {
      [INDEX_FILE]: Buffer.from(`${JSON.stringify(index, null, 2)}\n`),
      [`Ryna-${version}-forever.zip`]: writeZip(zipped),
    },
  };
}

async function download(url) {
  if (!url.startsWith("https://github.com/")) throw new Error(`${url} isn't on github.com`);
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok) throw new Error(`${url} answered ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

async function main(argv) {
  const root = dirname(dirname(fileURLToPath(import.meta.url)));
  const bundlePath = join(root, "bundle.json");
  const [command, ...rest] = argv;
  const flag = (name) => {
    const i = rest.indexOf(`--${name}`);
    return i < 0 ? undefined : rest[i + 1];
  };
  if (command === "pin") {
    const json = JSON.parse(readFileSync(bundlePath, "utf8"));
    const addons = readBundle(json);
    const hashes = new Map();
    for (const [i, a] of addons.entries()) {
      if (!hashes.has(a.url)) hashes.set(a.url, sha256(await download(a.url)));
      const now = hashes.get(a.url);
      if (a.sha256 !== now) console.log(`${a.folder}: ${a.sha256 ?? "unpinned"} -> ${now}`);
      json.addons[i].sha256 = now;
    }
    writeFileSync(bundlePath, `${JSON.stringify(json, null, 2)}\n`);
    console.log(`pinned ${addons.length} addons from ${hashes.size} file(s); read the diff before committing it`);
  } else if (command === "build") {
    const version = flag("version");
    const out = flag("out");
    if (!out) throw new Error("build needs --out <dir>");
    const before = flag("previous");
    const epoch = process.env.SOURCE_DATE_EPOCH;
    const built = await build({
      bundle: JSON.parse(readFileSync(bundlePath, "utf8")),
      version,
      fetch: download,
      generated: new Date(epoch ? Number(epoch) * 1000 : Date.now()).toISOString().replace(/\.\d+Z$/, "Z"),
      previous: before ? JSON.parse(readFileSync(before, "utf8")) : undefined,
    });
    mkdirSync(out, { recursive: true });
    for (const [name, bytes] of Object.entries(built.files)) {
      writeFileSync(join(out, name), bytes);
      console.log(`${name}  ${bytes.length} bytes  ${sha256(bytes)}`);
    }
    const notes = flag("notes");
    if (notes) writeFileSync(notes, built.notes);
    console.log(`bundle ${version}, index ${built.index.serial}: ${built.index.addons.map((e) => `${e.folder} ${e.version}`).join(", ") || "no entries"}`);
  } else if (command === "next") {
    // The version a dry run builds: one patch above the published bundle, or the first.
    const before = flag("previous");
    console.log(before ? versionOf(JSON.parse(readFileSync(before, "utf8")).serial + 1) : versionOf(FIRST_SERIAL));
  } else if (command === "verify") {
    const dir = rest[0];
    if (!dir) throw new Error("verify needs a folder");
    const data = readFileSync(join(dir, INDEX_FILE));
    const pub = readFileSync(flag("pub") ?? join(root, "addons.pub"), "utf8");
    const comment = verifyFile(data, readFileSync(join(dir, `${INDEX_FILE}.sig`), "utf8"), pub, INDEX_FILE);
    const index = JSON.parse(data);
    if (index.schema !== SCHEMA) throw new Error(`it is schema ${index.schema}`);
    console.log(`${INDEX_FILE}: signed by key ${publicKey(pub).id} (${comment.replace("\t", ", ")}); bundle ${versionOf(index.serial)}, index ${index.serial}`);
  } else {
    throw new Error("usage: publish.mjs pin | next [--previous <file>] | build --version X.Y.Z --out <dir> [--previous <file>] [--notes <file>] | verify <dir>");
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((e) => {
    console.error(`publish: ${e.message}`);
    process.exit(1);
  });
}
