const config_api = require('../config');
const CONSTS = require('../consts');
const logger = require('../logger');
const db_api = require('../db');

const jwt = require('jsonwebtoken');
const { v4: uuid } = require('uuid');
const bcrypt = require('bcryptjs');
const fs = require('fs-extra');
const path = require('path');

var LocalStrategy = require('passport-local').Strategy;
var LdapStrategy = require('./ldap');
var JwtStrategy = require('passport-jwt').Strategy,
    ExtractJwt = require('passport-jwt').ExtractJwt;

// other required vars
let SERVER_SECRET = null;
let JWT_EXPIRATION = null;
let opts = null;
let saltRounds = 10;

const SAFE_UID_PATTERN = /^[A-Za-z0-9._@-]+$/;
// Path separators and the null byte -- the characters that let a uid escape the folder
// it is supposed to name, rather than merely look unusual.
const PATH_UNSAFE_PATTERN = /[/\\\0]/;

exports.initialize = function () {
  /*************************
   * Authentication module
   ************************/

  if (db_api.database_initialized) {
    setupRoles();
  } else {
      db_api.database_initialized_bs.subscribe(init => {
          if (init) setupRoles();
      });
  }

  // Sometimes this value is not properly typed: https://github.com/voc0der/ytdl-material/issues/813
  JWT_EXPIRATION = config_api.getConfigItem('ytdl_jwt_expiration');
  if (!(+JWT_EXPIRATION)) {
    logger.warn(`JWT expiration value improperly set to ${JWT_EXPIRATION}, auto setting to 1 day.`);
    JWT_EXPIRATION = 86400;
  } else {
    JWT_EXPIRATION = +JWT_EXPIRATION;
  }

  SERVER_SECRET = null;
  if (db_api.users_db.get('jwt_secret').value()) {
    SERVER_SECRET = db_api.users_db.get('jwt_secret').value();
  } else {
    SERVER_SECRET = uuid();
    db_api.users_db.set('jwt_secret', SERVER_SECRET).write();
  }

  opts = {}
  opts.jwtFromRequest = ExtractJwt.fromUrlQueryParameter('jwt');
  opts.secretOrKey = SERVER_SECRET;

  exports.passport.use(new JwtStrategy(opts, async function(jwt_payload, done) {
    const user = await db_api.getRecord('users', {uid: jwt_payload.user});
    if (user) {
        return done(null, user);
    } else {
        return done(null, false);
        // or you could create a new account
    }
  }));
}

const setupRoles = async () => {
  const required_roles = {
    admin: {
        permissions: CONSTS.AVAILABLE_PERMISSIONS
    },
    user: {
        permissions: [
            'filemanager',
            'subscriptions',
            'sharing'
        ]
    }
  }

  const role_keys = Object.keys(required_roles);
  for (let i = 0; i < role_keys.length; i++) {
    const role_key = role_keys[i];
    const role_in_db = await db_api.getRecord('roles', {key: role_key});
    if (!role_in_db) {
      // insert task metadata into table if missing
      await db_api.insertRecordIntoTable('roles', {
          key: role_key,
          permissions: required_roles[role_key]['permissions']
      });
    }
  }
}

exports.passport = require('passport');

exports.passport.serializeUser(function(user, done) {
    done(null, user);
});

exports.passport.deserializeUser(function(user, done) {
    done(null, user);
});

/***************************************
 * Register user with hashed password
 **************************************/

exports.registerUser = async (userid, username, plaintextPassword) => {
  // Every caller funnels through here, and a uid becomes a directory name further down
  // (the per-user media folder), so this is the place to refuse one that can traverse.
  if (!exports.uidIsPathSafe(userid)) {
    logger.error(`Registration failed: the uid ${JSON.stringify(userid)} is unusable. `
      + `A uid must be a non-empty string, and cannot be '.', '..', or contain a path separator.`);
    return null;
  }

  const hash = await bcrypt.hash(plaintextPassword, saltRounds);
  const new_user = generateUserObject(userid, username, hash);
  // check if user exists
  if (await db_api.getRecord('users', {uid: userid})) {
    // user id is taken!
    logger.error('Registration failed: UID is already taken!');
    return null;
  } else if (await db_api.getRecord('users', {name: username})) {
      // user name is taken!
      logger.error('Registration failed: User name is already taken!');
      return null;
  } else {
    // add to db
    await db_api.insertRecordIntoTable('users', new_user);
    logger.verbose(`New user created: ${new_user.name}`);
    return new_user;
  }
}

