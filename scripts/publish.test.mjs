import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign as edSign } from "node:crypto";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { build, compareVersions, readBundle, serialOf, takeFolder, tocField, versionOf } from "./publish.mjs";
import { publicKey, verifyFile } from "./sig.mjs";
import { readZip, writeZip } from "./zip.mjs";

const sha256 = (b) => createHash("sha256").update(b).digest("hex");
const b64 = (v) => Buffer.from(v).toString("base64");

/** A minisign key pair as `tauri signer` writes one, for these tests only. */
function testKey() {
  const { publicKey: pub, privateKey } = generateKeyPairSync("ed25519");
  const raw = pub.export({ format: "der", type: "spki" }).subarray(12);
  const id = Buffer.from("0102030405060708", "hex");
  return {
    pub: b64(`untrusted comment: minisign public key\n${b64(Buffer.concat([Buffer.from("Ed"), id, raw]))}\n`),
    sign(data, trusted, { prehash = true } = {}) {
      const message = prehash ? createHash("blake2b512").update(data).digest() : data;
      const sig = edSign(null, message, privateKey);
      const global = edSign(null, Buffer.concat([sig, Buffer.from(trusted)]), privateKey);
      const line = b64(Buffer.concat([Buffer.from(prehash ? "ED" : "Ed"), id, sig]));
      return b64(`untrusted comment: signature\n${line}\ntrusted comment: ${trusted}\n${b64(global)}\n`);
    },
  };
}

/** An addon's folder as zip entries. */
function addon(folder, version, api, { apiMin, extra = [] } = {}) {
  const toc = [
    "## Interface: 16001",
    `## Title: ${folder}`,
    `## Version: ${version}`,
    `## X-Ryna-API: ${api}`,
    ...(apiMin ? [`## X-Ryna-API-Min: ${apiMin}`] : []),
    "Main.lua",
    "",
  ].join("\r\n");
  return [
    { name: `${folder}/` },
    { name: `${folder}/${folder}.toc`, data: Buffer.from(toc) },
    { name: `${folder}/Main.lua`, data: Buffer.from(`-- ${folder} ${version}\n`.repeat(40)) },
    ...extra,
  ];
}

/** A world of release assets: `put` one, get back its bundle.json line; `fetch` serves them. */
function world() {
  const assets = new Map();
  return {
    fetch: async (url) => {
      if (!assets.has(url)) throw new Error(`${url} answered 404`);
      return assets.get(url);
    },
    put(folder, repo, tag, entries, asset) {
      const bytes = writeZip(entries);
      const name = asset ?? `${folder}-${tag.slice(1)}.zip`;
      assets.set(`https://github.com/${repo}/releases/download/${tag}/${name}`, bytes);
      return { folder, repo, tag, ...(asset ? { asset } : {}), sha256: sha256(bytes) };
    },
  };
}

const generated = "2026-11-17T00:00:00Z";

/** The six addons as ryna_agent released them: one zip, the core without its lowest level. */
function combined(w, version = "0.5.0") {
  const folders = ["Ryna_Core", "Ryna_Meter", "Ryna_Prices"];
  const entries = folders.flatMap((f) => addon(f, version, 2));
  return folders.map((f) => w.put(f, "MaddisonM79/ryna_agent", `v${version}`, entries, `Ryna-${version}.zip`));
}

