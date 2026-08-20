const passport = require('passport');
const { Client, Filter, InvalidCredentialsError } = require('ldapts');

const logger = require('../logger');

const DEFAULT_SEARCH_SCOPE = 'sub';
const DEFAULT_BIND_PROPERTY = 'dn';
const USERNAME_FIELD = 'username';
const PASSWORD_FIELD = 'password';

// Options ldapauth-fork accepted that this strategy does not implement. Only reachable by
// hand-editing ldap_config -- the settings UI exposes url, bindDN, bindCredentials,
// searchBase and searchFilter and nothing else -- but warn rather than ignore in silence,
// so an operator who did set one finds out instead of wondering why it stopped mattering.
//
// The group options are the notable absence, and dropping them changes nothing here: the
// verify callback only ever read `uid`, so the groups ldapauth-fork attached to the user
// were fetched and then discarded on every single login.
const UNSUPPORTED_OPTIONS = [
    'groupSearchBase',
    'groupSearchFilter',
    'groupSearchAttributes',
    'groupDnProperty',
    'includeRaw',
    'cache',
    'reconnect'
];

function asString(value) {
    return typeof value === 'string' && value.trim() ? value : null;
}

function lookupCredential(source, field) {
    if (!source || typeof source !== 'object') return null;
    const value = source[field];
    return typeof value === 'string' ? value : null;
}

/*************************************************
 * ldapauth-fork accepted adminDn/adminPassword as
 * aliases for bindDN/bindCredentials. The settings
 * UI has only ever written the latter, but a config
 * edited by hand may use either.
 ************************************************/
function readConfig(raw) {
    const config = raw && typeof raw === 'object' ? raw : {};

    for (const option of UNSUPPORTED_OPTIONS) {
        if (config[option] === undefined) continue;
        logger.warn(`LDAP option '${option}' is set but is no longer supported, and is being ignored. `
            + `If you depend on it, please open an issue describing what it is doing for you.`);
    }

    return {
        url: asString(config.url),
        bind_dn: asString(config.bindDN) || asString(config.adminDn),
        bind_credentials: typeof config.bindCredentials === 'string' ? config.bindCredentials
            : (typeof config.adminPassword === 'string' ? config.adminPassword : null),
        search_base: asString(config.searchBase),
        search_filter: asString(config.searchFilter),
        search_scope: asString(config.searchScope) || DEFAULT_SEARCH_SCOPE,
        search_attributes: Array.isArray(config.searchAttributes) ? config.searchAttributes : null,
        bind_property: asString(config.bindProperty) || DEFAULT_BIND_PROPERTY,
        starttls: config.starttls === true,
        tls_options: config.tlsOptions && typeof config.tlsOptions === 'object' ? config.tlsOptions : undefined,
        timeout: Number.isFinite(config.timeout) ? config.timeout : undefined,
        connect_timeout: Number.isFinite(config.connectTimeout) ? config.connectTimeout : undefined,
        strict_dn: typeof config.strictDN === 'boolean' ? config.strictDN : undefined
    };
}

function missingRequiredOptions(config) {
    return ['url', 'search_base', 'search_filter']
        .filter(key => !config[key])
        .map(key => ({url: 'url', search_base: 'searchBase', search_filter: 'searchFilter'})[key]);
}

/*************************************************
 * The filter is operator-supplied and the username
 * is not, so the username is escaped per RFC 4515
 * before it is substituted in. ldapts' own escaping
 * is used rather than a hand-rolled one -- getting
 * this wrong is an LDAP injection.
 ************************************************/
function buildSearchFilter(search_filter, username) {
    return search_filter.replace(/{{username}}/g, Filter.escape(username));
}

function stripSensitiveAttributes(entry) {
    // The service account can usually read userPassword, so it comes back in the search
    // result. Nothing downstream wants it, and it has no business being handed to a
    // verify callback that may log or persist what it is given.
    const {userPassword, ...safe} = entry; // eslint-disable-line no-unused-vars
    return safe;
}

async function closeQuietly(client) {
    if (!client) return;
    try {
        await client.unbind();
    } catch (err) {
        // Unbinding a connection that is already gone is not worth surfacing; the
        // authentication result has been decided by this point either way.
        logger.debug(`Ignoring error while closing LDAP connection: ${err.message}`);
    }
}

/*************************************************
 * Bind as the service account, find the user, then
 * bind as the user to check their password. The
 * result is a discriminated outcome rather than a
 * throw, so the caller can map each case onto the
 * matching passport response.
 ************************************************/