function parseClaimPath(claims, claimPath) {
  if (!claims || !claimPath || typeof claimPath !== 'string') return undefined;
  const pathParts = claimPath.split('.').filter(part => part !== '');
  if (pathParts.length === 0) return undefined;

  let currentValue = claims;
  for (const part of pathParts) {
    if (!currentValue || typeof currentValue !== 'object' || !(part in currentValue)) {
      return undefined;
    }
    currentValue = currentValue[part];
  }
  return currentValue;
}

function claimToArray(value) {
  if (value === undefined || value === null) return [];
  if (Array.isArray(value)) return value.map(v => String(v).trim()).filter(v => v.length > 0);
  if (typeof value === 'string' && value.includes(',')) {
    return value.split(',').map(v => v.trim()).filter(v => v.length > 0);
  }
  const normalized = String(value).trim();
  return normalized ? [normalized] : [];
}

function valueIncludes(expectedValue, sourceValue) {
  if (!expectedValue || expectedValue.length === 0) return false;
  const expected = String(expectedValue).trim().toLowerCase();
  if (!expected) return false;
  return claimToArray(sourceValue).some(entry => entry.toLowerCase() === expected);
}

function claimValueToString(value) {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return '';
}

exports.sanitizeUserUID = (rawUID) => {
  const input = claimValueToString(rawUID);
  if (!input) return null;
  if (input === '.' || input === '..') return null;
  if (!SAFE_UID_PATTERN.test(input)) return null;
  return input;
}

/*************************************************
 * The uid ends up as a path component in a dozen
 * places (db.js, downloader.js, utils.js,
 * twitch.js), so it must not be able to steer a
 * path.join() out of the folder it names.
 *
 * Deliberately narrower than sanitizeUserUID: an
 * LDAP directory was never held to SAFE_UID_PATTERN,
 * and installs exist whose uids contain punctuation
 * it refuses. Those keep working; only uids that
 * can traverse are turned away.
 ************************************************/
exports.uidIsPathSafe = (rawUID) => {
  if (typeof rawUID !== 'string' || !rawUID.trim()) return false;
  if (rawUID === '.' || rawUID === '..') return false;
  return !PATH_UNSAFE_PATTERN.test(rawUID);
}

function getOIDCIdentityFromClaims(claims, usernameClaim) {
  const fallbackClaims = [usernameClaim, 'preferred_username', 'username', 'email', 'sub'];
  for (const claimName of fallbackClaims) {
    if (!claimName) continue;
    const claimValue = parseClaimPath(claims, claimName);
    const parsed = claimValueToString(claimValue);
    if (parsed) return parsed;
  }
  return null;
}

/*************************************************
 * Resolves the caller without rejecting them.
 *
 * optionalJwt answers "you may not proceed", which
 * is wrong for the handful of routes that have to
 * serve anonymous callers a smaller answer rather
 * than refuse them. This answers "is anyone
 * identifiable here" and leaves the consequences to
 * the caller.
 ************************************************/
exports.getUserFromJWT = async function(token) {
  if (!token || typeof token !== 'string' || !SERVER_SECRET) return null;
  try {
    const payload = jwt.verify(token, SERVER_SECRET);
    if (!payload || !payload.user) return null;
    return await db_api.getRecord('users', {uid: payload.user});
  } catch {
    return null;
  }
}

exports.createJWTForUser = function(user_uid) {
  const payload = {
      exp: Math.floor(Date.now() / 1000) + JWT_EXPIRATION,
      user: user_uid
  };
  return jwt.sign(payload, SERVER_SECRET);
}

/*************************************************
 * User records carry the bcrypt hash, and they are
 * handed out by the login response and by the user
 * management endpoints. Nothing outside this module
 * needs the hash, so it is stripped on the way out
 * rather than trusted not to be looked at.
 ************************************************/
