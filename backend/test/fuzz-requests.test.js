/*************************************************
 * Fuzz tests: what a request's path and address
 * decide. Rate limits are skipped by path, and the
 * reverse proxy whitelist and header sign-in trust
 * the address a connection comes from.
 ************************************************/
const fc = require('fast-check');
const net = require('net');
const { assert } = require('./test-shared');
const rate_limit_paths = require('../rate-limit-paths');
const ip_ranges = require('../ip-ranges');
const { check, timeout } = require('./helpers/fuzz');

describe('Fuzz: rate limits', function() {
    this.timeout(timeout());

    const SEGMENTS = ['api', 'auth', 'login', 'jwtAuth', 'adminExists', 'get', 'getFile', 'stream', 'thumbnail',
        'rss', 'telegramRequest', 'register', 'downloadFile', '', '..', '.', 'API', 'Auth', '%2F', 'x'];
    const request_path = fc.array(fc.constantFrom(...SEGMENTS), {minLength: 1, maxLength: 5}).map(segments => `/${segments.join('/')}`);
    const extra = fc.string({unit: fc.constantFrom(...'/apiauthgetx?#&=%.'), maxLength: 16});

    it('decide by the path alone, never by the query or the fragment', async function() {
        await check(this, fc.property(request_path, extra, fc.constantFrom('?', '#'), (pathname, suffix, separator) => {
            const plain = {originalUrl: pathname};
            const extended = {originalUrl: `${pathname}${separator}${suffix}`};
            assert.strictEqual(rate_limit_paths.skipApiRateLimit(extended), rate_limit_paths.skipApiRateLimit(plain), extended.originalUrl);
            assert.strictEqual(rate_limit_paths.skipAuthRateLimit(extended), rate_limit_paths.skipAuthRateLimit(plain), extended.originalUrl);
        }), [
            // A query naming an exempt route used to exempt the request it was put on.
            ['/api/auth/login', 'x=/api/get', '?']
        ]);
    });

    // The routes that check a credential, as Express routes them: in any case, and with or
    // without a trailing slash.
    const CREDENTIAL_ROUTES = ['/api/auth/login', '/api/auth/register', '/api/auth/changePassword',
        '/api/auth/header/login', '/api/auth/oidc/login', '/api/auth/oidc/callback'];
    const credential_request = fc.tuple(fc.mixedCase(fc.constantFrom(...CREDENTIAL_ROUTES)), fc.boolean(), fc.option(extra, {nil: ''}))
        .map(([route, slash, query]) => `${route}${slash ? '/' : ''}${query ? `?${query}` : ''}`);

    it('never exempt a request that reaches a credential check from either limiter', async function() {
        await check(this, fc.property(credential_request, (url) => {
            assert.strictEqual(rate_limit_paths.skipAuthRateLimit({originalUrl: url}), false, url);
            assert.strictEqual(rate_limit_paths.skipApiRateLimit({originalUrl: url}), false, url);
        }));
    });
});

describe('Fuzz: trusted proxy addresses', function() {
    this.timeout(timeout());

    // IPv4, and IPv6 from 2000::/3 and fc00::/7, where proxies live. Prefixes keep each IPv6
    // range away from the IPv4-mapped one, whose matching against IPv4 Node defines itself.
    const ipv4 = fc.ipV4();
    const hextet = fc.oneof(fc.constant(0), fc.integer({min: 0, max: 0xffff}));
    const ipv6 = fc.tuple(fc.constantFrom(0x2001, 0x2a00, 0x2606, 0xfc00, 0xfd12), fc.array(hextet, {minLength: 7, maxLength: 7}), fc.boolean(), fc.boolean())
        .map(([first, rest, compress, upper]) => {
            let text = [first, ...rest].map(group => group.toString(16)).join(':');
            // The first run of two or more zero groups, written as ::.
            if (compress) text = text.replace(/(^|:)0(:0)+(:|$)/, '::');
            return upper ? text.toUpperCase() : text;
        });
    const entry = fc.oneof(
        fc.tuple(ipv4, fc.option(fc.integer({min: 0, max: 32}))).map(([address, prefix]) => (prefix === null ? address : `${address}/${prefix}`)),
        fc.tuple(ipv6, fc.option(fc.integer({min: 16, max: 128}))).map(([address, prefix]) => (prefix === null ? address : `${address}/${prefix}`))
    );
    const list = fc.array(entry, {maxLength: 5}).map(entries => entries.join(', '));

    function toBigInt(address) {
        if (net.isIPv4(address)) return address.split('.').reduce((value, part) => (value << 8n) | BigInt(Number(part)), 0n);
        const [head, tail] = address.includes('::') ? address.split('::') : [address, null];
        const head_groups = head ? head.split(':') : [];
        const tail_groups = tail ? tail.split(':') : [];
        const groups = tail === null ? head_groups : [...head_groups, ...Array(8 - head_groups.length - tail_groups.length).fill('0'), ...tail_groups];
        return groups.reduce((value, group) => (value << 16n) | BigInt(parseInt(group, 16)), 0n);
    }

    // Whether a plain address lies in a parsed entry's range, worked out bit by bit.
    function inEntry(address, parsed) {
        const bits = net.isIPv6(address) ? 128n : 32n;
        if ((bits === 128n) !== (parsed.family === 'ipv6')) return false;
        const shift = bits - BigInt(parsed.prefix);
        return (toBigInt(address) >> shift) === (toBigInt(parsed.address) >> shift);
    }

    it('trust an address only when it lies in a listed range', async function() {
        await check(this, fc.property(list, fc.oneof(ipv4, ipv6), (text, address) => {
            const parsed = ip_ranges.parseAddressList(text);
            assert.deepStrictEqual(parsed.invalid, [], text);
            const expected = parsed.entries.some(listed => inEntry(address, listed));
            assert.strictEqual(ip_ranges.addressInList(parsed, address), expected, `${address} against ${text}`);
        }));
    });

    it('trust an IPv4 address the same however a dual-stack socket writes it', async function() {
        await check(this, fc.property(list, ipv4, fc.constantFrom('::ffff:', '::FFFF:'), (text, address, mapped) => {
            const parsed = ip_ranges.parseAddressList(text);
            assert.strictEqual(ip_ranges.addressInList(parsed, `${mapped}${address}`), ip_ranges.addressInList(parsed, address), `${mapped}${address} against ${text}`);
        }));
    });

    it('accept as an entry only an address with a prefix its family allows', async function() {
        const text = fc.array(fc.oneof(entry, fc.string({unit: fc.constantFrom(...'0123456789abcdef.:/% ,-'), maxLength: 12})), {maxLength: 5})
            .map(items => items.join(','));
        await check(this, fc.property(text, (value) => {
            const parsed = ip_ranges.parseAddressList(value);
            for (const listed of parsed.entries) {
                assert(net.isIP(listed.address), `${JSON.stringify(listed)} from ${value}`);
                assert(Number.isInteger(listed.prefix) && listed.prefix >= 0 && listed.prefix <= (listed.family === 'ipv6' ? 128 : 32), JSON.stringify(listed));
            }
            const items = value.split(',').map(item => item.trim()).filter(Boolean);
            assert.strictEqual(parsed.entries.length + parsed.invalid.length, items.length, value);
        }));
    });
});
