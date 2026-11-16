const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { pipeline } = require('stream/promises');

/*************************************************
 * Zip files, written with what Node ships: zlib's
 * CRC-32 and deflate, and Buffer for the records
 * (PKWARE's APPNOTE.TXT, 6.3.10).
 *
 * Here rather than in archiver, which took 45
 * packages to do the same.
 *
 * The archive is a file, which can be written out
 * of order. Each entry's header goes down with its
 * checksum and sizes blank, and is written again
 * once its data is in. So every entry carries its
 * sizes ahead of its data, which every reader can
 * use, including the ones that read front to back
 * and cannot find where a stored entry ends when
 * its sizes only come after it.
 *
 * ZIP64 holds what 32 bits cannot: a size or an
 * offset of 4 GiB or more, which an archive of a
 * subscription's videos soon passes, and more than
 * 65,534 entries.
 ************************************************/

const SIGNATURE = {
    local: 0x04034b50,
    central: 0x02014b50,
    end: 0x06054b50,
    zip64_end: 0x06064b50,
    zip64_locator: 0x07064b50
};
const ZIP64_EXTRA_ID = 0x0001;

const STORE = 0;
const DEFLATE = 8;
// General purpose bit 11: the name is UTF-8.
const UTF8_NAME = 0x0800;
// Version needed to extract: 2.0 for deflate and folders, 4.5 for ZIP64.
const VERSION = 20;
const VERSION_ZIP64 = 45;
// Version made by, high byte: Unix, so a reader takes the mode from the external attributes.
const MADE_ON_UNIX = 3 << 8;

const MAX_16 = 0xFFFF;
const MAX_32 = 0xFFFFFFFF;

const S_IFDIR = 0o040000;
const S_IFREG = 0o100000;
const S_IFLNK = 0o120000;
const DOS_DIRECTORY = 0x10;

const READ_SIZE = 1024 * 1024;

