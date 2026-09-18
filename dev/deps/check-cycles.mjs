// Finds frontend modules that import each other, directly or through others.
//
// A cycle between two standalone components is invisible everywhere except a production
// build. The dev server and the unit tests evaluate modules in an order where each side is
// defined by the time the other needs it; the production bundle can put one first, and that
// one's `imports` then holds `undefined` where the other component should be. Angular reports
// it as NG0919 ("Cannot read @Component metadata") the first time the component renders --
// which for the playlist editor, when it embedded the media library that opens it, was an
// empty dialog, and only in a release.
//
// So the check is: walk every runtime import in src/app (type-only imports are erased and
// cannot form a cycle), and report each group of files that can reach itself.
//
// Not part of CI, like check-declared.mjs next to it: worth a run after moving a component,
// or when a production build shows an NG0919 that `ng serve` does not.
//
// Usage: node dev/deps/check-cycles.mjs

import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '../..');
const SRC = path.join(ROOT, 'src');

function sourceFiles(dir, found = []) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) sourceFiles(full, found);
        else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.spec.ts')) found.push(full);
    }
    return found;
}

// `app/...` is the tsconfig path alias for src/app; anything else bare is a package.
function resolveImport(from, specifier) {
    let base;
    if (specifier.startsWith('.')) base = path.resolve(path.dirname(from), specifier);
    else if (specifier.startsWith('app/')) base = path.join(SRC, specifier);
    else return null;
    for (const candidate of [`${base}.ts`, path.join(base, 'index.ts')]) {
        if (fs.existsSync(candidate)) return candidate;
    }
    return null;
}

const IMPORT = /^\s*(?:import|export)\s+(type\s+)?(?:[^'";]*?\sfrom\s+)?['"]([^'"]+)['"]/gm;

const graph = new Map();
for (const file of sourceFiles(path.join(SRC, 'app'))) {
    const source = fs.readFileSync(file, 'utf8');
    const edges = new Set();
    for (const [, typeOnly, specifier] of source.matchAll(IMPORT)) {
        if (typeOnly) continue;
        const target = resolveImport(file, specifier);
        if (target) edges.add(target);
    }
    graph.set(file, [...edges]);
}

// Tarjan's strongly connected components: every component with more than one file, or one
// file importing itself, is a cycle.
const index = new Map();
const low = new Map();
const stack = [];
const onStack = new Set();
const cycles = [];
let counter = 0;

function visit(node) {
    index.set(node, counter);
    low.set(node, counter);
    counter++;
    stack.push(node);
    onStack.add(node);
    for (const next of graph.get(node) ?? []) {
        if (!index.has(next)) {
            visit(next);
            low.set(node, Math.min(low.get(node), low.get(next)));
        } else if (onStack.has(next)) {
            low.set(node, Math.min(low.get(node), index.get(next)));
        }
    }
    if (low.get(node) !== index.get(node)) return;
    const component = [];
    let member;
    do {
        member = stack.pop();
        onStack.delete(member);
        component.push(member);
    } while (member !== node);
    if (component.length > 1 || (graph.get(node) ?? []).includes(node)) cycles.push(component);
}

for (const node of graph.keys()) {
    if (!index.has(node)) visit(node);
}

if (cycles.length === 0) {
    console.log(`No import cycles in ${graph.size} files under src/app.`);
} else {
    for (const cycle of cycles) {
        console.log('These import each other:');
        for (const file of cycle.sort()) console.log(`  ${path.relative(ROOT, file)}`);
    }
    process.exitCode = 1;
}