const SENSITIVE_USER_FIELDS = ['passhash'];

exports.sanitizeUserForResponse = function(user) {
  if (!user || typeof user !== 'object') return user;
  const safe_user = {...user};
  for (const field of SENSITIVE_USER_FIELDS) delete safe_user[field];
  return safe_user;
}

exports.sanitizeUsersForResponse = function(users) {
  return Array.isArray(users) ? users.map(exports.sanitizeUserForResponse) : users;
}

exports.getAuthResponseObject = async function(user) {
  const token = exports.createJWTForUser(user.uid);
  return {
    user: exports.sanitizeUserForResponse(user),
    token: token,
    permissions: await exports.userPermissions(user.uid),
    available_permissions: CONSTS.AVAILABLE_PERMISSIONS
  };
}

exports.upsertOIDCUser = async (claims, options = {}) => {
  const username_claim = options.username_claim || 'preferred_username';
  const display_name_claim = options.display_name_claim || username_claim;
  const groups_claim = options.groups_claim || 'groups';
  const admin_claim = options.admin_claim || 'groups';
  const admin_value = options.admin_value || 'admin';
  const auto_register = options.auto_register !== false;

  const oidc_subject = claimValueToString(parseClaimPath(claims, 'sub'));
  const login_name = getOIDCIdentityFromClaims(claims, username_claim);
  const display_name = claimValueToString(parseClaimPath(claims, display_name_claim)) || login_name;
  const uid_to_use = exports.sanitizeUserUID(login_name);

  if (!uid_to_use || !display_name) {
    logger.error('OIDC login rejected: Could not derive a valid uid/name from OIDC claims.');
    return null;
  }

  const groups = claimToArray(parseClaimPath(claims, groups_claim));
  const admin_claim_value = parseClaimPath(claims, admin_claim);
  const role = valueIncludes(admin_value, admin_claim_value) ? 'admin' : 'user';

  let user_obj = null;
  if (oidc_subject) {
    user_obj = await db_api.getRecord('users', {oidc_subject: oidc_subject});
  }
  if (!user_obj) {
    user_obj = await db_api.getRecord('users', {uid: uid_to_use});
  }
  if (!user_obj) {
    user_obj = await db_api.getRecord('users', {name: display_name});
  }

  if (!user_obj) {
    if (!auto_register) {
      logger.error(`OIDC login rejected: user '${uid_to_use}' does not exist and auto registration is disabled.`);
      return null;
    }
    user_obj = generateUserObject(uid_to_use, display_name, null, 'oidc');
    user_obj.role = role;
    user_obj.oidc_subject = oidc_subject || null;
    user_obj.oidc_groups = groups;
    const inserted = await db_api.insertRecordIntoTable('users', user_obj);
    if (!inserted) {
      logger.error(`OIDC login failed: could not create user '${uid_to_use}'.`);
      return null;
    }
    return await db_api.getRecord('users', {uid: uid_to_use});
  }

  if (oidc_subject && user_obj.oidc_subject && user_obj.oidc_subject !== oidc_subject) {
    logger.error(`OIDC login rejected: existing user '${user_obj.uid}' is mapped to a different subject.`);
    return null;
  }

  const updated_user_values = {
    name: display_name,
    role: role,
    auth_method: 'oidc',
    oidc_groups: groups
  };
  if (oidc_subject) updated_user_values['oidc_subject'] = oidc_subject;

  const updated = await db_api.updateRecord('users', {uid: user_obj.uid}, updated_user_values);
  if (!updated) {
    logger.error(`OIDC login failed: could not update user '${user_obj.uid}'.`);
    return null;
  }
  return await db_api.getRecord('users', {uid: user_obj.uid});
}

