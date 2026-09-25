/**
 * A minimal ZIP writer.
 *
 * Explicit exports need a real archive — a project with a brief, its
 * generations, and its reference images is not a single text file. Node ships
 * gzip but not zip, and adding a dependency for one file format is a poor
 * trade, so the format is written out here.
 *
 * Deliberately limited, and honest about it:
 *   • STORE only (no deflate). Reference material is mostly images and text
 *     that is already small; an export is downloaded, not archived for years.
 *   • No ZIP64. Exports are capped well below 4 GB by the file-size limit.
 *   • UTF-8 names via the language-encoding flag (bit 11).
 *
 * The structure is the one every unzip tool expects: local header + data per
 * entry, then a central directory, then the end-of-central-directory record.
 */

/** CRC-32 (IEEE 802.3), the checksum ZIP entries carry. */
const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[index] = value;
  }
  return table;
})();

export function crc32(buffer) {
  let crc = -1;
  for (let index = 0; index < buffer.length; index += 1) {
    crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ buffer[index]) & 0xff];
  }
  return (crc ^ -1) >>> 0;
}

/** DOS date and time, which is what the format has room for. */
function dosDateTime(date = new Date()) {
  const time = ((date.getHours() & 0x1f) << 11) | ((date.getMinutes() & 0x3f) << 5) | (Math.floor(date.getSeconds() / 2) & 0x1f);
  const day = (((date.getFullYear() - 1980) & 0x7f) << 9) | (((date.getMonth() + 1) & 0x0f) << 5) | (date.getDate() & 0x1f);
  return { time, date: day };
}

/**
 * Entry names are built from user and model data, so each segment is cleaned
 * rather than the whole path being flattened: folders the caller intended
 * (`generations/`, `files/`) survive, while absolute paths, `..`, control
 * characters, and separators that are not `/` cannot. Two entries with the same
 * name get numeric suffixes instead of silently overwriting each other.
 */
export function archiveName(input, taken = new Set()) {
  const segments = String(input ?? '')
    .replace(/\\/g, '/')
    .split('/')
    .map((part) => part.replace(/[\u0000-\u001f<>:"|?*]/g, '').trim())
    .filter((part) => part && part !== '.' && part !== '..')
    .map((part) => part.slice(0, 80));
  // A leading slash would make an absolute path; dropping empty segments does.
  const base = segments.join('/').slice(0, 180) || 'file';
  if (!taken.has(base)) {
    taken.add(base);
    return base;
  }
  const slash = base.lastIndexOf('/');
  const directory = slash >= 0 ? `${base.slice(0, slash + 1)}` : '';
  const leaf = slash >= 0 ? base.slice(slash + 1) : base;
  const dot = leaf.lastIndexOf('.');
  const stem = dot > 0 ? leaf.slice(0, dot) : leaf;
  const extension = dot > 0 ? leaf.slice(dot) : '';
  let counter = 2;
  let candidate = `${directory}${stem}-${counter}${extension}`;
  while (taken.has(candidate)) {
    counter += 1;
    candidate = `${directory}${stem}-${counter}${extension}`;
  }
  taken.add(candidate);
  return candidate;
}

/**
 * @param {Array<{name: string, data: Buffer|string}>} entries
 * @param {{ date?: Date }} [options]
 * @returns {Buffer}
 */
export function createZip(entries, { date = new Date() } = {}) {
  const { time, date: dosDate } = dosDateTime(date);
  const taken = new Set();
  const locals = [];
  const central = [];
  let offset = 0;

  for (const entry of entries) {
    const name = archiveName(entry.name, taken);
    const body = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(String(entry.data ?? ''), 'utf8');
    const nameBytes = Buffer.from(name, 'utf8');
    const checksum = crc32(body);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);           // version needed
    local.writeUInt16LE(0x0800, 6);       // UTF-8 names
    local.writeUInt16LE(0, 8);            // STORE
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(dosDate, 12);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(body.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    local.writeUInt16LE(0, 28);           // no extra field
    locals.push(local, nameBytes, body);

    const header = Buffer.alloc(46);
    header.writeUInt32LE(0x02014b50, 0);
    header.writeUInt16LE(20, 4);          // version made by
    header.writeUInt16LE(20, 6);          // version needed
    header.writeUInt16LE(0x0800, 8);
    header.writeUInt16LE(0, 10);          // STORE
    header.writeUInt16LE(time, 12);
    header.writeUInt16LE(dosDate, 14);
    header.writeUInt32LE(checksum, 16);
    header.writeUInt32LE(body.length, 20);
    header.writeUInt32LE(body.length, 24);
    header.writeUInt16LE(nameBytes.length, 28);
    header.writeUInt16LE(0, 30);          // extra
    header.writeUInt16LE(0, 32);          // comment
    header.writeUInt16LE(0, 34);          // disk number
    header.writeUInt16LE(0, 36);          // internal attributes
    header.writeUInt32LE(0, 38);          // external attributes
    header.writeUInt32LE(offset, 42);     // offset of the local header
    central.push(header, nameBytes);

    offset += local.length + nameBytes.length + body.length;
  }

  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);                // this disk
  end.writeUInt16LE(0, 6);                // disk with the directory
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);               // no comment

  return Buffer.concat([...locals, directory, end]);
}
