// Moves interface strings between the XLIFF catalogs and plain JSON, so they can be
// translated without hand-editing XML.
//
// The catalogs in src/assets/i18n are XLIFF 1.2, kept in step with the code by
// `npm run i18n-source` (ng-extract-i18n-merge): every catalog holds exactly the strings the
// interface uses, and a string nobody has translated yet has no <target>, so it renders in
// English.
//
//   status  how many strings each catalog translates;
//   export  writes every source string, numbered, with what a translator needs to place it
//           (description, meaning, what each placeholder stands for, where it appears), and
//           which numbers each catalog is missing;
//   import  takes {"number": "translation"} files for one catalog, checks each translation
//           against its source string and writes the ones that pass as <target>s;
//   check   re-validates every <target> in every catalog.
//
// Placeholders are written {$NAME}, as in the runtime JSON. A translation has to use exactly
// its source's placeholders -- with one missing or invented, Angular drops the translation
// and shows the English -- and keep tag placeholders (START_*/CLOSE_*) properly nested.
// Plural and select messages have to keep the source's cases: the app runs on Angular's
// default en-US locale whatever language is picked, so plural cases are chosen by English
// rules and a `few` or `many` case would never be used.
//
// Not part of CI.
//
// Usage:
//   node dev/i18n/catalog.mjs status
//   node dev/i18n/catalog.mjs export <dir>
//   node dev/i18n/catalog.mjs import <lang> <dir> <translations.json>...
//   node dev/i18n/catalog.mjs check

import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '../..');
const CATALOGS = path.join(ROOT, 'src', 'assets', 'i18n');
const SOURCE_FILE = path.join(CATALOGS, 'messages.en.xlf');

const UNIT = /<trans-unit id="([^"]+)"[^>]*>[\s\S]*?<\/trans-unit>/g;
const PLACEHOLDER_XML = /<x id="([^"]*)"[^>]*?\/>/g;
const PLACEHOLDER_TEXT = /\{\$([^}]+)\}/g;
const ICU_HEADER = /\{(VAR_[A-Z]+(?:_\d+)?),\s*(plural|select),/g;

function languages() {
    return fs.readdirSync(CATALOGS)
        .map(file => file.match(/^messages\.(.+)\.xlf$/)?.[1])
        .filter(lang => lang && lang !== 'en')
        .sort();
}

function catalogPath(lang) {
    return path.join(CATALOGS, `messages.${lang}.xlf`);
}

function unescapeXml(text) {
    return text
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&apos;/g, "'")
        .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
        .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(Number(dec)))
        .replace(/&amp;/g, '&');
}

function escapeXml(text) {
    return text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&apos;');
}

// XLIFF content -> text with {$NAME} placeholders.
function toText(xml) {
    const parts = [];
    let last = 0;
    for (const match of xml.matchAll(PLACEHOLDER_XML)) {
        parts.push(unescapeXml(xml.slice(last, match.index)), `{$${match[1]}}`);
        last = match.index + match[0].length;
    }
    parts.push(unescapeXml(xml.slice(last)));
    return parts.join('');
}

// Text with {$NAME} placeholders -> XLIFF content, reusing the source's <x> elements.
function toXml(text, sourceXml) {
    const elements = new Map();
    for (const match of sourceXml.matchAll(PLACEHOLDER_XML)) {
        if (!elements.has(match[1])) elements.set(match[1], match[0]);
    }
    const parts = [];
    let last = 0;
    for (const match of text.matchAll(PLACEHOLDER_TEXT)) {
        parts.push(escapeXml(text.slice(last, match.index)), elements.get(match[1]));
        last = match.index + match[0].length;
    }
    parts.push(escapeXml(text.slice(last)));
    return parts.join('');
}

function parseUnits(xml) {
    const units = new Map();
    for (const match of xml.matchAll(UNIT)) {
        const block = match[0];
        const target = block.match(/<target(?:\s[^>]*)?>([\s\S]*?)<\/target>/);
        units.set(match[1], {
            block,
            source: block.match(/<source>([\s\S]*?)<\/source>/)[1],
            target: target && target[1].trim() !== '' ? target[1] : null,
            description: block.match(/<note priority="1" from="description">([\s\S]*?)<\/note>/)?.[1],
            meaning: block.match(/<note priority="1" from="meaning">([\s\S]*?)<\/note>/)?.[1],
            files: [...block.matchAll(/<context context-type="sourcefile">([^<]+)<\/context>/g)].map(m => m[1])
        });
    }
    return units;
}

function placeholders(text) {
    return [...text.matchAll(PLACEHOLDER_TEXT)].map(m => m[1]);
}

