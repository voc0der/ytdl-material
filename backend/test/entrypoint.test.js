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

const realPython = spawnSync('sh', ['-c', 'command -v python3'], { encoding: 'utf8' }).stdout.trim();

function runEntrypointDetailed({
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
    runtimeGid,
    impersonation = false,
    updateChannel,
    impersonationAlreadyPresent = false,
    installedChannelMarker
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

    // python3 is used for three different things here: `-m pip` installs, `-I -` config
    // reads, and `- <path>` import probes. Only pip is faked; the other two delegate to the
    // real interpreter so config parsing is genuinely exercised.
    const impersonationMarker = path.join(tempDir, 'impersonation-installed');
    if (impersonationAlreadyPresent) fs.writeFileSync(impersonationMarker, '');
    writeStub(binDir, 'python3', [
        'case "$1" in',
        '  -m) printf "pip %s\\n" "$*" >> "$ENTRYPOINT_CALLS"; : > "$ENTRYPOINT_IMPERSONATION_MARKER"; exit 0 ;;',
        '  -I) exec "$ENTRYPOINT_REAL_PYTHON" "$@" ;;',
        'esac',
        'if [ "$1" = "-" ]; then',
        '  cat >/dev/null',
        '  [ -f "$ENTRYPOINT_IMPERSONATION_MARKER" ] && exit 0',
        '  exit 1',
        'fi',
        'exec "$ENTRYPOINT_REAL_PYTHON" "$@"'
    ].join('\n'));

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
        ENTRYPOINT_REAL_PYTHON: realPython,
        ENTRYPOINT_IMPERSONATION_MARKER: impersonationMarker,
        UID: '1000',
        GID: '1000'
    };
    delete env.ytdl_ytdlp_update_channel;
    delete env.YTDL_YTDLP_UPDATE_CHANNEL;
    delete env.ytdl_ytdlp_impersonation_python_path;
    delete env.YTDL_YTDLP_IMPERSONATION_PYTHON_PATH;
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
    if (impersonation) env.ytdl_enable_ytdlp_impersonation_dependencies = 'true';
    if (updateChannel !== undefined) env.ytdl_ytdlp_update_channel = updateChannel;

    const impersonationTarget = path.join(tempDir, 'appdata', 'ytdlp-impersonation', 'python');
    if (installedChannelMarker !== undefined) {
        fs.mkdirSync(impersonationTarget, { recursive: true });
        fs.writeFileSync(path.join(impersonationTarget, '.ytdl-material-channel'), installedChannelMarker);
    }

    const result = spawnSync('bash', [entrypointPath, 'npm', 'start'], {
        encoding: 'utf8',
        env,
        cwd: tempDir
    });

    const calls = fs.existsSync(callsPath) ? fs.readFileSync(callsPath, 'utf8') : '';
    const storedChannel = fs.existsSync(path.join(impersonationTarget, '.ytdl-material-channel'))
        ? fs.readFileSync(path.join(impersonationTarget, '.ytdl-material-channel'), 'utf8')
        : null;
    const stdout = result.stdout || '';
    fs.rmSync(tempDir, { recursive: true, force: true });
    assert.strictEqual(result.status, 0, result.stderr || result.stdout);
    return { calls, stdout, storedChannel };
}

function runEntrypoint(options) {
    return runEntrypointDetailed(options).calls;
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

describe('Docker entrypoint yt-dlp impersonation channel', function() {
    it('installs the stable release when no channel is configured', function() {
        const { calls, storedChannel } = runEntrypointDetailed({ impersonation: true });

        assert(calls.includes('pip -m pip install'), calls);
        assert(!calls.includes('--pre'), calls);
        assert.strictEqual(storedChannel, 'stable');
    });

    it('installs the nightly pre-release when the channel is nightly', function() {
        const { calls, storedChannel } = runEntrypointDetailed({ impersonation: true, updateChannel: 'nightly' });

        assert(calls.includes('--pre'), calls);
        assert.strictEqual(storedChannel, 'nightly');
    });

    it('normalizes case and whitespace in the channel environment value', function() {
        const { calls, storedChannel } = runEntrypointDetailed({ impersonation: true, updateChannel: '  NIGHTLY  ' });

        assert(calls.includes('--pre'), calls);
        assert.strictEqual(storedChannel, 'nightly');
    });

    it('reads the channel from persisted settings when no environment value is set', function() {
        const { calls, storedChannel } = runEntrypointDetailed({
            impersonation: true,
            storedConfig: { YtdlMaterial: { Downloader: { transcoding: false }, Advanced: { ytdlp_update_channel: 'nightly' } } }
        });

        assert(calls.includes('--pre'), calls);
        assert.strictEqual(storedChannel, 'nightly');
    });

    it('warns and falls back to nightly for master, which PyPI does not publish', function() {
        const { calls, stdout } = runEntrypointDetailed({ impersonation: true, updateChannel: 'master' });

        assert(stdout.includes("PyPI has no 'master' channel"), stdout);
        assert(calls.includes('--pre'), calls);
    });

    it('skips the install entirely for an unrecognized channel', function() {
        const { calls, stdout } = runEntrypointDetailed({ impersonation: true, updateChannel: 'nightlyy' });

        assert(stdout.includes("unknown ytdl_ytdlp_update_channel 'nightlyy'"), stdout);
        assert(!calls.includes('pip -m pip install'), calls);
    });

    it('reinstalls when the configured channel differs from the installed one', function() {
        const { calls } = runEntrypointDetailed({
            impersonation: true,
            updateChannel: 'nightly',
            impersonationAlreadyPresent: true,
            installedChannelMarker: 'stable'
        });

        assert(calls.includes('--pre'), calls);
    });

    it('does not reinstall when the installed channel already matches', function() {
        const { calls } = runEntrypointDetailed({
            impersonation: true,
            updateChannel: 'nightly',
            impersonationAlreadyPresent: true,
            installedChannelMarker: 'nightly'
        });

        assert(!calls.includes('pip -m pip install'), calls);
    });

    it('does not touch impersonation dependencies when the feature is disabled', function() {
        const { calls } = runEntrypointDetailed({ updateChannel: 'nightly' });

        assert(!calls.includes('pip'), calls);
    });
});
