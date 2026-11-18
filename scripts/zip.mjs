// A small zip reader and writer, enough for addon folders: stored and deflated files, no zip64, no
// encryption. The reader checks every CRC; the writer's output depends only on its input (one fixed
// date, no extra fields), so the same addons always make the same bundle.
import { crc32, deflateRawSync, inflateRawSync } from "node:zlib";

const EOCD = 0x06054b50;
const CENTRAL = 0x02014b50;
const LOCAL = 0x04034b50;
// 2026-01-01 00:00, as DOS date and time.
const DOS_DATE = ((2026 - 1980) << 9) | (1 << 5) | 1;
const DOS_TIME = 0;

export const MAX_FILES = 20_000;
export const MAX_UNPACKED = 512 * 1024 * 1024;

/** Read a zip: `[{ name, dir, mode, data }]`, in the archive's order. `mode` is the Unix mode, or 0. */
export function readZip(buf) {
  let at = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 0xffff); i--) {
    if (buf.readUInt32LE(i) === EOCD) {
      at = i;
      break;
    }
  }
  if (at < 0) throw new Error("it isn't a zip");
  const count = buf.readUInt16LE(at + 10);
  const size = buf.readUInt32LE(at + 12);
  let off = buf.readUInt32LE(at + 16);
  if (buf.readUInt16LE(at + 4) !== 0 || buf.readUInt16LE(at + 8) !== count) {
    throw new Error("it is a zip in several parts");
  }
  if (count === 0xffff || off === 0xffffffff || size === 0xffffffff) throw new Error("it is a zip64");
  if (count > MAX_FILES) throw new Error("it holds too many files");
  if (off + size > at) throw new Error("its directory runs past its end");

  const out = [];
  const seen = new Set();
  let total = 0;
  for (let n = 0; n < count; n++) {
    if (off + 46 > at || buf.readUInt32LE(off) !== CENTRAL) throw new Error("its directory is damaged");
    const madeBy = buf.readUInt16LE(off + 4);
    const flags = buf.readUInt16LE(off + 8);
    const method = buf.readUInt16LE(off + 10);
    const crc = buf.readUInt32LE(off + 16);
    const packed = buf.readUInt32LE(off + 20);
    const unpacked = buf.readUInt32LE(off + 24);
    const nameLen = buf.readUInt16LE(off + 28);
    const extraLen = buf.readUInt16LE(off + 30);
    const commentLen = buf.readUInt16LE(off + 32);
    const attrs = buf.readUInt32LE(off + 38);
    const local = buf.readUInt32LE(off + 42);
    const raw = buf.subarray(off + 46, off + 46 + nameLen);
    const name = raw.toString("utf8");
    off += 46 + nameLen + extraLen + commentLen;

    if (!Buffer.from(name, "utf8").equals(raw)) throw new Error("it holds a name that isn't UTF-8");
    if (flags & 1) throw new Error(`${name} is encrypted`);
    if (packed === 0xffffffff || unpacked === 0xffffffff || local === 0xffffffff) {
      throw new Error("it is a zip64");
    }
    if (seen.has(name)) throw new Error(`it holds ${name} twice`);
    seen.add(name);
    total += unpacked;
    if (total > MAX_UNPACKED) throw new Error("it unpacks to too much");

    if (local + 30 > buf.length || buf.readUInt32LE(local) !== LOCAL) {
      throw new Error(`${name}: its header is damaged`);
    }
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    if (start + packed > buf.length) throw new Error(`${name}: it runs past the end`);
    const body = buf.subarray(start, start + packed);
    let data;
    if (method === 0) data = Buffer.from(body);
    else if (method === 8) data = inflateRawSync(body, { maxOutputLength: unpacked + 1 });
    else throw new Error(`${name}: compression method ${method} isn't read here`);
    if (data.length !== unpacked || crc32(data) !== crc) throw new Error(`${name}: it is damaged`);

    const dir = name.endsWith("/");
    if (dir && data.length) throw new Error(`${name}: a folder with contents of its own`);
    out.push({ name, dir, mode: madeBy >> 8 === 3 ? attrs >>> 16 : 0, data });
  }
  return out;
}

/** Write a zip from `[{ name, data }]`; a name ending in `/` is a folder. The order is kept. */
export function writeZip(entries) {
  const parts = [];
  const central = [];
  let off = 0;
  for (const e of entries) {
    const dir = e.name.endsWith("/");
    const name = Buffer.from(e.name, "utf8");
    const data = dir ? Buffer.alloc(0) : e.data;
    const deflated = dir ? data : deflateRawSync(data, { level: 9 });
    const stored = deflated.length >= data.length;
    const body = stored ? data : deflated;
    const crc = crc32(data);
    if (data.length >= 0xffffffff || off >= 0xffffffff) throw new Error("too large for a plain zip");

    const head = Buffer.alloc(30);
    head.writeUInt32LE(LOCAL, 0);
    head.writeUInt16LE(20, 4);
    head.writeUInt16LE(0x0800, 6); // names are UTF-8
    head.writeUInt16LE(stored ? 0 : 8, 8);
    head.writeUInt16LE(DOS_TIME, 10);
    head.writeUInt16LE(DOS_DATE, 12);
    head.writeUInt32LE(crc, 14);
    head.writeUInt32LE(body.length, 18);
    head.writeUInt32LE(data.length, 22);
    head.writeUInt16LE(name.length, 26);
    parts.push(head, name, body);

    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(CENTRAL, 0);
    cd.writeUInt16LE((3 << 8) | 20, 4); // made on Unix, so the mode below is read
    cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(0x0800, 8);
    cd.writeUInt16LE(stored ? 0 : 8, 10);
    cd.writeUInt16LE(DOS_TIME, 12);
    cd.writeUInt16LE(DOS_DATE, 14);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(body.length, 20);
    cd.writeUInt32LE(data.length, 24);
    cd.writeUInt16LE(name.length, 28);
    cd.writeUInt32LE((((dir ? 0o040755 : 0o100644) << 16) | (dir ? 0x10 : 0)) >>> 0, 38);
    cd.writeUInt32LE(off, 42);
    central.push(cd, name);
    off += 30 + name.length + body.length;
  }
  const cdBytes = Buffer.concat(central);
  if (entries.length >= 0xffff) throw new Error("too many files for a plain zip");
  const end = Buffer.alloc(22);
  end.writeUInt32LE(EOCD, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cdBytes.length, 12);
  end.writeUInt32LE(off, 16);
  return Buffer.concat([...parts, cdBytes, end]);
}
