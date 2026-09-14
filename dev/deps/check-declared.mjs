// Finds packages the code imports but package.json never declares.
//
// npm installs what package.json lists, and nothing ever checks that list back against
// the code. That lets a module be required successfully for months while being declared
// nowhere: it arrives hoisted in as somebody else's transitive dependency, and it keeps
// working right up until that somebody drops or bumps it. The failure then lands in a
// release that touched something unrelated. `@discordjs/rest` sat like that in
// notifications.js, supplied only by @discordjs/core, and `js-yaml` in the test suite,
// supplied by mocha.
//
// So the check is: resolve every bare specifier in the tree back to a package name, and
// require that name to appear in package.json.
//
// There is deliberately no check for the mirror case -- declared but unused. It cannot be
// told apart from legitimate use without a lot of special-casing: @angular/compiler is
// needed by the build without any file naming it, openapi-typescript-codegen is invoked
// as the `openapi` binary, @types/* are ambient. A pass over this tree flagged eleven
// frontend packages of which most were load-bearing, which is worse than no check at all
// -- somebody eventually trusts it and deletes the compiler. Finding genuinely dead
// dependencies is `git log -S "require('name')"` work, done by hand.
//
// Deliberately not part of CI. It resolves against an installed node_modules, so it would
// report differently depending on install state, and the case it exists to catch is rare
// enough that a run when dependencies change is the better trade -- same reasoning as
// dev/coverage/coverage.sh.
//
// Usage: node dev/deps/check-declared.mjs [frontend|backend]
//        (no argument checks both)

import fs from 'node:fs';
import path from 'node:path';
import Module from 'node:module';

const ROOT = path.resolve(import.meta.dirname, '../..');

const BUILTINS = new Set(Module.builtinModules);

// Directories that are installed, generated, or built -- never our source.
const SKIP_DIRS = ['node_modules', '.git', 'dist', 'coverage', 'public', 'appdata'];

const TREES = [
    {
        name: 'frontend',
        dir: ROOT,
        sources: ['src', 'dev'],
        // eslint.config.js, vitest-base.config.ts and main.js sit at the root and import
        // real packages, so the root itself is scanned too -- but not recursively, or it
        // would swallow the backend tree.
        scan_root: true,
        extensions: ['.ts', '.mts', '.js', '.mjs'],
        // tsconfig sets baseUrl to src, so Angular resolves `app/...` and `api-types/...`
        // against that directory before it ever looks in node_modules. They are folders,
        // not packages, and flagging them would bury the real findings.
        base_url: 'src'
    },
    {
        name: 'backend',
        dir: path.join(ROOT, 'backend'),
        sources: ['.'],
        scan_root: false,
        extensions: ['.js', '.cjs', '.mjs'],
        base_url: null
    }
];

function walk(dir, keep) {
    const found = [];
    if (!fs.existsSync(dir)) return found;
    for (const entry of fs.readdirSync(dir, {withFileTypes: true})) {
        if (entry.isDirectory()) {
            if (SKIP_DIRS.includes(entry.name)) continue;
            found.push(...walk(path.join(dir, entry.name), keep));
        } else if (keep(entry.name)) {
            found.push(path.join(dir, entry.name));
        }
    }
    return found;
}

// Removes comments so that a commented-out import is not mistaken for a live one.
// The block comment at the top of this file names packages it does not import.
//
// String and template literals are stepped over rather than scanned, so a `//` inside a
// URL survives. This is a heuristic, not a parser: a regex literal containing a quote can
// still throw it off, which is acceptable for a dev script.
function strip_comments(source) {
    let out = '';
    let i = 0;

    while (i < source.length) {
        const c = source[i];
        const next = source[i + 1];

        if (c === '/' && next === '/') {
            while (i < source.length && source[i] !== '\n') i++;
        } else if (c === '/' && next === '*') {
            i += 2;
            while (i < source.length && !(source[i] === '*' && source[i + 1] === '/')) i++;
            i += 2;
        } else if (c === '"' || c === "'" || c === '`') {
            out += c;
            i++;
            while (i < source.length) {
                if (source[i] === '\\') {
                    out += source.slice(i, i + 2);
                    i += 2;
                    continue;
                }
                out += source[i];
                const closed = source[i] === c;
                i++;
                if (closed) break;
            }
        } else {
            out += c;
            i++;
        }
    }

    return out;
}