exports.deleteUser = async (uid) => {
  let success = false;
  let usersFileFolder = config_api.getConfigItem('ytdl_users_base_path');
  const usersBaseFolder = path.join(__dirname, usersFileFolder);
  const user_folder = path.join(usersBaseFolder, uid);
  const relativeUserFolder = path.relative(usersBaseFolder, user_folder);
  if (relativeUserFolder.startsWith('..') || path.isAbsolute(relativeUserFolder)) {
      logger.error(`Refusing to delete user folder with unsafe uid path: ${uid}`);
      return false;
  }
  const user_db_obj = await db_api.getRecord('users', {uid: uid});
  if (user_db_obj) {
      // user exists, let's delete
      await fs.remove(user_folder);
      await db_api.removeRecord('users', {uid: uid});
      success = true;
  } else {
      logger.error(`Could not find user with uid ${uid}`);
  }
  return success;
}

/***************************************
 * Login methods
 **************************************/

/*************************************************
 * This gets called when passport.authenticate()
 * gets called.
 *
 * This checks that the credentials are valid.
 * If so, passes the user info to the next middleware.
 ************************************************/


exports.login = async (username, password) => {
  // even if we're using LDAP, we still want users to be able to login using internal credentials
  const user = await db_api.getRecord('users', {name: username});
  if (!user) {
    if (config_api.getConfigItem('ytdl_auth_method') === 'internal') logger.error(`User ${username} not found`);
    return false;
  }
  if (user.auth_method && user.auth_method !== 'internal') { return false }
  return await bcrypt.compare(password, user.passhash) ? user : false;
}

exports.passport.use(new LocalStrategy({
    usernameField: 'username',
    passwordField: 'password'},
    async function(username, password, done) {
      return done(null, await exports.login(username, password));
    }
));

var getLDAPConfiguration = function(req, callback) {
  const ldap_config = config_api.getConfigItem('ytdl_ldap_config');
  const opts = {server: ldap_config};
  callback(null, opts);
};

exports.passport.use(new LdapStrategy(getLDAPConfiguration,
  async function(user, done) {
    // check if ldap auth is enabled
    const ldap_enabled = config_api.getConfigItem('ytdl_auth_method') === 'ldap';
    if (!ldap_enabled) return done(null, false);

    const user_uid = user.uid;
    if (!exports.uidIsPathSafe(user_uid)) {
      logger.error(`LDAP login rejected: the directory returned an unusable uid (${JSON.stringify(user_uid)}). `
        + `A uid must be a non-empty string, and cannot be '.', '..', or contain a path separator.`);
      return done(null, false);
    }

    let db_user = await db_api.getRecord('users', {uid: user_uid});
    if (!db_user) {
      // generate DB user
      let new_user = generateUserObject(user_uid, user_uid, null, 'ldap');
      await db_api.insertRecordIntoTable('users', new_user);
      db_user = new_user;
      logger.verbose(`Generated new user ${user_uid} using LDAP`);
    }
    return done(null, db_user);
  }
));


/**********************************
 * Generating/Signing a JWT token
 * And attaches the user info into
 * the payload to be sent on every
 * request.
 *********************************/
exports.generateJWT = function(req, res, next) {
  req.token = exports.createJWTForUser(req.user.uid);
  next();
}

exports.returnAuthResponse = async function(req, res) {
  const auth_response = await exports.getAuthResponseObject(req.user);
  auth_response.token = req.token;
  res.status(200).json(auth_response);
}

/***************************************
 * Authorization: middleware that checks the
 * JWT token for validity before allowing
 * the user to access anything.
 *
 * It also passes the user object to the next
 * middleware through res.locals
 **************************************/
exports.ensureAuthenticatedElseError = (req, res, next) => {
  var token = getToken(req.query);
  if( token ) {
    try {
      var payload = jwt.verify(token, SERVER_SECRET);
      // console.log('payload: ' + JSON.stringify(payload));
      // check if user still exists in database if you'd like
      res.locals.user = payload.user;
      next();
    } catch(err) {
      res.status(401).send('Invalid Authentication');
    }
  } else {
    res.status(401).send('Missing Authorization header');
  }
}

/*************************************************
 * Confirms a password against the stored hash for
 * one account. Used to make a password change prove
 * the caller knows the password it is replacing --
 * a live session is not on its own enough, since
 * an unattended browser is one too.
 ************************************************/
