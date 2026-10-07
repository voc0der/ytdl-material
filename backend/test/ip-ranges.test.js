const assert = require('assert');

const { normalizeAddress, parseAddressList, addressInList } = require('../ip-ranges');

/*************************************************
 * The reverse proxy whitelist and the header
 * sign-in proxies both come down to this: is the
 * machine that opened the connection one of the
 * listed ones. A wrong yes is a way in.
 ************************************************/
describe('IP address lists', function() {
    const matches = (list, address) => addressInList(parseAddressList(list), address);

    describe('Reading a peer address', function() {
        it('reads an IPv4 peer on a dual-stack socket as plain IPv4', function() {
            assert.strictEqual(normalizeAddress('::ffff:172.18.0.5'), '172.18.0.5');
            assert.strictEqual(normalizeAddress('::FFFF:10.0.0.1'), '10.0.0.1');
        });

        it('keeps IPv4 and IPv6 addresses as they are', function() {
            assert.strictEqual(normalizeAddress('10.0.0.1'), '10.0.0.1');
            assert.strictEqual(normalizeAddress('fd00::1'), 'fd00::1');
            assert.strictEqual(normalizeAddress('::1'), '::1');
        });

        it('answers null for anything that is not an address', function() {
            for (const value of [undefined, null, '', 'localhost', '10.0.0', '10.0.0.1/8', 42]) {
                assert.strictEqual(normalizeAddress(value), null, JSON.stringify(value));
            }
        });
    });

    describe('IPv4', function() {
        it('matches a listed address and nothing next to it', function() {
            assert.strictEqual(matches('172.28.0.10', '172.28.0.10'), true);
            assert.strictEqual(matches('172.28.0.10', '172.28.0.11'), false);
        });

        it('matches every address inside a range and none outside it', function() {
            assert.strictEqual(matches('172.18.0.0/16', '172.18.200.7'), true);
            assert.strictEqual(matches('172.18.0.0/16', '172.19.0.1'), false);
            // The address in a range only has to be inside it, as the old matcher allowed.
            assert.strictEqual(matches('172.18.0.5/16', '172.18.9.9'), true);
        });

        it('matches an IPv4 peer reported in its dual-stack form', function() {
            assert.strictEqual(matches('127.0.0.1', '::ffff:127.0.0.1'), true);
        });

        it('checks every entry of a comma-separated list', function() {
            const list = ' 10.0.0.1 , 192.168.1.0/24,,';
            assert.strictEqual(matches(list, '10.0.0.1'), true);
            assert.strictEqual(matches(list, '192.168.1.77'), true);
            assert.strictEqual(matches(list, '192.168.2.1'), false);
        });
    });

    describe('IPv6', function() {
        it('matches a listed address and nothing next to it', function() {
            assert.strictEqual(matches('fd00::10', 'fd00::10'), true);
            assert.strictEqual(matches('fd00::10', 'fd00::11'), false);
        });

        it('keeps an IPv6 range to the addresses inside it', function() {
            // The old matcher read both as numbers made of their leading digits, so this
            // range let in an address it does not contain.
            assert.strictEqual(matches('fd00::/8', '2001:db8::99'), false);
            assert.strictEqual(matches('fd00::/8', 'fd12:3456::1'), true);
            assert.strictEqual(matches('fd00:1::/64', 'fd00:1::abcd'), true);
            assert.strictEqual(matches('fd00:1::/64', 'fd00:2::1'), false);
            assert.strictEqual(matches('fd00:1::/64', 'fe80::1'), false);
        });

        it('never lets one family stand in for the other', function() {
            assert.strictEqual(matches('127.0.0.1', '::1'), false);
            assert.strictEqual(matches('::1', '127.0.0.1'), false);
            assert.strictEqual(matches('fd00::/8', '10.0.0.1'), false);
        });
    });

    describe('Entries that are not addresses', function() {
        it('keeps them apart instead of matching on them', function() {
            const list = parseAddressList('10.0.0.1, proxy.example.com, 10.0.0.1-10.0.0.9, 10.0.0.0/33, ::1/129, 10.0.0.0/8/8, 10.0.0.0/x, 010.0.0.1');
            assert.deepStrictEqual(list.invalid, ['proxy.example.com', '10.0.0.1-10.0.0.9', '10.0.0.0/33', '::1/129', '10.0.0.0/8/8', '10.0.0.0/x', '010.0.0.1']);
            assert.deepStrictEqual(list.entries.map(entry => entry.text), ['10.0.0.1']);
            assert.strictEqual(addressInList(list, '10.0.0.1'), true);
            assert.strictEqual(addressInList(list, '10.0.0.5'), false);
        });

        it('treats an empty or missing list as matching nothing', function() {
            for (const value of ['', ' , ', undefined, null, ['10.0.0.1']]) {
                const list = parseAddressList(value);
                assert.deepStrictEqual(list.entries, []);
                assert.strictEqual(addressInList(list, '10.0.0.1'), false);
            }
        });

        it('refuses a peer address it cannot read', function() {
            assert.strictEqual(matches('10.0.0.0/8', undefined), false);
            assert.strictEqual(matches('10.0.0.0/8', 'not-an-address'), false);
        });
    });

    it('reports the prefix of every entry, so a range covering everything can be refused', function() {
        const list = parseAddressList('0.0.0.0/0, ::/0, 10.0.0.1, fd00::1');
        assert.deepStrictEqual(list.entries.map(entry => [entry.text, entry.family, entry.prefix]), [
            ['0.0.0.0/0', 'ipv4', 0], ['::/0', 'ipv6', 0], ['10.0.0.1', 'ipv4', 32], ['fd00::1', 'ipv6', 128]
        ]);
    });
});