const SPECIFIER_PATTERNS = [
    /(?:require|import)\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    /\bfrom\s*['"]([^'"]+)['"]/g,
    /\bimport\s+['"]([^'"]+)['"]/g
];

function specifiers(source) {
    const found = [];
    for (const pattern of SPECIFIER_PATTERNS) {
        pattern.lastIndex = 0;
        let match;
        while ((match = pattern.exec(source)) !== null) found.push(match[1]);
    }
    return found;
}

// '@scope/pkg/sub' -> '@scope/pkg', 'pkg/sub' -> 'pkg'.
function package_name(specifier) {
    if (specifier.startsWith('@')) return specifier.split('/').slice(0, 2).join('/');
    return specifier.split('/')[0];
}

// A specifier that baseUrl resolves to a directory in the tree rather than to a package.
function resolves_under_base_url(tree, specifier) {
    if (!tree.base_url) return false;
    const base = path.join(tree.dir, tree.base_url, specifier);
    return [base, `${base}.ts`, `${base}.js`, path.join(base, 'index.ts')].some((p) => fs.existsSync(p));
}

function declared_packages(manifest) {
    return new Set([
        ...Object.keys(manifest.dependencies || {}),
        ...Object.keys(manifest.devDependencies || {}),
        ...Object.keys(manifest.optionalDependencies || {}),
        ...Object.keys(manifest.peerDependencies || {})
    ]);
}

function source_files(tree) {
    const matches = (name) => tree.extensions.some((ext) => name.endsWith(ext));

    const root_files = tree.scan_root
        ? fs.readdirSync(tree.dir, {withFileTypes: true})
            .filter((entry) => entry.isFile() && matches(entry.name))
            .map((entry) => path.join(tree.dir, entry.name))
        : [];

    return [...root_files, ...tree.sources.flatMap((source) => walk(path.join(tree.dir, source), matches))];
}

function check(tree) {
    const manifest = JSON.parse(fs.readFileSync(path.join(tree.dir, 'package.json'), 'utf8'));
    const declared = declared_packages(manifest);
    const files = source_files(tree);

    const undeclared = new Map();
    let scanned = 0;

    for (const file of files) {
        const source = strip_comments(fs.readFileSync(file, 'utf8'));

        for (const specifier of specifiers(source)) {
            // A quoted `${...}` inside a template literal is prose, not a module id --
            // backend/files.js logs "from '${file_uid}'" and would match otherwise.
            if (specifier.includes('${')) continue;
            if (specifier.startsWith('.') || specifier.startsWith('/') || specifier.startsWith('~')) continue;

            const bare = specifier.startsWith('node:') ? specifier.slice(5) : specifier;
            if (BUILTINS.has(bare)) continue;
            if (resolves_under_base_url(tree, specifier)) continue;

            scanned++;
            const name = package_name(specifier);
            if (declared.has(name)) continue;

            if (!undeclared.has(name)) undeclared.set(name, new Set());
            undeclared.get(name).add(path.relative(ROOT, file));
        }
    }

    return {undeclared, scanned, files: files.length};
}

const requested = process.argv[2];
const trees = requested ? TREES.filter((tree) => tree.name === requested) : TREES;

if (trees.length === 0) {
    console.error(`Unknown tree '${requested}'. Expected one of: ${TREES.map((tree) => tree.name).join(', ')}`);
    process.exit(2);
}

let failed = false;

for (const tree of trees) {
    const {undeclared, scanned, files} = check(tree);

    console.log(`\n${tree.name}: ${scanned} package specifiers across ${files} files`);

    if (undeclared.size === 0) {
        console.log('  Every imported package is declared.');
        continue;
    }

    failed = true;
    console.log('\n  Imported but not declared in package.json:');
    for (const [name, where] of [...undeclared.entries()].sort()) {
        console.log(`    ${name}`);
        for (const file of [...where].sort()) console.log(`      ${file}`);
    }
}

if (failed) {
    console.log('\nAn undeclared package resolves today only because something else happens to');
    console.log('supply it. Add it to package.json before that stops being true.\n');
    process.exit(1);
}

console.log('');
