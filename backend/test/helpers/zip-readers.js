const assert = require('assert');
const fs = require('fs');
const { execFileSync, spawnSync } = require('child_process');

/*************************************************
 * Reads archives back with tools that did not
 * write them, for tests of backend/zip.js.
 *
 * Python's zipfile is the main one: it checks
 * every entry's CRC-32, and refuses records whose
 * sizes, offsets or ZIP64 fields disagree.
 ************************************************/

const PYTHON_READER = `
import json, sys, zipfile
with zipfile.ZipFile(sys.argv[1]) as archive:
    bad = archive.testzip()
    print(json.dumps({"bad": bad, "entries": [{
        "name": info.filename, "size": info.file_size, "compressed": info.compress_size,
        "method": info.compress_type, "mode": info.external_attr >> 16, "dos": info.external_attr & 0xFFFF,
        "date_time": list(info.date_time), "is_dir": info.is_dir()
    } for info in archive.infolist()]}))
`;

function hasCommand(command, args = ['--version']) {
    return spawnSync(command, args, {stdio: 'ignore'}).status === 0;
}

const hasPython = () => hasCommand('python3');
const hasUnzip = () => hasCommand('unzip', ['-v']);

// What Python's zipfile makes of an archive. bad is the first entry whose CRC-32 failed.
function readWithPython(zip_path) {
    return JSON.parse(execFileSync('python3', ['-I', '-c', PYTHON_READER, zip_path], {encoding: 'utf8', maxBuffer: 64 * 1024 * 1024}));
}

/*************************************************
 * The records an archive ends with, read by hand:
 * whether there is a ZIP64 end record, and which
 * central entries carry a ZIP64 field. A reader
 * uses those without saying it did.
 ************************************************/
function zipStructure(zip_path) {
    const fd = fs.openSync(zip_path, 'r');
    try {
        const length = fs.fstatSync(fd).size;
        const read = (position, size) => {
            const buffer = Buffer.alloc(size);
            fs.readSync(fd, buffer, 0, size, position);
            return buffer;
        };
        const end = read(length - 22, 22);
        assert.strictEqual(end.readUInt32LE(0), 0x06054b50, 'the archive must end with an end of central directory record');

        let count = end.readUInt16LE(10);
        let directory_size = end.readUInt32LE(12);
        let directory_offset = end.readUInt32LE(16);
        const locator = length >= 42 ? read(length - 42, 20) : null;
        const zip64_end = !!locator && locator.readUInt32LE(0) === 0x07064b50;
        if (zip64_end) {
            const record = read(Number(locator.readBigUInt64LE(8)), 56);
            assert.strictEqual(record.readUInt32LE(0), 0x06064b50, 'the locator must point at the ZIP64 end record');
            count = Number(record.readBigUInt64LE(32));
            directory_size = Number(record.readBigUInt64LE(40));
            directory_offset = Number(record.readBigUInt64LE(48));
        }

        const directory = read(directory_offset, directory_size);
        const entries = [];
        for (let position = 0, index = 0; index < count; index++) {
            assert.strictEqual(directory.readUInt32LE(position), 0x02014b50, `central entry ${index} must start with its signature`);
            const name_length = directory.readUInt16LE(position + 28);
            const extra_length = directory.readUInt16LE(position + 30);
            const comment_length = directory.readUInt16LE(position + 32);
            const extra = directory.subarray(position + 46 + name_length, position + 46 + name_length + extra_length);
            let zip64 = false;
            for (let offset = 0; offset + 4 <= extra.length; offset += 4 + extra.readUInt16LE(offset + 2)) {
                if (extra.readUInt16LE(offset) === 0x0001) zip64 = true;
            }
            entries.push({
                name: directory.toString('utf8', position + 46, position + 46 + name_length),
                version_needed: directory.readUInt16LE(position + 6),
                flags: directory.readUInt16LE(position + 8),
                zip64
            });
            position += 46 + name_length + extra_length + comment_length;
        }
        return {zip64_end, entries};
    } finally {
        fs.closeSync(fd);
    }
}

module.exports = { hasPython, hasUnzip, readWithPython, zipStructure };