test("a zip written here reads back, and a damaged one is refused", () => {
  const entries = addon("Ryna_Meter", "1.0.0", 2);
  const zip = writeZip(entries);
  assert.deepEqual(writeZip(entries), zip, "the same input makes the same bytes");
  const back = readZip(zip);
  assert.deepEqual(back.map((e) => e.name), entries.map((e) => e.name));
  assert.equal(back[0].dir, true);
  assert.equal(back[1].mode & 0o170000, 0o100000);
  assert.deepEqual(back[2].data, entries[2].data);

  const damaged = Buffer.from(zip);
  damaged[zip.indexOf("Main.lua") + 12] ^= 0xff;
  assert.throws(() => readZip(damaged));
  assert.throws(() => readZip(Buffer.from("<html>not a zip</html>")), /isn't a zip/);
});

test("a signature is held to the key, the file's bytes, its comment and its name", () => {
  const key = testKey();
  const data = Buffer.from('{"schema":1}');
  const trusted = "timestamp:1763337600\tfile:addons.json";
  assert.equal(verifyFile(data, key.sign(data, trusted), key.pub, "addons.json"), trusted);
  assert.equal(verifyFile(data, key.sign(data, trusted, { prehash: false }), key.pub, "addons.json"), trusted);

  assert.throws(() => verifyFile(Buffer.from("{}"), key.sign(data, trusted), key.pub, "addons.json"), /doesn't match/);
  assert.throws(() => verifyFile(data, key.sign(data, trusted), key.pub, "latest.json"), /another file/);
  assert.throws(() => verifyFile(data, key.sign(data, "file:addons.json.bak"), key.pub, "addons.json"), /another file/);
  const forged = Buffer.from(key.sign(data, trusted), "base64").toString().replace("file:addons.json", "file:latest.json");
  assert.throws(() => verifyFile(data, b64(forged), key.pub, "latest.json"), /comment was changed/);
  // Another key with the same id: the signature itself decides.
  assert.throws(() => verifyFile(data, testKey().sign(data, trusted), key.pub, "addons.json"), /doesn't match/);
  assert.throws(() => verifyFile(data, "not a signature", key.pub, "addons.json"));
});

test("addons.pub is the addons key", () => {
  const pub = readFileSync(new URL("../addons.pub", import.meta.url), "utf8");
  assert.equal(publicKey(pub).id, "9D0866D62DC37FE3");
});

test("bundle.json is well formed and every addon is pinned", () => {
  const json = JSON.parse(readFileSync(new URL("../bundle.json", import.meta.url), "utf8"));
  for (const a of readBundle(json)) assert.match(a.sha256 ?? "", /^[0-9a-f]{64}$/, a.folder);
});

test("bundle.json is refused for anything it shouldn't say", () => {
  const ok = { folder: "Ryna_Core", repo: "Ryna-Mods/core", tag: "v1.0.0" };
  assert.equal(readBundle({ addons: [ok] })[0].url, "https://github.com/Ryna-Mods/core/releases/download/v1.0.0/Ryna_Core-1.0.0.zip");
  const refused = (change, why) => assert.throws(() => readBundle({ addons: [{ ...ok, ...change }] }), why);
  refused({ repo: "someone/else" }, /repo/);
  refused({ repo: "Ryna-Mods/../x" }, /repo/);
  refused({ tag: "1.0.0" }, /tag/);
  refused({ tag: "v1.0.0-rc1" }, /tag/);
  refused({ asset: "../x.zip" }, /asset/);
  refused({ asset: "x.tar.gz" }, /asset/);
  refused({ sha256: "ABC" }, /sha256/);
  refused({ minApp: "new" }, /minApp/);
  refused({ url: "https://example.com/x.zip" }, /isn't a field/);
  refused({ folder: "Other" }, /folder/);
  assert.throws(() => readBundle({ addons: [ok, ok] }), /twice/);
  assert.throws(() => readBundle({ addons: [{ ...ok, folder: "Ryna_Meter" }] }), /no Ryna_Core/);
  assert.throws(() => readBundle({ addons: [] }), /no addons/);
});

test("a bundle's version gives the index its serial, and back", () => {
  assert.equal(serialOf("0.5.1"), 5001);
  assert.throws(() => serialOf("0.5.0"), /already released/);
  assert.throws(() => serialOf("0.4.9"), /starts at 0.5.1/);
  assert.equal(serialOf("0.5.12"), 5012);
  assert.equal(serialOf("1.0.0"), 1000000);
  assert.ok(serialOf("0.6.0") > serialOf("0.5.999"));
  assert.equal(versionOf(5012), "0.5.12");
  assert.equal(versionOf(serialOf("12.34.56")), "12.34.56");
});

test("versions compare by number, and a TOC field is read whatever its line ending", () => {
  assert.equal(compareVersions("1.10.0", "1.9.9"), 1);
  assert.equal(compareVersions("1.0", "1.0.0"), 0);
  assert.equal(compareVersions("0.5.0", "0.5.1"), -1);
  assert.equal(tocField("## Version: 1.2.3\r\n## X-Ryna-API: 2\r\n", "Version"), "1.2.3");
  assert.equal(tocField("## Title: x\n", "Version"), undefined);
});

test("addons that still come from ryna_agent's zip fill the bundle and get no index entry", async () => {
  const w = world();
  const built = await build({ bundle: { addons: combined(w) }, version: "0.5.1", fetch: w.fetch, generated });
  assert.deepEqual(built.index, { schema: 1, serial: 5001, generated, addons: [] });
  assert.deepEqual(JSON.parse(built.files["addons.json"]), built.index);
  const names = readZip(built.files["Ryna-0.5.1-forever.zip"]).map((e) => e.name);
  assert.deepEqual(names, [...names].sort(), "sorted");
  for (const f of ["Ryna_Core", "Ryna_Meter", "Ryna_Prices"]) assert.ok(names.includes(`${f}/${f}.toc`), f);
  assert.match(built.notes, /lists nothing yet/);
});

test("an addon with a release of its own gets an entry that names that release's zip", async () => {
  const w = world();
  const [core, , prices] = combined(w);
  const meter = { ...w.put("Ryna_Meter", "Ryna-Mods/meter", "v1.0.1", addon("Ryna_Meter", "1.0.1", 2)), minApp: "0.5.1" };
  const built = await build({ bundle: { addons: [core, meter, prices] }, version: "0.5.1", fetch: w.fetch, generated });
  const zip = await w.fetch("https://github.com/Ryna-Mods/meter/releases/download/v1.0.1/Ryna_Meter-1.0.1.zip");
  assert.deepEqual(built.index.addons, [
    {
      folder: "Ryna_Meter",
      version: "1.0.1",
      api: 2,
      minApp: "0.5.1",
      url: "https://github.com/Ryna-Mods/meter/releases/download/v1.0.1/Ryna_Meter-1.0.1.zip",
      sha256: sha256(zip),
      size: zip.length,
    },
  ]);
  const toc = readZip(built.files["Ryna-0.5.1-forever.zip"]).find((e) => e.name === "Ryna_Meter/Ryna_Meter.toc");
  assert.equal(tocField(toc.data.toString(), "Version"), "1.0.1", "the bundle holds the new Meter");
});

test("the core's own release carries its lowest level into its entry", async () => {
  const w = world();
  const [, meter] = combined(w);
  const core = w.put("Ryna_Core", "Ryna-Mods/core", "v1.0.0", addon("Ryna_Core", "1.0.0", 3, { apiMin: 2 }));
  const built = await build({ bundle: { addons: [core, meter] }, version: "0.5.2", fetch: w.fetch, generated });
  assert.equal(built.index.addons[0].apiMin, 2);
  assert.equal(built.index.addons[0].api, 3);

  const bare = w.put("Ryna_Core", "Ryna-Mods/core", "v1.0.1", addon("Ryna_Core", "1.0.1", 3));
  await assert.rejects(build({ bundle: { addons: [bare, meter] }, version: "0.5.2", fetch: w.fetch, generated }), /no X-Ryna-API-Min/);
});

test("a release that couldn't work, or isn't what was pinned, is refused", async () => {
  const w = world();
  const [core, meter] = combined(w);
  const run = (addons, more = {}) => build({ bundle: { addons }, version: "0.5.5", fetch: w.fetch, generated, ...more });

  await assert.rejects(run([core, { ...meter, sha256: "0".repeat(64) }]), /isn't the file bundle.json pins/);
  await assert.rejects(run([core, { ...meter, sha256: undefined }]), /pins no sha256/);
  await assert.rejects(run([core, { ...meter, tag: "v9.9.9", asset: "Ryna-9.zip" }]), /404/);

  const put = (tag, entries) => w.put("Ryna_Meter", "Ryna-Mods/meter", tag, entries);
  await assert.rejects(run([core, put("v1.0.2", addon("Ryna_Meter", "1.0.1", 2))]), /TOC says version 1.0.1/);
  await assert.rejects(run([core, put("v2.0.0", addon("Ryna_Meter", "2.0.0", 3))]), /needs API level 3/);
  await assert.rejects(
    run([core, put("v1.0.3", [...addon("Ryna_Meter", "1.0.3", 2), ...addon("Ryna_Extra", "1.0.3", 2)])]),
    /isn't in Ryna_Meter/,
  );
  await assert.rejects(
    run([core, put("v1.0.4", addon("Ryna_Meter", "1.0.4", 2, { extra: [{ name: "Ryna_Meter/../x.lua", data: Buffer.from("x") }] }))]),
    /a name an addon can't have/,
  );
  await assert.rejects(
    run([core, put("v1.0.5", addon("Ryna_Meter", "1.0.5", 2, { extra: [{ name: "Ryna_Meter/.hidden", data: Buffer.from("x") }] }))]),
    /a name an addon can't have/,
  );
  await assert.rejects(run([core, put("v1.0.6", [{ name: "Ryna_Meter/Main.lua", data: Buffer.from("x") }])]), /no Ryna_Meter\/Ryna_Meter.toc/);
  for (const version of ["1", "v0.5.1", "0.5.1000", "0.5"]) await assert.rejects(run([core, meter], { version }), /X\.Y\.Z/);
});

test("a link in a zip is refused", () => {
  const entries = [...addon("Ryna_Meter", "1.0.0", 2), { name: "Ryna_Meter/link", dir: false, mode: 0o120777, data: Buffer.from("/etc") }];
  assert.throws(() => takeFolder(entries.map((e) => ({ mode: 0o100644, dir: e.name.endsWith("/"), ...e })), "Ryna_Meter", { alone: true }), /a link/);
});

test("an index never goes back on the one published before it", async () => {
  const w = world();
  const [core, old] = combined(w);
  const meter = w.put("Ryna_Meter", "Ryna-Mods/meter", "v1.0.1", addon("Ryna_Meter", "1.0.1", 2));
  const previous = { schema: 1, serial: 5004, addons: [{ folder: "Ryna_Meter", version: "1.0.1" }] };
  const run = (addons, version) => build({ bundle: { addons }, version, fetch: w.fetch, generated, previous });

  assert.equal((await run([core, meter], "0.5.5")).index.serial, 5005);
  assert.equal((await run([core, meter], "0.6.0")).index.serial, 6000);
  await assert.rejects(run([core, meter], "0.5.4"), /isn't above the published bundle \(0\.5\.4\)/);
  await assert.rejects(run([core, old], "0.5.5"), /in the published index and not in this one/);
  const older = w.put("Ryna_Meter", "Ryna-Mods/meter", "v1.0.0", addon("Ryna_Meter", "1.0.0", 2));
  await assert.rejects(run([core, older], "0.5.5"), /go back from 1.0.1 to 1.0.0/);
});
