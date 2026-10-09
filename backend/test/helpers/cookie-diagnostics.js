const fs = require('fs-extra');
const path = require('path');

// Loaded only in the disposable server process. The route uses a source-relative
// cookie path; redirect precisely that path so even a developer's existing cookies
// are never read or changed. All other filesystem operations remain real.
const cookiePath = path.resolve(__dirname, '../../appdata/cookies.txt');
const fixturePath = path.join(process.cwd(), 'appdata', 'cookies.txt');
for (const method of ['pathExists', 'stat', 'readFile']) {
    const original = fs[method];
    fs[method] = function(filename, ...args) {
        return original.call(this, filename === cookiePath ? fixturePath : filename, ...args);
    };
}

// The downloader is the only external integration. Each request reads the scenario
// prepared by the parent, so success and failure responses need no network or binary.
require('../../youtube-dl').runYoutubeDL = async (url, args) => {
    await fs.writeJSON(path.join(process.cwd(), 'appdata', 'cookie-test-call.json'), {url, args});
    const scenario = await fs.readJSON(path.join(process.cwd(), 'appdata', 'cookie-test-scenario.json'));
    if (scenario.launch_error) throw scenario.launch_error;
    if (scenario.no_process) return null;
    if (scenario.no_callback) return {};
    if (scenario.stderr_buffer) scenario.result.err.stderr = Buffer.from(scenario.result.err.stderr);
    return {callback: Promise.resolve(scenario.result)};
};
