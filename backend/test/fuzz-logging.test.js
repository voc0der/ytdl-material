/*************************************************
 * Fuzz tests: the yt-dlp command lines that reach
 * the log. Users attach debug logs to issues, so a
 * credential in one is a credential published.
 ************************************************/
const fc = require('fast-check');
const { assert, utils } = require('./test-shared');
const { check, timeout } = require('./helpers/fuzz');

// Every name yt-dlp knows each credential-carrying option by.
const CREDENTIAL_LONG_OPTIONS = [
    '--username', '--password', '--twofactor', '--video-password', '--ap-username', '--ap-password',
    '--client-certificate-password', '--netrc-cmd', '--proxy', '--geo-verification-proxy',
    '--cookies', '--cookies-from-browser', '--add-headers'
];
const CREDENTIAL_SHORT_OPTIONS = ['u', 'p', '2'];
// Real options of their own whose names begin a credential option's, so yt-dlp reads them
// as themselves rather than as an abbreviation.
const OTHER_OPTIONS = new Set(['--netrc', '--client-certificate']);
// Short options that take no value, which may precede one that does in a cluster: -xp.
const SHORT_FLAGS = ['x', 'i', 'w', 'v', 'q', 's', 'k', '4', '6'];

// Options and values that can't carry a credential, as yt-dlp's command lines hold them.
const ORDINARY_ARGS = [
    ['-f', 'bestvideo+bestaudio/best'], ['--format=best'], ['-o', '%(title)s.%(ext)s'], ['--no-mtime'],
    ['--user-agent', 'Mozilla/5.0'], ['-x'], ['--audio-format', 'mp3'], ['-N', '4'], ['-fbest'],
    ['--client-certificate', 'appdata/client.pem'], ['--netrc'], ['--add-metadata'], ['--progress'],
    ['--write-info-json'], ['-S', 'res:720'], ['--sponsorblock-remove', 'sponsor'], ['-j'], ['--no-simulate']
];

const credential = fc.string({unit: fc.constantFrom(...'0123456789abcdef'), minLength: 16, maxLength: 16})
    .map(hex => `Cred${hex}`);

// One credential option with its value, written any way yt-dlp reads it: the full name or
// any abbreviation, any case, the value after = or as the next argument, and the short
// forms with the value attached or following, alone or at the end of a cluster.
const credentialArgs = (value) => fc.oneof(
    fc.tuple(fc.constantFrom(...CREDENTIAL_LONG_OPTIONS), fc.nat(), fc.boolean(), fc.boolean())
        .chain(([option, cut, attached, upper]) => {
            const abbreviation = option.slice(0, 3 + (cut % (option.length - 2)));
            const name = OTHER_OPTIONS.has(abbreviation) ? option : abbreviation;
            const spelled = upper ? name.toUpperCase() : name;
            return fc.constant(attached ? [`${spelled}=${value}`] : [spelled, value]);
        }),
    fc.tuple(fc.array(fc.constantFrom(...SHORT_FLAGS), {maxLength: 3}), fc.constantFrom(...CREDENTIAL_SHORT_OPTIONS),
        fc.constantFrom('separate', 'attached', 'equals'))
        .map(([flags, letter, form]) => {
            const cluster = `-${flags.join('')}${letter}`;
            if (form === 'separate') return [cluster, value];
            return [`${cluster}${form === 'equals' ? '=' : ''}${value}`];
        })
);

const ordinaryArgs = fc.array(fc.constantFrom(...ORDINARY_ARGS), {maxLength: 6}).map(groups => groups.flat());

// A credential, and the arguments that pass it to yt-dlp.
const credentialCase = credential.chain(value => fc.tuple(fc.constant(value), credentialArgs(value)));

// Inputs the fuzzer has found, kept so they run with the regular tests.
const SECRET = 'Cred0000000000000000';
const FOUND = [
    ['-p', SECRET], [`-p${SECRET}`], ['-xu', SECRET], ['--passw', SECRET],
    ['--add-headers', `Authorization: Bearer ${SECRET}`], [`--twofactor=${SECRET}`],
    ['--client-certificate-password', SECRET], ['--netrc-cmd', `pass show ${SECRET}`],
    ['--geo-verification-proxy', `http://user:${SECRET}@proxy`]
].map(args => [[], [SECRET, args], []]);

describe('Fuzz: logged command lines', function() {
    this.timeout(timeout());

    it('never contain a credential, however its option is written', async function() {
        await check(this, fc.property(ordinaryArgs, credentialCase, ordinaryArgs, (before, [value, credential_args], after) => {
            const logged = utils.redactCommandArgsForLogging([...before, ...credential_args, ...after]).join(' ');
            assert(!logged.includes(value), `${value} is in the logged command line: ${logged}`);
        }), FOUND);
    });

    it('leave every other argument as it was', async function() {
        await check(this, fc.property(ordinaryArgs, (args) => {
            assert.deepStrictEqual(utils.redactCommandArgsForLogging(args), args);
        }));
    });
});
