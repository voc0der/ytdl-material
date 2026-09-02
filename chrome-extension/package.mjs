import { spawnSync } from 'node:child_process';
import {
    copyFileSync,
    cpSync,
    existsSync,
    mkdtempSync,
    mkdirSync,
    readFileSync,
    readdirSync,
    rmSync,
    utimesSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const extensionRoot = dirname(fileURLToPath(import.meta.url));
const checkOnly = process.argv.includes('--check');
const fixedTimestamp = new Date('2000-01-01T00:00:00.000Z');

const sharedEntries = [
    'background.js',
    'css',
    'favicon.png',
    'icons',
    'js',
    'options.html',
    'options.js',
    'popup.html',
    'popup.js',
];

const packages = [
    {
        archive: 'ytdl-material-chrome-extension.zip',
        manifest: 'manifest.json',
        name: 'chrome',
    },
    {
        archive: 'ytdl-material-firefox-extension.zip',
        manifest: 'manifest.firefox.json',
        name: 'firefox',
    },
];

function listFiles(directory) {
    return readdirSync(directory, { withFileTypes: true })
        .flatMap((entry) => {
            const path = join(directory, entry.name);
            return entry.isDirectory() ? listFiles(path) : [path];
        })
        .sort();
}

function createArchive(definition, temporaryRoot) {
    const stagingDirectory = join(temporaryRoot, definition.name);
    mkdirSync(stagingDirectory, { recursive: true });

    for (const entry of sharedEntries) {
        cpSync(join(extensionRoot, entry), join(stagingDirectory, entry), {
            recursive: true,
        });
    }

    copyFileSync(
        join(extensionRoot, definition.manifest),
        join(stagingDirectory, 'manifest.json'),
    );

    const files = listFiles(stagingDirectory);
    for (const file of files) {
        utimesSync(file, fixedTimestamp, fixedTimestamp);
    }

    const archivePath = join(temporaryRoot, definition.archive);
    const relativeFiles = files.map((file) => relative(stagingDirectory, file));
    const result = spawnSync('zip', ['-X', '-q', archivePath, ...relativeFiles], {
        cwd: stagingDirectory,
        encoding: 'utf8',
        env: { ...process.env, TZ: 'UTC' },
    });

    if (result.error) {
        throw result.error;
    }

    if (result.status !== 0) {
        throw new Error(result.stderr.trim() || `zip exited with status ${result.status}`);
    }

    return archivePath;
}

const temporaryRoot = mkdtempSync(join(tmpdir(), 'ytdl-material-extension-'));
const staleArchives = [];

try {
    for (const definition of packages) {
        const generatedArchive = createArchive(definition, temporaryRoot);
        const destination = join(extensionRoot, definition.archive);

        if (checkOnly) {
            const matches = existsSync(destination) &&
                readFileSync(destination).equals(readFileSync(generatedArchive));

            if (!matches) {
                staleArchives.push(definition.archive);
            }
            continue;
        }

        copyFileSync(generatedArchive, destination);
        console.log(`Created ${definition.archive}`);
    }
} finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
}

if (staleArchives.length > 0) {
    console.error(
        `Extension archives are stale: ${staleArchives.join(', ')}. ` +
        'Run npm run package:extension.',
    );
    process.exitCode = 1;
} else if (checkOnly) {
    console.log('Extension archives match their source files.');
}
