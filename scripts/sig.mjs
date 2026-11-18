// Check a signature the way the Ryna app does: minisign, with the key and the `.sig` each the
// base64 of minisign's own text (what `tauri signer` writes), and a trusted comment that names the
// file. Nothing here signs anything real: the release workflow signs with the Tauri CLI, and this
// proves the result against addons.pub before it is published.
import { createHash, createPublicKey, verify as edVerify } from "node:crypto";

const SPKI = Buffer.from("302a300506032b6570032100", "hex");

function text(b64, what) {
  const s = Buffer.from(String(b64).trim(), "base64").toString("utf8");
  if (!s.includes("comment:")) throw new Error(`the ${what} isn't the base64 of minisign's text`);
  return s.split(/\r?\n/);
}

/** The key id (hex, as minisign prints it) and the Ed25519 key of a public key file's contents. */
export function publicKey(pub) {
  const bin = Buffer.from(text(pub, "public key")[1] ?? "", "base64");
  if (bin.length !== 42 || bin.toString("latin1", 0, 2) !== "Ed") {
    throw new Error("the public key isn't a minisign key");
  }
  return {
    id: Buffer.from(bin.subarray(2, 10)).reverse().toString("hex").toUpperCase(),
    rawId: bin.subarray(2, 10),
    key: createPublicKey({ key: Buffer.concat([SPKI, bin.subarray(10)]), format: "der", type: "spki" }),
  };
}

/**
 * Throws unless `sig` is `pub`'s signature of `data` and its trusted comment names `file`.
 * Returns the trusted comment.
 */
export function verifyFile(data, sig, pub, file) {
  const { key, rawId } = publicKey(pub);
  const lines = text(sig, "signature");
  const bin = Buffer.from(lines[1] ?? "", "base64");
  const trusted = (lines[2] ?? "").replace(/^trusted comment: /, "");
  const global = Buffer.from(lines[3] ?? "", "base64");
  if (bin.length !== 74 || global.length !== 64 || !(lines[2] ?? "").startsWith("trusted comment: ")) {
    throw new Error("the signature isn't a minisign signature");
  }
  const alg = bin.toString("latin1", 0, 2);
  if (alg !== "ED" && alg !== "Ed") throw new Error("the signature isn't a minisign signature");
  if (!bin.subarray(2, 10).equals(rawId)) throw new Error("the signature was made with another key");
  const signature = bin.subarray(10);
  const message = alg === "ED" ? createHash("blake2b512").update(data).digest() : data;
  if (!edVerify(null, message, key, signature)) throw new Error("the signature doesn't match the file");
  if (!edVerify(null, Buffer.concat([signature, Buffer.from(trusted, "utf8")]), key, global)) {
    throw new Error("the signature's trusted comment was changed");
  }
  if (!trusted.split("\t").includes(`file:${file}`)) {
    throw new Error(`the signature is for another file (its comment: ${trusted})`);
  }
  return trusted;
}