async function findAndBindUser(config, username, password) {
    const missing = missingRequiredOptions(config);
    if (missing.length) {
        return {outcome: 'error', error: new Error(`LDAP is not configured: missing ${missing.join(', ')}.`)};
    }

    let client = null;
    try {
        client = new Client({
            url: config.url,
            ...(config.tls_options !== undefined && {tlsOptions: config.tls_options}),
            ...(config.timeout !== undefined && {timeout: config.timeout}),
            ...(config.connect_timeout !== undefined && {connectTimeout: config.connect_timeout}),
            ...(config.strict_dn !== undefined && {strictDN: config.strict_dn})
        });

        if (config.starttls) await client.startTLS(config.tls_options || {});

        if (config.bind_dn) {
            try {
                await client.bind(config.bind_dn, config.bind_credentials || '');
            } catch (err) {
                if (err instanceof InvalidCredentialsError) {
                    // Deliberately reported as a failed login rather than a server error,
                    // which is what the previous implementation did and what the frontend
                    // expects. The log line is the only thing that tells an operator their
                    // service account is wrong rather than the user's password, so it has
                    // to say so plainly.
                    logger.error(`LDAP service account bind failed for '${config.bind_dn}'. `
                        + `Check the bind DN and bind credentials in your LDAP settings -- `
                        + `until they are right, every login will be rejected.`);
                    return {outcome: 'fail', message: 'Invalid username/password', status: 401};
                }
                throw err;
            }
        }

        const filter = buildSearchFilter(config.search_filter, username);
        const {searchEntries} = await client.search(config.search_base, {
            scope: config.search_scope,
            filter: filter,
            ...(config.search_attributes && {attributes: config.search_attributes})
        });

        if (searchEntries.length === 0) {
            return {outcome: 'fail', message: 'Invalid username/password', status: 401};
        }
        if (searchEntries.length > 1) {
            // Binding as an arbitrary one of them would be authenticating a user we cannot
            // name, so refuse and make the ambiguity the operator's problem.
            logger.error(`LDAP search for '${username}' matched ${searchEntries.length} entries using filter `
                + `'${config.search_filter}'. Refusing the login: the filter must identify exactly one user.`);
            return {outcome: 'fail', message: 'Invalid username/password', status: 401};
        }

        const entry = searchEntries[0];
        const bind_target = entry[config.bind_property];
        if (typeof bind_target !== 'string' || !bind_target) {
            logger.error(`LDAP entry for '${username}' has no usable '${config.bind_property}' to bind with.`);
            return {outcome: 'fail', message: 'Invalid username/password', status: 401};
        }

        try {
            await client.bind(bind_target, password);
        } catch (err) {
            if (err instanceof InvalidCredentialsError) {
                return {outcome: 'fail', message: 'Invalid username/password', status: 401};
            }
            throw err;
        }

        return {outcome: 'success', user: stripSensitiveAttributes(entry)};
    } catch (err) {
        return {outcome: 'error', error: err};
    } finally {
        await closeQuietly(client);
    }
}

/*************************************************
 * Passport strategy over ldapts.
 *
 * Replaces passport-ldapauth, which reached ldapjs
 * through ldapauth-fork. Every published ldapjs
 * major is decommissioned, so there was no version
 * to move to -- see #371.
 *
 * getOptions is called per request, so a config
 * change takes effect on the next login rather than
 * on the next restart.
 ************************************************/
class LdapStrategy extends passport.Strategy {
    constructor(getOptions, verify) {
        super();
        this.name = 'ldap';
        this._getOptions = getOptions;
        this._verify = verify;
    }

    authenticate(req) {
        const username = lookupCredential(req.body, USERNAME_FIELD) || lookupCredential(req.query, USERNAME_FIELD);
        const password = lookupCredential(req.body, PASSWORD_FIELD) || lookupCredential(req.query, PASSWORD_FIELD);

        if (!username || !password) {
            return this.fail({message: 'Missing credentials'}, 400);
        }

        this._getOptions(req, (options_err, options) => {
            if (options_err) return this.error(options_err);

            const config = readConfig(options && options.server);
            findAndBindUser(config, username, password).then(result => {
                if (result.outcome === 'error') return this.error(result.error);
                if (result.outcome === 'fail') return this.fail({message: result.message}, result.status);

                this._verify(result.user, (verify_err, user, info) => {
                    if (verify_err) return this.error(verify_err);
                    if (!user) return this.fail(info);
                    return this.success(user, info);
                });
            }).catch(err => this.error(err));
        });
    }
}

module.exports = LdapStrategy;
module.exports.buildSearchFilter = buildSearchFilter;
module.exports.readConfig = readConfig;
