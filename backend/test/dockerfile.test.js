const assert = require('assert');
const fs = require('fs');
const path = require('path');

const dockerfilePath = path.resolve(__dirname, '..', '..', 'Dockerfile');

// Docker joins a line ending in a backslash with the next one, so an instruction that spans
// several lines has to be reassembled before anything can be asserted about it.
function readInstructions(dockerfileText) {
    const instructions = [];
    let pending = null;

    for (const rawLine of dockerfileText.split('\n')) {
        const line = rawLine.replace(/\r$/, '');
        // Comments inside a continuation are stripped by Docker, not appended to the command.
        if (/^\s*#/.test(line)) continue;
        if (pending === null && !line.trim()) continue;

        const continues = /\\\s*$/.test(line);
        const body = continues ? line.replace(/\\\s*$/, '') : line;
        pending = pending === null ? body : `${pending} ${body.trim()}`;

        if (!continues) {
            instructions.push(pending.trim());
            pending = null;
        }
    }

    if (pending !== null) instructions.push(pending.trim());
    return instructions;
}

// Only the last stage produces the published image; a package installed in an earlier stage
// is not in it unless it is copied forward.
function finalStageInstructions(instructions) {
    const lastFromIndex = instructions.reduce(
        (found, instruction, index) => (/^FROM\s/i.test(instruction) ? index : found),
        -1
    );
    assert.notStrictEqual(lastFromIndex, -1, 'Dockerfile has no FROM instruction');
    return instructions.slice(lastFromIndex + 1);
}

describe('Dockerfile', function() {
    const instructions = readInstructions(fs.readFileSync(dockerfilePath, 'utf8'));
    const finalStage = finalStageInstructions(instructions);
    const pipInstalls = finalStage.filter(
        (instruction) => /^RUN\s/i.test(instruction) && /\bpip install\b/.test(instruction)
    );

    // Regression guard for #496. yt-dlp's impersonation is what gets past sites that
    // fingerprint TLS; without curl_cffi importable by the system Python that runs the
    // downloaded yt-dlp zipapp, those downloads fail with a bare 403 and yt-dlp only warns
    // that no impersonate target is available. This was dropped once already, in the
    // Dockerfile cleanup that removed the build-time yt-dlp install.
    it('installs curl_cffi into the runtime image so yt-dlp has an impersonation target', function() {
        assert(
            pipInstalls.some((instruction) => /\bcurl[_-]cffi\b/.test(instruction)),
            `No pip install in the final stage installs curl_cffi:\n${pipInstalls.join('\n')}`
        );
    });

    // The zipapp imports Cryptodome from the system Python for AES-encrypted HLS streams.
    it('installs pycryptodomex into the runtime image', function() {
        assert(
            pipInstalls.some((instruction) => /\bpycryptodomex\b/.test(instruction)),
            `No pip install in the final stage installs pycryptodomex:\n${pipInstalls.join('\n')}`
        );
    });

    // pip itself is what installs both of the above, and the entrypoint's impersonation
    // install shells out to it at startup.
    it('keeps python3 and pip available in the runtime image', function() {
        const aptInstalls = finalStage.filter(
            (instruction) => /^RUN\s/i.test(instruction) && /\bapt(-get)?\s+install\b/.test(instruction)
        );

        assert(
            aptInstalls.some((instruction) => /\bpython3-pip\b/.test(instruction)),
            `No apt install in the final stage installs python3-pip:\n${aptInstalls.join('\n')}`
        );
        assert(
            aptInstalls.some((instruction) => /\bpython3(-minimal)?\b/.test(instruction)),
            `No apt install in the final stage installs python3:\n${aptInstalls.join('\n')}`
        );
    });
});