// Every plural/select expression as "VAR_PLURAL plural: =1,other", nested ones included.
function icuShapes(text) {
    const masked = text.replace(PLACEHOLDER_TEXT, '\u0000');
    const shapes = [];
    for (const header of masked.matchAll(ICU_HEADER)) {
        let i = header.index + header[0].length;
        const keys = [];
        for (;;) {
            while (/\s/.test(masked[i] ?? '')) i++;
            if (masked[i] === '}' || i >= masked.length) break;
            const key = masked.slice(i).match(/^[^\s{}]+/)?.[0];
            if (!key) return null;
            i += key.length;
            while (/\s/.test(masked[i] ?? '')) i++;
            if (masked[i] !== '{') return null;
            let depth = 0;
            for (; i < masked.length; i++) {
                if (masked[i] === '{') depth++;
                else if (masked[i] === '}' && --depth === 0) break;
            }
            if (depth !== 0) return null;
            i++;
            keys.push(key);
        }
        shapes.push(`${header[1]} ${header[2]}: ${keys.sort().join(',')}`);
    }
    return shapes.sort();
}

function braceBalance(text) {
    let depth = 0;
    for (const char of text.replace(PLACEHOLDER_TEXT, '')) {
        if (char === '{') depth++;
        else if (char === '}' && --depth < 0) return false;
    }
    return depth === 0;
}

function tagsNested(names) {
    const open = new Map();
    for (const name of names) {
        const tag = name.match(/^(START|CLOSE)_(.+?)(?:_\d+)?$/);
        if (!tag) continue;
        const depth = (open.get(tag[2]) ?? 0) + (tag[1] === 'START' ? 1 : -1);
        if (depth < 0) return false;
        open.set(tag[2], depth);
    }
    return [...open.values()].every(depth => depth === 0);
}

function validate(source, translation) {
    const problems = [];
    if (translation.trim() === '') return ['empty'];
    const isIcu = ICU_HEADER.test(source);
    ICU_HEADER.lastIndex = 0;
    const wanted = placeholders(source);
    const used = placeholders(translation);
    if (isIcu) {
        const unknown = used.filter(name => !wanted.includes(name));
        if (unknown.length) problems.push(`unknown placeholders ${unknown.join(', ')}`);
        const want = icuShapes(source);
        const got = icuShapes(translation);
        if (!got || JSON.stringify(want) !== JSON.stringify(got)) {
            problems.push(`plural/select cases differ: want ${want.join(' | ')}`);
        }
    } else if (JSON.stringify([...wanted].sort()) !== JSON.stringify([...used].sort())) {
        problems.push(`placeholders differ: want ${wanted.map(p => `{$${p}}`).join(' ') || 'none'}`);
    }
    if (!tagsNested(used)) problems.push('tag placeholders are not nested properly');
    if (!braceBalance(translation)) problems.push('unbalanced braces');
    if (/\{\{|\}\}/.test(translation.replace(PLACEHOLDER_TEXT, '')) && !/\{\{|\}\}/.test(source)) {
        problems.push('contains {{ or }}');
    }
    if (/<\/?[a-z]/i.test(translation) && !/<\/?[a-z]/i.test(source)) problems.push('contains a raw tag');
    return problems;
}

// The source's leading and trailing whitespace is what joins it to its neighbours.
function withSourceSpacing(source, translation) {
    return source.match(/^\s*/)[0] + translation.trim() + source.match(/\s*$/)[0];
}

function ranges(numbers) {
    const out = [];
    for (let i = 0; i < numbers.length; i++) {
        let j = i;
        while (j + 1 < numbers.length && numbers[j + 1] === numbers[j] + 1) j++;
        out.push(i === j ? `${numbers[i]}` : `${numbers[i]}-${numbers[j]}`);
        i = j;
    }
    return out.join(',');
}

function shortFile(file) {
    return path.basename(file).replace(/\.(ts|html)$/, '').replace(/\.(component|service|dialog|pipe)$/, '');
}

function exportCatalogs(dir) {
    if (!dir) usage();
    const source = parseUnits(fs.readFileSync(SOURCE_FILE, 'utf8'));
    const catalogs = new Map(languages().map(lang => [lang, parseUnits(fs.readFileSync(catalogPath(lang), 'utf8'))]));

    // Strings no catalog translates come first, so a catalog that has the commonly
    // translated ones is missing one contiguous range.
    const ids = [...source.keys()];
    const translatedSomewhere = id => [...catalogs.values()].some(units => units.get(id)?.target);
    const order = [...ids.filter(id => !translatedSomewhere(id)), ...ids.filter(translatedSomewhere)];

    const lines = order.map((id, i) => {
        const unit = source.get(id);
        const context = [];
        if (unit.meaning) context.push(`meaning: ${unescapeXml(unit.meaning)}`);
        if (unit.description) context.push(`desc: ${unescapeXml(unit.description)}`);
        const equivs = [...unit.source.matchAll(/<x id="([^"]*)"[^>]*?equiv-text="([^"]*)"/g)]
            .map(m => `${m[1]}=${unescapeXml(m[2])}`);
        if (equivs.length) context.push(`ph: ${[...new Set(equivs)].join(', ')}`);
        const files = [...new Set(unit.files.map(shortFile))];
        if (files.length) context.push(`in: ${files.slice(0, 3).join(', ')}${files.length > 3 ? ', …' : ''}`);
        return `${i + 1}\t${toText(unit.source)}\t${context.join('; ')}`;
    });

    const missing = {};
    for (const [lang, units] of catalogs) {
        missing[lang] = order.map((id, i) => units.get(id)?.target ? null : i + 1).filter(Boolean);
    }

    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'source.tsv'), lines.join('\n') + '\n');
    fs.writeFileSync(path.join(dir, 'index.json'), JSON.stringify(order));
    fs.writeFileSync(path.join(dir, 'missing.json'), JSON.stringify(missing));
    console.log(`${order.length} strings -> ${path.join(dir, 'source.tsv')}`);
    for (const [lang, numbers] of Object.entries(missing)) {
        console.log(`${lang.padEnd(8)} ${String(numbers.length).padStart(5)} missing: ${ranges(numbers)}`);
    }
}

