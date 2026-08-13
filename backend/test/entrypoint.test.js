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
    transcodingMode,
    storedTranscodingMode = false,
    storedConfig,
    processUid = '0',
    processGid = processUid === '0' ? '0' : '2345',
    supplementaryGroups = [],
    installedPackages = [],
    vaDriverPresent = false,
    intelDriverPresent = false,
    runtimeUid,
    runtimeGid
} = {}) {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ytdl-entrypoint-'));
    const binDir = path.join(tempDir, 'bin');
    const callsPath = path.join(tempDir, 'calls');
    fs.mkdirSync(binDir);
    fs.mkdirSync(path.join(tempDir, 'appdata'));
    const defaultStoredConfig = {
        YtdlMaterial: {
            Downloader: {
                transcoding: storedTranscodingMode
            }
        }
    };
    fs.writeFileSync(
        path.join(tempDir, 'appdata', 'default.json'),
        JSON.stringify(storedConfig === undefined ? defaultStoredConfig : storedConfig)
    );

    writeStub(binDir, 'id', 'case "$1" in -u) printf "%s" "$ENTRYPOINT_UID" ;; -g) printf "%s" "$ENTRYPOINT_GID" ;; -G) printf "%s" "$ENTRYPOINT_GROUPS" ;; *) exit 1 ;; esac');
    writeStub(binDir, 'find', 'exit 0');
    writeStub(binDir, 'dpkg-query', 'for package_name do :; done; case " $ENTRYPOINT_PACKAGES " in *" $package_name "*) printf "install ok installed" ;; *) exit 1 ;; esac');
    writeStub(binDir, 'ls', 'case "$*" in *iHD_drv_video.so*) [ "$ENTRYPOINT_INTEL_DRIVER" = "true" ] ;; *) [ "$ENTRYPOINT_VA_DRIVER" = "true" ] ;; esac');
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
        ENTRYPOINT_GID: processGid,
        ENTRYPOINT_GROUPS: [processGid, ...supplementaryGroups].join(' '),
        ENTRYPOINT_PACKAGES: installedPackages.join(' '),
        ENTRYPOINT_VA_DRIVER: String(vaDriverPresent),
        ENTRYPOINT_INTEL_DRIVER: String(intelDriverPresent),
        UID: '1000',
        GID: '1000'
    };
    delete env.ytdl_uid;
    delete env.uid;
    delete env.ytdl_gid;
    delete env.gid;
    delete env.ytdl_transcoding;
    delete env.YTDL_TRANSCODING;
    delete env.ytdl_enable_ytdlp_impersonation_dependencies;
    delete env.YTDL_ENABLE_YTDLP_IMPERSONATION_DEPENDENCIES;
    delete env.ytdl_enable_curl_cffi;
    delete env.YTDL_ENABLE_CURL_CFFI;
    if (runtimeUid !== undefined) env.ytdl_uid = runtimeUid;
    if (runtimeGid !== undefined) env.ytdl_gid = runtimeGid;
    if (transcodingMode !== undefined) env.ytdl_transcoding = transcodingMode;

    const result = spawnSync('bash', [entrypointPath, 'npm', 'start'], {
        encoding: 'utf8',
        env,
        cwd: tempDir
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

    it('supports a UID environment override without a GID override', function() {
        const calls = runEntrypoint({ runtimeUid: '1234' });

        assert(calls.includes('gosu 1234:1000 npm start'), calls);
    });

    it('supports a GID environment override without a UID override', function() {
        const calls = runEntrypoint({ runtimeGid: '2345' });

        assert(calls.includes('gosu 1000:2345 npm start'), calls);
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

    it('installs the VAAPI runtime when VAAPI was selected in persisted settings', function() {
        const calls = runEntrypoint({ storedTranscodingMode: 'vaapi' });

        assert(calls.includes('apt-get install -y --no-install-recommends libva-drm2'), calls);
    });

    it('leaves malformed persisted config diagnostics to the backend', function() {
        const calls = runEntrypoint({ storedConfig: [] });

        assert(!calls.includes('apt-get'), calls);
        assert(calls.includes('gosu 1000:1000 npm start'), calls);
    });

    it('does not fall back to a stale legacy root when the current config root exists', function() {
        const calls = runEntrypoint({
            storedConfig: {
                YtdlMaterial: {},
                YoutubeDLMaterial: { Downloader: { transcoding: 'vaapi' } }
            }
        });

        assert(!calls.includes('apt-get'), calls);
    });

    it('lets an explicit environment setting disable persisted VAAPI', function() {
        const calls = runEntrypoint({
            transcodingMode: 'false',
            storedTranscodingMode: 'vaapi'
        });

        assert(!calls.includes('apt-get'), calls);
    });

    it('lets an explicitly empty environment setting disable persisted VAAPI', function() {
        const calls = runEntrypoint({
            transcodingMode: '',
            storedTranscodingMode: 'vaapi'
        });

        assert(!calls.includes('apt-get'), calls);
    });

    it('normalizes whitespace and case in the transcoding environment setting', function() {
        const calls = runEntrypoint({ transcodingMode: ' VAAPI ' });

        assert(calls.includes('apt-get install -y --no-install-recommends libva-drm2'), calls);
    });

    it('does not reinstall an already complete VAAPI runtime', function() {
        const calls = runEntrypoint({
            transcodingMode: 'vaapi',
            installedPackages: ['libva-drm2'],
            vaDriverPresent: true
        });

        assert(!calls.includes('apt-get'), calls);
    });

    it('installs libva-drm2 when a VA driver exists without its DRM bridge', function() {
        const calls = runEntrypoint({
            transcodingMode: 'vaapi',
            vaDriverPresent: true
        });

        assert(calls.includes('apt-get install -y --no-install-recommends libva-drm2'), calls);
    });

    it('retries an incomplete QSV runtime installation', function() {
        const calls = runEntrypoint({
            transcodingMode: 'qsv',
            installedPackages: ['libva-drm2'],
            vaDriverPresent: true
        });

        assert(calls.includes('apt-get install -y --no-install-recommends libmfx-gen1.2'), calls);
    });

    it('retries QSV when only a non-Intel VA driver is installed', function() {
        const calls = runEntrypoint({
            transcodingMode: 'qsv',
            installedPackages: ['libva-drm2', 'libmfx-gen1.2'],
            vaDriverPresent: true
        });

        assert(calls.includes('apt-get install -y --no-install-recommends intel-media-va-driver-non-free'), calls);
    });

    it('does not reinstall an already complete QSV runtime', function() {
        const calls = runEntrypoint({
            transcodingMode: 'qsv',
            installedPackages: ['libva-drm2', 'libmfx-gen1.2'],
            intelDriverPresent: true
        });

        assert(!calls.includes('apt-get'), calls);
    });

    it('preserves Docker supplemental groups while dropping root privileges', function() {
        const calls = runEntrypoint({
            transcodingMode: 'vaapi',
            supplementaryGroups: ['44', '106'],
            runtimeUid: '1234',
            runtimeGid: '2345'
        });

        assert(calls.includes('setpriv --reuid 1234 --regid 2345 --keep-groups -- npm start'), calls);
    });

    it('retains gosu for root VAAPI starts without supplemental groups', function() {
        const calls = runEntrypoint({ transcodingMode: 'vaapi' });

        assert(calls.includes('gosu 1000:1000 npm start'), calls);
        assert(!calls.includes('setpriv'), calls);
    });

    it('preserves Docker supplemental groups for UI-configured VAAPI', function() {
        const calls = runEntrypoint({
            storedTranscodingMode: 'vaapi',
            supplementaryGroups: ['44', '106']
        });

        assert(calls.includes('setpriv --reuid 1000 --regid 1000 --keep-groups -- npm start'), calls);
        assert(!calls.includes('gosu'), calls);
    });

    it('retains gosu when supplemental groups are unrelated to transcoding', function() {
        const calls = runEntrypoint({ supplementaryGroups: ['44', '106'] });

        assert(calls.includes('gosu 1000:1000 npm start'), calls);
        assert(!calls.includes('setpriv'), calls);
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