exports.verifyUserPassword = async (user_uid, password) => {
  if (typeof password !== 'string' || password === '') return false;
  const user = await db_api.getRecord('users', {uid: user_uid});
  if (!user || !user.passhash) return false;
  return await bcrypt.compare(password, user.passhash);
}

// change password
exports.changeUserPassword = async (user_uid, new_pass) => {
  try {
    const hash = await bcrypt.hash(new_pass, saltRounds);
    await db_api.updateRecord('users', {uid: user_uid}, {passhash: hash});
    return true;
  } catch (err) {
    return false;
  }
}

// change user permissions
exports.changeUserPermissions = async (user_uid, permission, new_value) => {
  try {
    await db_api.pullFromRecordsArray('users', {uid: user_uid}, 'permissions', permission);
    await db_api.pullFromRecordsArray('users', {uid: user_uid}, 'permission_overrides', permission);
    if (new_value === 'yes') {
      await db_api.pushToRecordsArray('users', {uid: user_uid}, 'permissions', permission);
      await db_api.pushToRecordsArray('users', {uid: user_uid}, 'permission_overrides', permission);
    } else if (new_value === 'no') {
      await db_api.pushToRecordsArray('users', {uid: user_uid}, 'permission_overrides', permission);
    }
    return true;
  } catch (err) {
    logger.error(err);
    return false;
  }
}

// change role permissions
exports.changeRolePermissions = async (role, permission, new_value) => {
  try {
    await db_api.pullFromRecordsArray('roles', {key: role}, 'permissions', permission);
    if (new_value === 'yes') {
      await db_api.pushToRecordsArray('roles', {key: role}, 'permissions', permission);
    }
    return true;
  } catch (err) {
    logger.error(err);
    return false;
  }
}

exports.adminExists = async function() {
  return !!(await db_api.getRecord('users', {uid: 'admin'}));
}

// video stuff

exports.getUserVideos = async function(user_uid, type) {
    const files = await db_api.getRecords('files', {user_uid: user_uid});
    return type ? files.filter(file => file.isAudio === (type === 'audio')) : files;
}

exports.getUserVideo = async function(user_uid, file_uid, requireSharing = false) {
  const filter_obj = {uid: file_uid};
  if (config_api.getConfigItem('ytdl_multi_user_mode') && user_uid !== null && user_uid !== undefined) {
    filter_obj['user_uid'] = user_uid;
  }
  let file = await db_api.getRecord('files', filter_obj);

  // prevent unauthorized users from accessing the file info
  if (file && !file['sharingEnabled'] && requireSharing) file = null;

  return file;
}

exports.removePlaylist = async function(user_uid, playlistID) {
  await db_api.removeRecord('playlist', {playlistID: playlistID});
  return true;
}

exports.getUserPlaylists = async function(user_uid) {
  return await db_api.getRecords('playlists', {user_uid: user_uid});
}

exports.getUserPlaylist = async function(user_uid, playlistID, requireSharing = false) {
  const filter_obj = {id: playlistID};
  if (config_api.getConfigItem('ytdl_multi_user_mode') && user_uid !== null && user_uid !== undefined) {
    filter_obj['user_uid'] = user_uid;
  }
  let playlist = await db_api.getRecord('playlists', filter_obj);

  // prevent unauthorized users from accessing the file info
  if (requireSharing && (!playlist || !playlist['sharingEnabled'])) playlist = null;

  return playlist;
}

/*************************************************
 * The caller's uid was taken as an argument and
 * then ignored: sharing was toggled by object id
 * alone, so anybody holding the sharing permission
 * could expose -- or hide -- another user's media
 * as soon as they learned its uid.
 *
 * Ownership is checked before the write rather than
 * folded into the update filter, because
 * updateRecord reports success even when its filter
 * matched nothing.
 ************************************************/
exports.changeSharingMode = async function(user_uid, file_uid, is_playlist, enabled) {
  const table = is_playlist ? 'playlists' : 'files';
  const filter_obj = is_playlist ? {id: file_uid} : {uid: file_uid};

  if (config_api.getConfigItem('ytdl_multi_user_mode') && user_uid) {
    const record = await db_api.getRecord(table, filter_obj);
    if (!record || record['user_uid'] !== user_uid) {
      logger.error(`Refusing to change sharing on ${file_uid}: it does not belong to ${user_uid}.`);
      return false;
    }
  }

  await db_api.updateRecord(table, filter_obj, {sharingEnabled: enabled});
  return true;
}