function importTranslations(lang, dir, files) {
    if (!lang || !dir || !files.length) usage();
    const file = catalogPath(lang);
    if (!fs.existsSync(file)) fail(`no catalog ${file}`);
    const order = JSON.parse(fs.readFileSync(path.join(dir, 'index.json'), 'utf8'));
    const xml = fs.readFileSync(file, 'utf8');
    const units = parseUnits(xml);
    if (order.some(id => !units.has(id))) fail('the export no longer matches the catalog; export again');

    const targets = new Map();
    const rejected = [];
    let kept = 0;
    let unchanged = 0;
    for (const input of files) {
        for (const [key, value] of Object.entries(JSON.parse(fs.readFileSync(input, 'utf8')))) {
            const id = order[Number(key) - 1];
            if (!id) {
                rejected.push(`${key}: no such string`);
                continue;
            }
            const unit = units.get(id);
            if (unit.target) {
                kept++;
                continue;
            }
            const source = toText(unit.source);
            const translation = withSourceSpacing(source, String(value));
            const problems = validate(source, translation);
            if (problems.length) {
                rejected.push(`${key}: ${problems.join('; ')}\n    source: ${source}\n    got:    ${translation}`);
                continue;
            }
            if (translation === source) unchanged++;
            targets.set(id, toXml(translation, unit.source));
        }
    }

    const updated = xml.replace(UNIT, (block, id) => {
        if (!targets.has(id)) return block;
        const target = `<target state="translated">${targets.get(id)}</target>`;
        if (/<target(?:\s[^>]*)?(?:\/>|>\s*<\/target>)/.test(block)) {
            return block.replace(/<target(?:\s[^>]*)?(?:\/>|>\s*<\/target>)/, target);
        }
        return block.replace(/(\n([ \t]*)<source>[\s\S]*?<\/source>)/, `$1\n$2${target}`);
    });
    fs.writeFileSync(file, updated);

    const remaining = [...parseUnits(updated).values()].filter(unit => !unit.target).length;
    console.log(`${lang}: wrote ${targets.size} (${unchanged} same as English), kept ${kept} existing, ` +
        `rejected ${rejected.length}, ${remaining} still untranslated`);
    for (const line of rejected) console.log(`  ${line}`);
    process.exitCode = rejected.length ? 1 : 0;
}

function check() {
    const source = parseUnits(fs.readFileSync(SOURCE_FILE, 'utf8'));
    let failures = 0;
    for (const lang of languages()) {
        const units = parseUnits(fs.readFileSync(catalogPath(lang), 'utf8'));
        for (const [id, unit] of units) {
            if (!unit.target) continue;
            const problems = validate(toText(source.get(id)?.source ?? unit.source), toText(unit.target));
            if (!problems.length) continue;
            failures++;
            console.log(`${lang} ${id}: ${problems.join('; ')}`);
        }
    }
    console.log(failures ? `${failures} translations need fixing` : 'all translations pass');
    process.exitCode = failures ? 1 : 0;
}

function status() {
    for (const lang of languages()) {
        const units = [...parseUnits(fs.readFileSync(catalogPath(lang), 'utf8')).values()];
        const done = units.filter(unit => unit.target).length;
        console.log(`${lang.padEnd(8)} ${String(done).padStart(5)} / ${units.length}`);
    }
}

function usage() {
    fail('usage: catalog.mjs status | export <dir> | import <lang> <dir> <file.json>... | check');
}

function fail(message) {
    console.error(message);
    process.exit(2);
}

const [command, ...args] = process.argv.slice(2);
if (command === 'status') status();
else if (command === 'export') exportCatalogs(args[0]);
else if (command === 'import') importTranslations(args[0], args[1], args.slice(2));
else if (command === 'check') check();
else usage();
