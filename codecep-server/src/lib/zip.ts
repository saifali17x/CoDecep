// ── Minimal ZIP writer (STORE method) ───────────────────────────────────────
// Judge0's "Multi-file program" language (id 89) takes the whole project as a
// base64 zip in `additional_files`. That is the only thing we need a zip for,
// so rather than add a dependency (the server already installs with
// --legacy-peer-deps because of a tree-sitter peer conflict — every extra
// package is another chance to break that) we emit the archive by hand.
//
// Everything is stored UNCOMPRESSED (method 0). Exam workspaces are a handful
// of small text files, so deflate would buy nothing and cost a dependency.
// Judge0 extracts with `unzip`, which reads stored entries fine.

const CRC_TABLE = (() => {
  const table = new Int32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c
  }
  return table
})()

function crc32(buf: Buffer): number {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

export interface ZipEntry {
  name: string
  content: string
}

/**
 * Build a ZIP archive containing `entries`, all stored uncompressed.
 * Every entry is marked 0755 so Judge0's `compile`/`run` scripts are runnable
 * whichever way the sandbox chooses to invoke them.
 */
export function buildZip(entries: ZipEntry[]): Buffer {
  const locals: Buffer[] = []
  const centrals: Buffer[] = []
  let offset = 0

  for (const entry of entries) {
    const nameBuf = Buffer.from(entry.name, 'utf8')
    const dataBuf = Buffer.from(entry.content, 'utf8')
    const crc = crc32(dataBuf)

    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0) // local file header signature
    local.writeUInt16LE(20, 4)         // version needed to extract (2.0)
    local.writeUInt16LE(0, 6)          // general purpose flags
    local.writeUInt16LE(0, 8)          // compression method: 0 = store
    local.writeUInt16LE(0, 10)         // last mod time — fixed, keeps output deterministic
    local.writeUInt16LE(0x0021, 12)    // last mod date — 1980-01-01
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(dataBuf.length, 18) // compressed size == uncompressed
    local.writeUInt32LE(dataBuf.length, 22)
    local.writeUInt16LE(nameBuf.length, 26)
    local.writeUInt16LE(0, 28)         // extra field length
    locals.push(local, nameBuf, dataBuf)

    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0) // central directory header signature
    central.writeUInt16LE(0x031e, 4)     // version made by: UNIX, 3.0
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(0, 8)
    central.writeUInt16LE(0, 10)
    central.writeUInt16LE(0, 12)
    central.writeUInt16LE(0x0021, 14)
    central.writeUInt32LE(crc, 16)
    central.writeUInt32LE(dataBuf.length, 20)
    central.writeUInt32LE(dataBuf.length, 24)
    central.writeUInt16LE(nameBuf.length, 28)
    central.writeUInt16LE(0, 30)         // extra field length
    central.writeUInt16LE(0, 32)         // file comment length
    central.writeUInt16LE(0, 34)         // disk number start
    central.writeUInt16LE(0, 36)         // internal file attributes
    central.writeUInt32LE((0o100755 << 16) >>> 0, 38) // external attrs: regular file, 0755
    central.writeUInt32LE(offset, 42)    // relative offset of local header
    centrals.push(central, nameBuf)

    offset += local.length + nameBuf.length + dataBuf.length
  }

  const centralBuf = Buffer.concat(centrals)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0) // end of central directory signature
  eocd.writeUInt16LE(0, 4)          // this disk number
  eocd.writeUInt16LE(0, 6)          // disk with central directory
  eocd.writeUInt16LE(entries.length, 8)
  eocd.writeUInt16LE(entries.length, 10)
  eocd.writeUInt32LE(centralBuf.length, 12)
  eocd.writeUInt32LE(offset, 16)
  eocd.writeUInt16LE(0, 20)         // comment length

  return Buffer.concat([Buffer.concat(locals), centralBuf, eocd])
}
