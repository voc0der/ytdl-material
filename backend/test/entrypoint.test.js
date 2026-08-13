/* eslint-disable no-undef */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const entrypointPath = path.resolve(__dirname, '..', 'entrypoint.sh');

function writeStub(binDir, name, body) {
    const stubPath = path.join(binDir, name);
    fs.writeFileSync(stubPath, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
}

function runEntrypoint(transcodingMode) {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ytdl-entrypoint-'));
    const binDir = path.join(tempDir, 'bin');
    const callsPath = path.join(tempDir, 'calls');
    fs.mkdirSync(binDir);

    writeStub(binDir, 'id', '[ "$1" = "-u" ] && printf 0 || exit 1');
    writeStub(binDir, 'find', 'exit 0');
    writeStub(binDir, 'dpkg-query', 'exit 1');
    writeStub(binDir, 'ls', 'exit 1');
    writeStub(binDir, 'rm', 'exit 0');
    writeStub(binDir, 'apt-get', 'printf "apt-get %s\\n" "$*" >> "$ENTRYPOINT_CALLS"');
    writeStub(binDir, 'setpriv', 'printf "setpriv %s\\n" "$*" >> "$ENTRYPOINT_CALLS"');

    const result = spawnSync('bash', [entrypointPath, 'npm', 'start'], {
        encoding: 'utf8',
        env: {
            ...process.env,
            PATH: `${binDir}:${process.env.PATH}`,
            ENTRYPOINT_CALLS: callsPath,
            ytdl_uid: '1234',
            ytdl_gid: '2345',
            ytdl_transcoding: transcodingMode
        }
    });

    const calls = fs.existsSync(callsPath) ? fs.readFileSync(callsPath, 'utf8') : '';
    fs.rmSync(tempDir, { recursive: true, force: true });
    assert.strictEqual(result.status, 0, result.stderr || result.stdout);
    return calls;
}

describe('Docker entrypoint', function() {
    it('does not install VAAPI packages when hardware transcoding is disabled', function() {
        const calls = runEntrypoint('false');

        assert(!calls.includes('apt-get'), calls);
    });

    it('installs the VAAPI DRM bridge only when VAAPI is selected', function() {
        const calls = runEntrypoint('vaapi');

        assert(calls.includes('apt-get update'), calls);
        assert(calls.includes('apt-get install -y --no-install-recommends libva-drm2'), calls);
    });

    it('preserves Docker supplemental groups while dropping root privileges', function() {
        const calls = runEntrypoint('false');

        assert(calls.includes('setpriv --reuid 1234 --regid 2345 --keep-groups -- npm start'), calls);
    });
});