// MS-DOS date and time, local, as readers expect: two-second steps, 1980 to 2107.
function dosDateTime(when) {
    let date = when instanceof Date && !Number.isNaN(when.getTime()) ? when : new Date();
    if (date.getFullYear() < 1980) date = new Date(1980, 0, 1);
    if (date.getFullYear() > 2107) date = new Date(2107, 11, 31, 23, 59, 58);
    return {
        time: (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1),
        date: ((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate()
    };
}

// The type and permission bits a Unix reader restores, in the top half of the attributes.
function unixAttributes(type, mode, dos = 0) {
    return (((type | (mode & 0o7777)) << 16) | dos) >>> 0;
}

/*************************************************
 * Whether a file's sizes may need 64 bits, decided
 * before its data is written: the header has to
 * hold room for them, and 0xFFFFFFFF itself means
 * "see the ZIP64 field". Deflate can come out a
 * little larger than what went in; this is zlib's
 * deflateBound().
 ************************************************/
function needsZip64(size, method) {
    const growth = method === DEFLATE
        ? Math.floor(size / 4096) + Math.floor(size / 16384) + Math.floor(size / 33554432) + 7 : 0;
    return size + growth >= MAX_32;
}

function zip64Extra(values) {
    const extra = Buffer.alloc(4 + 8 * values.length);
    extra.writeUInt16LE(ZIP64_EXTRA_ID, 0);
    extra.writeUInt16LE(8 * values.length, 2);
    values.forEach((value, index) => extra.writeBigUInt64LE(BigInt(value), 4 + 8 * index));
    return extra;
}

function localHeader(entry) {
    // A local ZIP64 field holds both sizes, always.
    const extra = entry.zip64 ? zip64Extra([entry.size, entry.compressed]) : Buffer.alloc(0);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(SIGNATURE.local, 0);
    header.writeUInt16LE(entry.version, 4);
    header.writeUInt16LE(entry.flags, 6);
    header.writeUInt16LE(entry.method, 8);
    header.writeUInt16LE(entry.time, 10);
    header.writeUInt16LE(entry.date, 12);
    header.writeUInt32LE(entry.crc, 14);
    header.writeUInt32LE(entry.zip64 ? MAX_32 : entry.compressed, 18);
    header.writeUInt32LE(entry.zip64 ? MAX_32 : entry.size, 22);
    header.writeUInt16LE(entry.name.length, 26);
    header.writeUInt16LE(extra.length, 28);
    return Buffer.concat([header, entry.name, extra]);
}

function centralHeader(entry, force_zip64) {
    // The central ZIP64 field holds only what overflows, in this order: readers find each value
    // by its position.
    const zip64_sizes = entry.zip64;
    const zip64_offset = force_zip64 || entry.offset >= MAX_32;
    const extra_values = [...(zip64_sizes ? [entry.size, entry.compressed] : []), ...(zip64_offset ? [entry.offset] : [])];
    const extra = extra_values.length > 0 ? zip64Extra(extra_values) : Buffer.alloc(0);
    const version = extra_values.length > 0 ? VERSION_ZIP64 : entry.version;

    const header = Buffer.alloc(46);
    header.writeUInt32LE(SIGNATURE.central, 0);
    header.writeUInt16LE(MADE_ON_UNIX | version, 4);
    header.writeUInt16LE(version, 6);
    header.writeUInt16LE(entry.flags, 8);
    header.writeUInt16LE(entry.method, 10);
    header.writeUInt16LE(entry.time, 12);
    header.writeUInt16LE(entry.date, 14);
    header.writeUInt32LE(entry.crc, 16);
    header.writeUInt32LE(zip64_sizes ? MAX_32 : entry.compressed, 20);
    header.writeUInt32LE(zip64_sizes ? MAX_32 : entry.size, 24);
    header.writeUInt16LE(entry.name.length, 28);
    header.writeUInt16LE(extra.length, 30);
    // Comment length, starting disk and internal attributes stay 0.
    header.writeUInt32LE(entry.external, 38);
    header.writeUInt32LE(zip64_offset ? MAX_32 : entry.offset, 42);
    return Buffer.concat([header, entry.name, extra]);
}

function zip64EndRecord(count, size, offset) {
    const record = Buffer.alloc(56);
    record.writeUInt32LE(SIGNATURE.zip64_end, 0);
    // The size of the rest of this record.
    record.writeBigUInt64LE(44n, 4);
    record.writeUInt16LE(MADE_ON_UNIX | VERSION_ZIP64, 12);
    record.writeUInt16LE(VERSION_ZIP64, 14);
    // This disk and the central directory's are both 0: one file.
    record.writeBigUInt64LE(BigInt(count), 24);
    record.writeBigUInt64LE(BigInt(count), 32);
    record.writeBigUInt64LE(BigInt(size), 40);
    record.writeBigUInt64LE(BigInt(offset), 48);
    return record;
}

function zip64Locator(record_offset) {
    const locator = Buffer.alloc(20);
    locator.writeUInt32LE(SIGNATURE.zip64_locator, 0);
    locator.writeBigUInt64LE(BigInt(record_offset), 8);
    locator.writeUInt32LE(1, 16);
    return locator;
}

function endRecord(count, size, offset) {
    // A field too small for its value holds all ones, and the ZIP64 record has it. One that
    // fits keeps it, for readers that never look for that record.
    const record = Buffer.alloc(22);
    record.writeUInt32LE(SIGNATURE.end, 0);
    record.writeUInt16LE(Math.min(count, MAX_16), 8);
    record.writeUInt16LE(Math.min(count, MAX_16), 10);
    record.writeUInt32LE(Math.min(size, MAX_32), 12);
    record.writeUInt32LE(Math.min(offset, MAX_32), 16);
    return record;
}

class ZipWriter {
    // zip64: write ZIP64 records whatever the sizes, which only tests need.
    constructor(handle, {compress = false, signal = null, zip64 = false} = {}) {
        this.handle = handle;
        this.method = compress ? DEFLATE : STORE;
        this.signal = signal;
        this.force_zip64 = zip64;
        this.position = 0;
        this.entries = [];
    }

    static async create(zip_path, options = {}) {
        return new ZipWriter(await fs.promises.open(zip_path, 'w'), options);
    }

    async writeAt(buffer, position) {
        let written = 0;
        while (written < buffer.length) {
            const { bytesWritten } = await this.handle.write(buffer, written, buffer.length - written, position + written);
            written += bytesWritten;
        }
    }

    async append(buffer) {
        await this.writeAt(buffer, this.position);
        this.position += buffer.length;
    }

    newEntry(name, mtime, {method = STORE, external, zip64 = false}) {
        const encoded = Buffer.from(name, 'utf8');
        if (encoded.length > MAX_16) throw new Error(`${name} is too long a name for a zip entry`);
        const {time, date} = dosDateTime(mtime);
        const uses_zip64 = this.force_zip64 || zip64;
        return {
            name: encoded, method, time, date, external,
            flags: UTF8_NAME,
            zip64: uses_zip64,
            version: uses_zip64 || this.position >= MAX_32 ? VERSION_ZIP64 : VERSION,
            crc: 0, size: 0, compressed: 0,
            offset: this.position
        };
    }

    async addFile(source_path, name) {
        this.signal?.throwIfAborted();
        const source = await fs.promises.open(source_path, 'r');
        try {
            // From the open file, so the size is the size of what is read.
            const stats = await source.stat();
            if (!stats.isFile()) throw new Error(`${source_path} is not a file`);
            const entry = this.newEntry(name, stats.mtime, {
                method: this.method,
                external: unixAttributes(S_IFREG, stats.mode),
                zip64: needsZip64(stats.size, this.method)
            });
            await this.append(localHeader(entry));

            let crc = 0;
            let size = 0;
            let compressed = 0;
            await pipeline(
                source.createReadStream({ start: 0, highWaterMark: READ_SIZE, autoClose: false }),
                async function* checksum(chunks) {
                    for await (const chunk of chunks) {
                        crc = zlib.crc32(chunk, crc);
                        size += chunk.length;
                        yield chunk;
                    }
                },
                ...(this.method === DEFLATE ? [zlib.createDeflateRaw()] : []),
                async chunks => {
                    for await (const chunk of chunks) {
                        await this.append(chunk);
                        compressed += chunk.length;
                    }
                },
                this.signal ? { signal: this.signal } : {}
            );

            if (!entry.zip64 && (size >= MAX_32 || compressed >= MAX_32)) {
                throw new Error(`${source_path} grew past 4 GiB while it was being added`);
            }
            Object.assign(entry, {crc, size, compressed});
            // The same length as before, now with the checksum and sizes in it.
            await this.writeAt(localHeader(entry), entry.offset);
            this.entries.push(entry);
        } finally {
            await source.close();
        }
    }

    async addFolder(name, stats) {
        this.signal?.throwIfAborted();
        const entry = this.newEntry(name.endsWith('/') ? name : `${name}/`, stats.mtime, {
            external: unixAttributes(S_IFDIR, stats.mode, DOS_DIRECTORY)
        });
        await this.append(localHeader(entry));
        this.entries.push(entry);
    }

    // A link is stored as itself, its target as its data, which Unix readers make a link of again.
    async addLink(name, target, stats) {
        this.signal?.throwIfAborted();
        const data = Buffer.from(target, 'utf8');
        const entry = this.newEntry(name, stats.mtime, {external: unixAttributes(S_IFLNK, 0o777)});
        Object.assign(entry, {crc: zlib.crc32(data), size: data.length, compressed: data.length});
        await this.append(localHeader(entry));
        await this.append(data);
        this.entries.push(entry);
    }

    // The central directory and the records that find it, then the file is done.
    async finish() {
        const directory_offset = this.position;
        let pending = [];
        let pending_size = 0;
        for (const entry of this.entries) {
            const header = centralHeader(entry, this.force_zip64);
            pending.push(header);
            pending_size += header.length;
            if (pending_size >= READ_SIZE) {
                await this.append(Buffer.concat(pending));
                pending = [];
                pending_size = 0;
            }
        }
        if (pending.length > 0) await this.append(Buffer.concat(pending));

        const directory_size = this.position - directory_offset;
        const count = this.entries.length;
        if (this.force_zip64 || count >= MAX_16 || directory_size >= MAX_32 || directory_offset >= MAX_32) {
            const record_offset = this.position;
            await this.append(zip64EndRecord(count, directory_size, directory_offset));
            await this.append(zip64Locator(record_offset));
        }
        await this.append(endRecord(count, directory_size, directory_offset));
        await this.handle.close();
    }

    async abandon() {
        await this.handle.close().catch(() => null);
    }
}

/*************************************************
 * A zip of files, each under its own name with no
 * folders: what a playlist or a subscription is
 * downloaded as. On failure the partial archive is
 * left for the caller, which knows its name.
 ************************************************/
exports.zipFiles = async (zip_path, files, options = {}) => {
    const zip = await ZipWriter.create(zip_path, options);
    try {
        for (const file of files) await zip.addFile(file.path, file.name);
        await zip.finish();
    } catch (err) {
        await zip.abandon();
        throw err;
    }
};

/*************************************************
 * A zip of a folder and everything under it, named
 * relative to it. skip(absolute_path, dirent) can
 * leave anything out, a folder with all of its
 * contents.
 *
 * A link is stored as a link and never followed,
 * so it cannot pull in what it points at or lead
 * back into a folder already being stored.
 ************************************************/
exports.zipFolder = async (zip_path, folder, options = {}) => {
    const skip = options.skip || (() => false);
    const zip = await ZipWriter.create(zip_path, options);

    const addContents = async (directory, prefix) => {
        const entries = await fs.promises.readdir(directory, {withFileTypes: true});
        // Sorted, so the same folder makes the same archive.
        entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
        for (const entry of entries) {
            const absolute = path.join(directory, entry.name);
            if (skip(absolute, entry)) continue;
            const name = prefix + entry.name;
            if (entry.isDirectory()) {
                await zip.addFolder(name, await fs.promises.lstat(absolute));
                await addContents(absolute, `${name}/`);
            } else if (entry.isFile()) {
                await zip.addFile(absolute, name);
            } else if (entry.isSymbolicLink()) {
                // Relative to the link's own folder, so it still points the same way wherever
                // the archive is unpacked.
                const target = path.relative(directory, path.resolve(directory, await fs.promises.readlink(absolute)));
                await zip.addLink(name, target.split(path.sep).join('/'), await fs.promises.lstat(absolute));
            }
            // Sockets, pipes and devices are nothing a zip can give back.
        }
    };

    try {
        await addContents(folder, '');
        await zip.finish();
    } catch (err) {
        await zip.abandon();
        throw err;
    }
};

exports.needsZip64 = needsZip64;
exports.METHOD = {STORE, DEFLATE};