/*************************************************
 * One resolver, used by both callers below.
 *
 * They used to implement this separately and had
 * already drifted: the list version fell through
 * after a positive override and could report the
 * same permission twice, while the single-check
 * version returned early and did not.
 *
 * An override, positive or negative, is the final
 * word; otherwise the role decides.
 ************************************************/
function resolvePermission(user_obj, role_permissions, permission) {
  const explicit_permissions = Array.isArray(user_obj['permissions']) ? user_obj['permissions'] : [];
  const overrides = Array.isArray(user_obj['permission_overrides']) ? user_obj['permission_overrides'] : [];

  if (overrides.includes(permission)) return explicit_permissions.includes(permission);

  return role_permissions.includes(permission);
}

/*************************************************
 * Returns the role's permissions, or null when the
 * role cannot be resolved at all.
 *
 * null and [] are deliberately different answers. A
 * role that exists and grants nothing still leaves
 * a user-level override meaningful. A role that is
 * missing means the user's authorization state is
 * unknown, and an override must not be allowed to
 * stand in for it -- otherwise deleting a role
 * leaves its members holding whatever was
 * overridden onto them.
 *
 * Either way it does not throw: dereferencing the
 * missing record used to turn a misconfigured role
 * into a 500 on every request the user made.
 ************************************************/
async function getRolePermissions(role) {
  if (!role) {
    logger.error('Cannot resolve permissions: user has no role.');
    return null;
  }
  const role_obj = await db_api.getRecord('roles', {key: role});
  if (!role_obj) {
    logger.error(`Role ${role} does not exist!`);
    return null;
  }
  return Array.isArray(role_obj['permissions']) ? role_obj['permissions'] : [];
}

exports.userHasPermission = async function(user_uid, permission) {
  const user_obj = await db_api.getRecord('users', {uid: user_uid});
  if (!user_obj) {
    logger.error(`Cannot resolve permissions: user ${user_uid} does not exist.`);
    return false;
  }

  const role_permissions = await getRolePermissions(user_obj['role']);
  if (role_permissions === null) {
    logger.error(`Refusing every permission for ${user_uid}: their role could not be resolved.`);
    return false;
  }

  const has_permission = resolvePermission(user_obj, role_permissions, permission);

  if (!has_permission) logger.verbose(`User ${user_uid} failed to get permission ${permission}`);
  return has_permission;
}

exports.roleHasPermissions = async function(role, permission) {
  const role_permissions = await getRolePermissions(role);
  if (role_permissions === null) return false;
  return role_permissions.includes(permission);
}

exports.userPermissions = async function(user_uid) {
  const user_obj = await db_api.getRecord('users', {uid: user_uid});
  if (!user_obj) {
    logger.error(`Cannot resolve permissions: user ${user_uid} does not exist.`);
    return [];
  }

  const role_permissions = await getRolePermissions(user_obj['role']);
  if (role_permissions === null) {
    logger.error(`Refusing every permission for ${user_uid}: their role could not be resolved.`);
    return [];
  }

  return CONSTS.AVAILABLE_PERMISSIONS.filter(permission => resolvePermission(user_obj, role_permissions, permission));
}

function getToken(queryParams) {
  if (queryParams && queryParams.jwt) {
    var parted = queryParams.jwt.split(' ');
    if (parted.length === 2) {
      return parted[1];
    } else {
      return null;
    }
  } else {
    return null;
  }
};

function generateUserObject(userid, username, hash, auth_method = 'internal') {
  let new_user = {
    name: username,
    uid: userid,
    passhash: auth_method === 'internal' ? hash : null,
    files: [],
    playlists: [],
    subscriptions: [],
    created: Date.now(),
    role: userid === 'admin' && auth_method === 'internal' ? 'admin' : 'user',
    permissions: [],
    permission_overrides: [],
    auth_method: auth_method
  };
  return new_user;
}
