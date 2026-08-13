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

function runEntrypoint({
    transcodingMode = 'false',
    processUid = '0',
    runtimeUid,
    runtimeGid
} = {}) {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ytdl-entrypoint-'));
    const binDir = path.join(tempDir, 'bin');
    const callsPath = path.join(tempDir, 'calls');
    fs.mkdirSync(binDir);

    writeStub(binDir, 'id', 'case "$1" in -u) printf "%s" "$ENTRYPOINT_UID" ;; -g) printf 2345 ;; *) exit 1 ;; esac');
    writeStub(binDir, 'find', 'exit 0');
    writeStub(binDir, 'dpkg-query', 'exit 1');
    writeStub(binDir, 'ls', 'exit 1');
    writeStub(binDir, 'rm', 'exit 0');
    writeStub(binDir, 'apt-get', 'printf "apt-get %s\\n" "$*" >> "$ENTRYPOINT_CALLS"');
    writeStub(binDir, 'gosu', 'printf "gosu %s\\n" "$*" >> "$ENTRYPOINT_CALLS"');
    writeStub(binDir, 'setpriv', 'printf "setpriv %s\\n" "$*" >> "$ENTRYPOINT_CALLS"');
    writeStub(binDir, 'npm', 'printf "npm %s\\n" "$*" >> "$ENTRYPOINT_CALLS"');

    const env = {
        ...process.env,
        PATH: `${binDir}:${process.env.PATH}`,
        ENTRYPOINT_CALLS: callsPath,
        ENTRYPOINT_UID: processUid,
        UID: '1000',
        GID: '1000',
        ytdl_transcoding: transcodingMode
    };
    delete env.ytdl_uid;
    delete env.uid;
    delete env.ytdl_gid;
    delete env.gid;
    if (runtimeUid !== undefined) env.ytdl_uid = runtimeUid;
    if (runtimeGid !== undefined) env.ytdl_gid = runtimeGid;

    const result = spawnSync('bash', [entrypointPath, 'npm', 'start'], {
        encoding: 'utf8',
        env
    });

    const calls = fs.existsSync(callsPath) ? fs.readFileSync(callsPath, 'utf8') : '';
    fs.rmSync(tempDir, { recursive: true, force: true });
    assert.strictEqual(result.status, 0, result.stderr || result.stdout);
    return calls;
}

describe('Docker entrypoint', function() {
    it('does not install VAAPI packages when hardware transcoding is disabled', function() {
        const calls = runEntrypoint();

        assert(!calls.includes('apt-get'), calls);
    });

    it('uses the image UID/GID defaults when Docker starts as root without overrides', function() {
        const calls = runEntrypoint();

        assert(calls.includes('gosu 1000:1000 npm start'), calls);
    });

    it('uses UID/GID environment overrides when Docker starts as root', function() {
        const calls = runEntrypoint({ runtimeUid: '1234', runtimeGid: '2345' });

        assert(calls.includes('gosu 1234:2345 npm start'), calls);
    });

    it('installs the VAAPI DRM bridge only when VAAPI is selected', function() {
        const calls = runEntrypoint({
            transcodingMode: 'vaapi',
            runtimeUid: '1234',
            runtimeGid: '2345'
        });

        assert(calls.includes('apt-get update'), calls);
        assert(calls.includes('apt-get install -y --no-install-recommends libva-drm2'), calls);
    });

    it('preserves Docker supplemental groups while dropping root privileges', function() {
        const calls = runEntrypoint({
            transcodingMode: 'vaapi',
            runtimeUid: '1234',
            runtimeGid: '2345'
        });

        assert(calls.includes('setpriv --reuid 1234 --regid 2345 --keep-groups -- npm start'), calls);
    });

    it('runs directly when only Docker user starts the container non-root', function() {
        const calls = runEntrypoint({ processUid: '1234' });

        assert(calls.includes('npm start'), calls);
        assert(!calls.includes('gosu'), calls);
        assert(!calls.includes('setpriv'), calls);
    });

    it('runs directly when Docker user and UID/GID overrides are both set', function() {
        const calls = runEntrypoint({
            processUid: '1234',
            runtimeUid: '1234',
            runtimeGid: '2345'
        });

        assert(calls.includes('npm start'), calls);
        assert(!calls.includes('gosu'), calls);
        assert(!calls.includes('setpriv'), calls);
    });

    it('runs VAAPI directly without installing packages when Docker starts non-root', function() {
        const calls = runEntrypoint({
            transcodingMode: 'vaapi',
            processUid: '1234'
        });

        assert(!calls.includes('apt-get'), calls);
        assert(calls.includes('npm start'), calls);
        assert(!calls.includes('gosu'), calls);
        assert(!calls.includes('setpriv'), calls);
    });
});
