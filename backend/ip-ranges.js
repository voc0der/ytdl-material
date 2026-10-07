const net = require('net');

/*************************************************
 * Lists of IP addresses and CIDR ranges, for the
 * settings that name a reverse proxy: the
 * whitelist of peers allowed to connect at all,
 * and the proxies whose sign-in header is
 * believed.
 *
 * The whitelist used to be checked by a matcher
 * that read every address as four dotted numbers.
 * An IPv6 address is not that, so it was read as
 * whatever digits it happened to start with, and
 * an IPv6 entry such as fd00::/8 let in
 * 2001:db8::99. net.BlockList knows both families.
 ************************************************/

// How a dual-stack socket reports an IPv4 peer.
const IPV4_MAPPED_PATTERN = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i;

/*************************************************
 * The address in the form it is listed in, or null
 * when it is not an IP address. An IPv4 peer on a
 * dual-stack socket arrives as ::ffff:a.b.c.d and
 * is matched as a.b.c.d, which is how anybody
 * would write it in a list.
 ************************************************/
function normalizeAddress(address) {
    if (typeof address !== 'string') return null;
    const trimmed = address.trim();
    const mapped = IPV4_MAPPED_PATTERN.exec(trimmed);
    const normalized = mapped ? mapped[1] : trimmed;
    return net.isIP(normalized) ? normalized : null;
}

function familyOf(address) {
    return net.isIPv6(address) ? 'ipv6' : 'ipv4';
}

/*************************************************
 * One entry: an address, or an address and a
 * prefix length. Anything else -- a host name, a
 * range written with a dash, a prefix longer than
 * the family allows -- is not an entry.
 ************************************************/
function parseEntry(entry) {
    const [raw_address, raw_prefix, ...rest] = entry.split('/');
    if (rest.length > 0) return null;

    const address = normalizeAddress(raw_address);
    if (!address) return null;

    const family = familyOf(address);
    const max_prefix = family === 'ipv6' ? 128 : 32;
    if (raw_prefix === undefined) return {text: entry, address, family, prefix: max_prefix};

    if (!/^\d{1,3}$/.test(raw_prefix)) return null;
    const prefix = Number(raw_prefix);
    if (prefix > max_prefix) return null;
    return {text: entry, address, family, prefix};
}

/*************************************************
 * Parses a comma-separated list. Entries that are
 * not addresses or ranges come back separately
 * rather than being dropped, so the caller decides
 * whether one is worth a warning or a refusal to
 * start.
 ************************************************/
function parseAddressList(value) {
    const block_list = new net.BlockList();
    const entries = [];
    const invalid = [];

    const raw_entries = typeof value === 'string' ? value.split(',') : [];
    for (const raw_entry of raw_entries) {
        const entry = raw_entry.trim();
        if (!entry) continue;

        const parsed = parseEntry(entry);
        if (!parsed) {
            invalid.push(entry);
            continue;
        }
        block_list.addSubnet(parsed.address, parsed.prefix, parsed.family);
        entries.push(parsed);
    }

    return {block_list, entries, invalid};
}

function addressInList(address_list, address) {
    const normalized = normalizeAddress(address);
    if (!normalized || !address_list) return false;
    return address_list.block_list.check(normalized, familyOf(normalized));
}

module.exports = {
    normalizeAddress,
    parseAddressList,
    addressInList
};
