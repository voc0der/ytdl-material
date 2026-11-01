// Converts each language catalog in src/assets/i18n into the JSON that src/main.ts hands to
// loadTranslations, and lists the languages that translate anything in supported_locales.json
// for the language picker. Runs before every build (npm's prebuild).
//
// Angular's own XLIFF parser does the conversion, so placeholders come out the way $localize
// expects them: {$NAME} in a message, {NAME} inside a plural or select. xliff-to-json, which
// did this before, wrote any message with a placeholder as an array, and loadTranslations
// threw on the first one it met -- silently, since main.ts carries on in English -- so no
// language with a translated placeholder message ever loaded completely.
//
// The parser treats a unit with no <target> as translated into its English source. Only units
// with a target are kept: an untranslated string shows in English either way, but a catalog
// that translates nothing has to stay out of the picker.

import fs from 'node:fs';
import path from 'node:path';
import { Xliff1TranslationParser } from '@angular/localize/tools';

const DIR = path.join('src', 'assets', 'i18n');
const UNIT = /<trans-unit id="([^"]+)"[^>]*>([\s\S]*?)<\/trans-unit>/g;
const TARGET = /<target(?:\s[^>]*)?>([\s\S]*?)<\/target>/;

function translatedIds(xml) {
    const ids = new Set();
    for (const [, id, body] of xml.matchAll(UNIT)) {
        const target = body.match(TARGET);
        if (target && target[1].trim() !== '') ids.add(id);
    }
    return ids;
}

const parser = new Xliff1TranslationParser();
const locales = [];

for (const file of fs.readdirSync(DIR).sort()) {
    const locale = file.match(/^messages\.(.+)\.xlf$/)?.[1];
    if (!locale || locale === 'en') continue;

    const filePath = path.join(DIR, file);
    const xml = fs.readFileSync(filePath, 'utf8');
    const analysis = parser.analyze(filePath, xml);
    if (!analysis.canParse) throw new Error(`${filePath} is not an XLIFF 1.2 catalog`);
    const bundle = parser.parse(filePath, xml, analysis.hint);
    const errors = bundle.diagnostics.messages.filter(message => message.type === 'error');
    if (errors.length) throw new Error(`${filePath}:\n${errors.map(error => error.message).join('\n')}`);

    const ids = translatedIds(xml);
    const translations = {};
    for (const [id, translation] of Object.entries(bundle.translations)) {
        if (ids.has(id)) translations[id] = translation.text;
    }
    fs.writeFileSync(path.join(DIR, `messages.${locale}.json`), JSON.stringify(translations));
    if (ids.size) locales.push(locale);
}

fs.writeFileSync(path.join(DIR, 'supported_locales.json'), JSON.stringify({ supported_locales: locales }));
