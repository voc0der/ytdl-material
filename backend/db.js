const fs = require('fs-extra')
const path = require('path')
const { MongoClient } = require("mongodb");
const _ = require('lodash');

const config_api = require('./config');
const utils = require('./utils')
const logger = require('./logger');
const postgres_store = require('./postgres-store');

const low = require('./lowdb-compat')
const FileSync = require('./lowdb-compat/adapters/FileSync');
const { BehaviorSubject } = require('rxjs');

let local_db = null;
let db = null;
let users_db = null;
let mongo_client = null;
let mongo_database = null;
let postgres_pool = null;
let remote_db_type = null;
exports.database_initialized = false;
exports.database_initialized_bs = new BehaviorSubject(false);

const DB_TYPES = Object.freeze({
    local: 'local',
    mongo: 'mongo',
    postgres: 'postgres'
});

const tables = {
    files: {
        name: 'files',
        primary_key: 'uid',
        field_types: {
            uid: 'text',
            registered: 'numeric',
            user_uid: 'text',
            sub_id: 'text',
            isAudio: 'boolean',
            duplicate_key: 'text',
            favorite: 'boolean',
            url: 'text',
            path: 'text',
            'category.uid': 'text'
        },
        text_search: {
            title: 'text',
            uploader: 'text',
            uid: 'text'
        },
        indexes: [
            { keys: { registered: -1 } },
            { keys: { user_uid: 1, registered: -1 } },
            { keys: { sub_id: 1, registered: -1 } },
            { keys: { isAudio: 1, registered: -1 } },
            { keys: { duplicate_key: 1, registered: 1 } },
            { keys: { user_uid: 1, duplicate_key: 1, registered: 1 } },
            { keys: { favorite: 1, registered: -1 } },
            { keys: { url: 1, sub_id: 1 } },
            { keys: { path: 1, sub_id: 1 } },
            { keys: { 'category.uid': 1 } }
        ]
    },
    playlists: {
        name: 'playlists',
        primary_key: 'id',
        field_types: {
            id: 'text',
            user_uid: 'text'
        },
        indexes: [
            { keys: { user_uid: 1 } }
        ]
    },
    categories: {
        name: 'categories',
        primary_key: 'uid',
        field_types: {
            uid: 'text'
        }
    },
    subscriptions: {
        name: 'subscriptions',
        primary_key: 'id',
        field_types: {
            id: 'text',
            user_uid: 'text',
            paused: 'boolean',
            streamingOnly: 'boolean',
            isPlaylist: 'boolean',
            name: 'text',
            url: 'text'
        },
        indexes: [
            { keys: { user_uid: 1 } },
            { keys: { paused: 1, streamingOnly: 1 } }
        ]
    },
    downloads: {
        name: 'downloads',
        field_types: {
            key: 'text'
        }
    },
    users: {
        name: 'users',
        primary_key: 'uid',
        field_types: {
            uid: 'text',
            name: 'text',
            oidc_subject: 'text'
        },
        indexes: [
            { keys: { name: 1 } },
            { keys: { oidc_subject: 1 } }
        ]
    },
    roles: {
        name: 'roles',
        primary_key: 'key',
        field_types: {
            key: 'text'
        }
    },
    download_queue: {
        name: 'download_queue',
        primary_key: 'uid',
        field_types: {
            uid: 'text',
            finished: 'boolean',
            paused: 'boolean',
            finished_step: 'boolean',
            timestamp_start: 'numeric',
            user_uid: 'text',
            sub_id: 'text',
            error: 'text',
            running: 'boolean',
            url: 'text'
        },
        indexes: [
            { keys: { finished: 1, paused: 1, finished_step: 1, timestamp_start: 1 } },
            { keys: { user_uid: 1, finished: 1, paused: 1 } },
            { keys: { sub_id: 1, error: 1, finished: 1 } },
            { keys: { sub_id: 1, url: 1, error: 1, finished: 1 } },
            { keys: { running: 1, sub_id: 1 } }
        ]
    },
    tasks: {
        name: 'tasks',
        primary_key: 'key',
        field_types: {
            key: 'text',
            'data.task_key': 'text'
        }
    },
    notifications: {
        name: 'notifications',
        primary_key: 'uid',
        field_types: {
            uid: 'text',
            user_uid: 'text',
            read: 'boolean',
            'data.task_key': 'text'
        },
        indexes: [
            { keys: { user_uid: 1 } }
        ]
    },
    archives: {
        name: 'archives',
        field_types: {
            extractor: 'text',
            id: 'text',
            type: 'text',
            sub_id: 'text',
            user_uid: 'text'
        },
        indexes: [
            { keys: { extractor: 1, id: 1, type: 1, sub_id: 1, user_uid: 1 } },
            { keys: { sub_id: 1, user_uid: 1, type: 1 } }
        ]
    },
    test: {
        name: 'test',
        field_types: {
            uid: 'text',
            key: 'text',
            test: 'text',
            added_field: 'boolean',
            test_remove: 'text',
            test_property: 'text'
        }
    }
}

const tables_list = Object.keys(tables);

let using_local_db = null; 

const BLOCKED_OBJECT_KEYS = new Set(['__proto__', 'prototype', 'constructor']);

function isPlainObject(value) {
    return Object.prototype.toString.call(value) === '[object Object]';
}

function validateMongoFieldPath(fieldPath) {
    if (typeof fieldPath !== 'string' || fieldPath.length === 0) {
        throw new Error('Mongo field path must be a non-empty string.');
    }

    const pathParts = fieldPath.split('.');
    for (const part of pathParts) {
        if (!part || part.startsWith('$') || BLOCKED_OBJECT_KEYS.has(part)) {
            throw new Error(`Unsafe Mongo field path '${fieldPath}'.`);
        }
    }
}

function sanitizeMongoLiteralValue(value) {
    if (value === null || value === undefined) return value;
    if (Array.isArray(value)) return value.map(sanitizeMongoLiteralValue);
    if (!isPlainObject(value)) return value;

    const sanitized = {};
    for (const key of Object.keys(value)) {
        if (key.includes('.') || key.startsWith('$') || BLOCKED_OBJECT_KEYS.has(key)) {
            throw new Error(`Unsafe nested object key '${key}'.`);
        }
        sanitized[key] = sanitizeMongoLiteralValue(value[key]);
    }
    return sanitized;
}

function sanitizeMongoLiteralFilter(filter_obj) {
    if (!isPlainObject(filter_obj)) {
        throw new Error('Mongo filter object must be a plain object.');
    }

    const sanitized = {};
    for (const key of Object.keys(filter_obj)) {
        validateMongoFieldPath(key);
        const value = filter_obj[key];
        if (isPlainObject(value)) {
            throw new Error(`Refusing non-literal Mongo filter value for '${key}'.`);
        }
        sanitized[key] = {$eq: sanitizeMongoLiteralValue(value)};
    }
    return sanitized;
}

function sanitizeMongoUpdateSetObject(update_obj) {
    if (!isPlainObject(update_obj)) {
        throw new Error('Mongo update object must be a plain object.');
    }

    const sanitized = {};
    for (const key of Object.keys(update_obj)) {
        if (key === '_id') continue;
        validateMongoFieldPath(key);
        sanitized[key] = sanitizeMongoLiteralValue(update_obj[key]);
    }
    return sanitized;
}

function isMongoWriteAck(result) {
    if (!result) return false;
    if (typeof result.acknowledged === 'boolean') return result.acknowledged;
    if (typeof result.ok === 'number') return result.ok === 1;
    if (result.result && typeof result.result.ok === 'number') return result.result.ok === 1;
    return true;
}

function normalizeDBType(value = null) {
    if (typeof value !== 'string') return null;
    const normalized = value.trim().toLowerCase();
    if (normalized === DB_TYPES.mongo || normalized === 'mongodb') return DB_TYPES.mongo;
    if (normalized === DB_TYPES.postgres || normalized === 'postgresql') return DB_TYPES.postgres;
    return null;
}

function inferDBTypeFromConnectionString(connectionString = '') {
    if (typeof connectionString !== 'string') return null;
    const normalized = connectionString.trim().toLowerCase();
    if (normalized.startsWith('mongodb://') || normalized.startsWith('mongodb+srv://')) return DB_TYPES.mongo;
    if (normalized.startsWith('postgres://') || normalized.startsWith('postgresql://')) return DB_TYPES.postgres;
    return null;
}

function getRemoteConnectionStringForType(dbType) {
    if (dbType === DB_TYPES.postgres) return config_api.getConfigItem('ytdl_postgresdb_connection_string');
    return config_api.getConfigItem('ytdl_mongodb_connection_string');
}

function getConfiguredRemoteDBType(options = {}) {
    const { preferMigrationTarget = false } = options;
    const configuredType = normalizeDBType(config_api.getConfigItem('ytdl_remote_db_type'));
    const migrationTarget = normalizeDBType(config_api.getConfigItem('ytdl_db_migrate'));
    const postgresConnectionString = config_api.getConfigItem('ytdl_postgresdb_connection_string');

    if (preferMigrationTarget && migrationTarget) return migrationTarget;
    if (configuredType) return configuredType;
    if (migrationTarget) return migrationTarget;
    if (typeof postgresConnectionString === 'string' && postgresConnectionString.trim().length > 0) return DB_TYPES.postgres;
    return DB_TYPES.mongo;
}

function getActiveDBType() {
    if (using_local_db) return DB_TYPES.local;
    return remote_db_type || getConfiguredRemoteDBType();
}

function getDBLabel(dbType) {
    if (dbType === DB_TYPES.postgres) return 'PostgreSQL';
    if (dbType === DB_TYPES.mongo) return 'MongoDB';
    return 'Local';
}

function setDB(input_db, input_users_db) {
    db = input_db; users_db = input_users_db;
    exports.db = input_db;
    exports.users_db = input_users_db
}

exports.initialize = (input_db, input_users_db, db_name = 'local_db.json') => {
    setDB(input_db, input_users_db);

    // must be done here to prevent getConfigItem from being called before init
    using_local_db = config_api.getConfigItem('ytdl_use_local_db');

    const local_adapter = new FileSync(`./appdata/${db_name}`);
    local_db = low(local_adapter);

    const local_db_defaults = {}
    tables_list.forEach(table => {local_db_defaults[table] = []});
    local_db.defaults(local_db_defaults).write();
}

async function closeRemoteConnections(options = {}) {
    const { keepType = null } = options;

    if (keepType !== DB_TYPES.mongo && mongo_client) {
        await mongo_client.close().catch(() => null);
        mongo_client = null;
        mongo_database = null;
    }

    if (keepType !== DB_TYPES.postgres && postgres_pool) {
        await postgres_store.closeConnection(postgres_pool).catch(() => null);
        postgres_pool = null;
    }

    if (!keepType) remote_db_type = null;
}

async function prepareMongoDatabase(database) {
    const existing_collections = (await database.listCollections({}, { nameOnly: true }).toArray()).map(collection => collection.name);
    const missing_tables = tables_list.filter(table => !(existing_collections.includes(table)));
    await Promise.all(missing_tables.map(table => database.createCollection(table)));

    for (const table of tables_list) {
        const table_collection = database.collection(table);

        const primary_key = tables[table]['primary_key'];
        if (primary_key) {
            await table_collection.createIndex({[primary_key]: 1}, { unique: true });
        }

        const text_search = tables[table]['text_search'];
        if (text_search) {
            await table_collection.createIndex(text_search);
        }

        const extra_indexes = tables[table]['indexes'] || [];
        for (const extra_index of extra_indexes) {
            if (!extra_index || !extra_index.keys) continue;
            await table_collection.createIndex(extra_index.keys, extra_index.options || {});
        }
    }
}

async function connectMongoDB(uri, options = {}) {
    const { testOnly = false } = options;
    const client = new MongoClient(uri);
    await client.connect();
    const database = client.db('ytdl_material');

    if (testOnly) {
        await client.close();
        return true;
    }

    await prepareMongoDatabase(database);

    await closeRemoteConnections({ keepType: DB_TYPES.mongo });
    mongo_client = client;
    mongo_database = database;
    remote_db_type = DB_TYPES.mongo;
    using_local_db = false;
    return true;
}

async function connectPostgresDB(connection_string, options = {}) {
    const { testOnly = false } = options;
    const pool = await postgres_store.createConnection(connection_string, tables, { testOnly: testOnly });
    if (testOnly) {
        await postgres_store.closeConnection(pool);
        return true;
    }

    await closeRemoteConnections({ keepType: DB_TYPES.postgres });
    postgres_pool = pool;
    remote_db_type = DB_TYPES.postgres;
    using_local_db = false;
    return true;
}

exports.connectToDB = async (retries = 5, no_fallback = false, custom_connection_string = null) => {
    const target_db_type = custom_connection_string
        ? inferDBTypeFromConnectionString(custom_connection_string)
        : getConfiguredRemoteDBType({ preferMigrationTarget: true });
    const success = await exports._connectToDB(custom_connection_string, target_db_type);
    if (success) return true;

    if (retries) {
        logger.warn(`${getDBLabel(target_db_type)} connection failed! Retrying ${retries} times...`);
        const retry_delay_ms = 2000;
        for (let i = 0; i < retries; i++) {
            const retry_succeeded = await exports._connectToDB(null, target_db_type);
            if (retry_succeeded) {
                logger.info(`Successfully connected to DB after ${i+1} attempt(s)`);
                return true;
            }

            if (i !== retries - 1) {
                logger.warn(`Retry ${i+1} failed, waiting ${retry_delay_ms}ms before trying again.`);
                await utils.wait(retry_delay_ms);
            } else {
                logger.warn(`Retry ${i+1} failed.`);
            }
        }
    }
    
    if (no_fallback) {
        logger.error(`Failed to connect to ${getDBLabel(target_db_type)}. Verify your connection string is valid.`);
        return false;
    }
    await closeRemoteConnections();
    using_local_db = true;
    config_api.setConfigItem('ytdl_use_local_db', true);
    logger.error(`Failed to connect to ${getDBLabel(target_db_type)}, using Local DB as a fallback. Make sure your remote database is accessible, or set Local DB as a default through the config.`);
    return true;
}

exports._connectToDB = async (custom_connection_string = null, custom_db_type = null) => {
    const db_type = custom_db_type
        || (custom_connection_string ? inferDBTypeFromConnectionString(custom_connection_string) : getConfiguredRemoteDBType({ preferMigrationTarget: true }));
    const connection_string = custom_connection_string || getRemoteConnectionStringForType(db_type);

    try {
        if (!db_type) {
            logger.error('Could not determine remote database type from configuration.');
            return false;
        }
        if (!connection_string || String(connection_string).trim().length === 0) {
            logger.error(`No ${getDBLabel(db_type)} connection string has been configured.`);
            return false;
        }

        if (db_type === DB_TYPES.postgres) {
            await connectPostgresDB(connection_string, { testOnly: !!custom_connection_string });
        } else {
            await connectMongoDB(connection_string, { testOnly: !!custom_connection_string });
        }
        return true;
    } catch(err) {
        logger.error(err);
        return false;
    }
}

exports.setVideoProperty = async (file_uid, assignment_obj) => {
    // TODO: check if video exists, throw error if not
    await exports.updateRecord('files', {uid: file_uid}, assignment_obj);
}

exports.getFileDirectoriesAndDBs = async () => {
    let dirs_to_check = [];
    let subscriptions_to_check = [];
    const subscriptions_base_path = config_api.getConfigItem('ytdl_subscriptions_base_path'); // only for single-user mode
    const multi_user_mode = config_api.getConfigItem('ytdl_multi_user_mode');
    const usersFileFolder = config_api.getConfigItem('ytdl_users_base_path');
    const subscriptions_enabled = config_api.getConfigItem('ytdl_allow_subscriptions');
    if (multi_user_mode) {
        const users = await exports.getRecords('users');
        for (let i = 0; i < users.length; i++) {
            const user = users[i];

            // add user's audio dir to check list
            dirs_to_check.push({
                basePath: path.join(usersFileFolder, user.uid, 'audio'),
                user_uid: user.uid,
                type: 'audio',
                archive_path: utils.getArchiveFolder('audio', user.uid)
            });

            // add user's video dir to check list
            dirs_to_check.push({
                basePath: path.join(usersFileFolder, user.uid, 'video'),
                user_uid: user.uid,
                type: 'video',
                archive_path: utils.getArchiveFolder('video', user.uid)
            });
        }
    } else {
        const audioFolderPath = config_api.getConfigItem('ytdl_audio_folder_path');
        const videoFolderPath = config_api.getConfigItem('ytdl_video_folder_path');

        // add audio dir to check list
        dirs_to_check.push({
            basePath: audioFolderPath,
            type: 'audio',
            archive_path: utils.getArchiveFolder('audio')
        });

        // add video dir to check list
        dirs_to_check.push({
            basePath: videoFolderPath,
            type: 'video',
            archive_path: utils.getArchiveFolder('video')
        });
    }

    if (subscriptions_enabled) {
        const subscriptions = await exports.getRecords('subscriptions');
        subscriptions_to_check = subscriptions_to_check.concat(subscriptions);
    }

    // add subscriptions to check list
    for (let i = 0; i < subscriptions_to_check.length; i++) {
        let subscription_to_check = subscriptions_to_check[i];
        if (!subscription_to_check.name) {
            // TODO: Remove subscription as it'll never complete
            continue;
        }
        dirs_to_check.push({
            basePath: subscription_to_check.user_uid ? path.join(usersFileFolder, subscription_to_check.user_uid, 'subscriptions', subscription_to_check.isPlaylist ? 'playlists/' : 'channels/', subscription_to_check.name)
                                      : path.join(subscriptions_base_path, subscription_to_check.isPlaylist ? 'playlists/' : 'channels/', subscription_to_check.name),
            user_uid: subscription_to_check.user_uid,
            type: subscription_to_check.type,
            sub_id: subscription_to_check['id'],
            archive_path: utils.getArchiveFolder(subscription_to_check.type, subscription_to_check.user_uid, subscription_to_check)
        });
    }

    return dirs_to_check;
}

// Basic DB functions

// Create

exports.insertRecordIntoTable = async (table, doc, replaceFilter = null) => {
    // local db override
    if (using_local_db) {
        if (replaceFilter) local_db.get(table).remove((doc) => _.isMatch(doc, replaceFilter)).write();
        local_db.get(table).push(doc).write();
        return true;
    }

    if (getActiveDBType() === DB_TYPES.postgres) {
        return await postgres_store.insertRecord(postgres_pool, tables, table, doc, replaceFilter);
    }

    if (replaceFilter) {
        const output = await mongo_database.collection(table).bulkWrite([
            {
                deleteMany: {
                    filter: replaceFilter
                }
            },
            {
                insertOne: {
                    document: doc
                }
            }
        ]);
        logger.debug(`Inserted doc into ${table} with filter: ${JSON.stringify(replaceFilter)}`);
        return isMongoWriteAck(output);
    }

    const output = await mongo_database.collection(table).insertOne(doc);
    logger.debug(`Inserted doc into ${table}`);
    return isMongoWriteAck(output);
}

exports.insertRecordsIntoTable = async (table, docs, ignore_errors = false) => {
    // local db override
    if (using_local_db) {
        const records_limit = 30000;
        if (docs.length < records_limit) {
            local_db.get(table).push(...docs).write();
        } else {
            for (let i = 0; i < docs.length; i+=records_limit) {
                const records_to_push = docs.slice(i, i+records_limit > docs.length ? docs.length : i+records_limit)
                local_db.get(table).push(...records_to_push).write();
            }
        }
        return true;
    }
    if (getActiveDBType() === DB_TYPES.postgres) {
        return await postgres_store.insertRecords(postgres_pool, tables, table, docs, ignore_errors);
    }
    const output = await mongo_database.collection(table).insertMany(docs, {ordered: !ignore_errors});
    logger.debug(`Inserted ${output.insertedCount} docs into ${table}`);
    return isMongoWriteAck(output);
}

exports.bulkInsertRecordsIntoTable = async (table, docs) => {
    // local db override
    if (using_local_db) {
        return await exports.insertRecordsIntoTable(table, docs);
    }
    if (!docs || docs.length === 0) return true;

    if (getActiveDBType() === DB_TYPES.postgres) {
        return await postgres_store.bulkInsertRecords(postgres_pool, tables, table, docs);
    }

    // not a necessary function as insertRecords does the same thing but gives us more control on batch size if needed
    const output = await mongo_database.collection(table).bulkWrite(
        docs.map(doc => ({
            insertOne: {
                document: doc
            }
        })),
        { ordered: true }
    );
    return isMongoWriteAck(output);

}

// Read

exports.getRecord = async (table, filter_obj) => {
    // local db override
    if (using_local_db) {
        return exports.applyFilterLocalDB(local_db.get(table), filter_obj, 'find').value();
    }

    if (getActiveDBType() === DB_TYPES.postgres) {
        return await postgres_store.getRecord(postgres_pool, tables, table, filter_obj);
    }

    return await mongo_database.collection(table).findOne(filter_obj);
}

exports.getRecords = async (table, filter_obj = null, return_count = false, sort = null, range = null) => {
    // local db override
    if (using_local_db) {
        let cursor = filter_obj ? exports.applyFilterLocalDB(local_db.get(table), filter_obj, 'filter').value() : local_db.get(table).value();
        if (sort) {
            cursor = cursor.sort((a, b) => (a[sort['by']] > b[sort['by']] ? sort['order'] : sort['order']*-1));
        }
        if (range) {
            cursor = cursor.slice(range[0], range[1]);
        }
        return !return_count ? cursor : cursor.length;
    }

    if (getActiveDBType() === DB_TYPES.postgres) {
        return await postgres_store.getRecords(postgres_pool, tables, table, filter_obj, return_count, sort, range);
    }

    const collection = mongo_database.collection(table);
    if (return_count) {
        return await collection.countDocuments(filter_obj || {});
    }

    const cursor = filter_obj ? collection.find(filter_obj) : collection.find();
    if (sort) {
        cursor.sort({[sort['by']]: sort['order']});
    }
    if (range) {
        cursor.skip(range[0]).limit(range[1] - range[0]);
    }

    return await cursor.toArray();
}

exports.aggregateRecords = async (table, pipeline = []) => {
    if (!tables[table]) {
        logger.error(`Refusing to aggregate unknown table '${table}'.`);
        return [];
    }

    if (using_local_db) {
        logger.warn(`Aggregation is not supported for local DB table '${table}'. Falling back to caller-managed logic.`);
        return [];
    }

    if (getActiveDBType() === DB_TYPES.postgres) {
        return await postgres_store.aggregateRecords(postgres_pool, tables, table, pipeline);
    }

    return await mongo_database.collection(table).aggregate(Array.isArray(pipeline) ? pipeline : []).toArray();
}

// Update

exports.updateRecord = async (table, filter_obj, update_obj, nested_mode = false) => {
    if (!tables[table]) {
        logger.error(`Refusing to update unknown table '${table}'.`);
        return false;
    }

    let sanitized_update_obj = null;
    try {
        sanitized_update_obj = sanitizeMongoUpdateSetObject(update_obj);
    } catch (err) {
        logger.error(`Refusing unsafe update for table '${table}': ${err.message}`);
        return false;
    }

    // local db override
    if (using_local_db) {
        if (nested_mode) {
            // if object is nested we need to handle it differently
            sanitized_update_obj = utils.convertFlatObjectToNestedObject(sanitized_update_obj);
            exports.applyFilterLocalDB(local_db.get(table), filter_obj, 'find').merge(sanitized_update_obj).write();
            return true;
        }
        exports.applyFilterLocalDB(local_db.get(table), filter_obj, 'find').assign(sanitized_update_obj).write();
        return true;
    }

    let sanitized_filter_obj = null;
    try {
        sanitized_filter_obj = sanitizeMongoLiteralFilter(filter_obj || {});
    } catch (err) {
        logger.error(`Refusing unsafe update filter for table '${table}': ${err.message}`);
        return false;
    }

    if (getActiveDBType() === DB_TYPES.postgres) {
        return await postgres_store.updateRecord(postgres_pool, tables, table, sanitized_filter_obj, sanitized_update_obj);
    }

    const output = await mongo_database.collection(table).updateOne(sanitized_filter_obj, {$set: sanitized_update_obj});
    return isMongoWriteAck(output);
}

exports.updateRecords = async (table, filter_obj, update_obj) => {
    if (!tables[table]) {
        logger.error(`Refusing to update unknown table '${table}'.`);
        return false;
    }

    let sanitized_update_obj = null;
    try {
        sanitized_update_obj = sanitizeMongoUpdateSetObject(update_obj);
    } catch (err) {
        logger.error(`Refusing unsafe bulk update for table '${table}': ${err.message}`);
        return false;
    }

    // local db override
    if (using_local_db) {
        exports.applyFilterLocalDB(local_db.get(table), filter_obj, 'filter').each((record) => {
            const props_to_update = Object.keys(sanitized_update_obj);
            for (let i = 0; i < props_to_update.length; i++) {
                const prop_to_update = props_to_update[i];
                const prop_value = sanitized_update_obj[prop_to_update];
                record[prop_to_update] = prop_value;
            }
        }).write();
        return true;
    }

    let sanitized_filter_obj = null;
    try {
        sanitized_filter_obj = sanitizeMongoLiteralFilter(filter_obj || {});
    } catch (err) {
        logger.error(`Refusing unsafe bulk update filter for table '${table}': ${err.message}`);
        return false;
    }

    if (getActiveDBType() === DB_TYPES.postgres) {
        return await postgres_store.updateRecords(postgres_pool, tables, table, sanitized_filter_obj, sanitized_update_obj);
    }

    const output = await mongo_database.collection(table).updateMany(sanitized_filter_obj, {$set: sanitized_update_obj});
    return isMongoWriteAck(output);
}

exports.removePropertyFromRecord = async (table, filter_obj, remove_obj) => {
    // local db override
    if (using_local_db) {
        const props_to_remove = Object.keys(remove_obj);
        exports.applyFilterLocalDB(local_db.get(table), filter_obj, 'find').unset(props_to_remove).write();
        return true;
    }

    if (getActiveDBType() === DB_TYPES.postgres) {
        return await postgres_store.removePropertyFromRecord(postgres_pool, tables, table, filter_obj, remove_obj);
    }

    const output = await mongo_database.collection(table).updateOne(filter_obj, {$unset: remove_obj});
    return isMongoWriteAck(output);
}

exports.bulkUpdateRecordsByKey = async (table, key_label, update_obj) => {
    // local db override
    if (using_local_db) {
        local_db.get(table).each((record) => {
            const item_id_to_update = record[key_label];
            if (!update_obj[item_id_to_update]) return;

            const props_to_update = Object.keys(update_obj[item_id_to_update]);
            for (let i = 0; i < props_to_update.length; i++) {
                const prop_to_update = props_to_update[i];
                const prop_value = update_obj[item_id_to_update][prop_to_update];
                record[prop_to_update] = prop_value;
            }
        }).write();
        return true;
    }

    if (getActiveDBType() === DB_TYPES.postgres) {
        return await postgres_store.bulkUpdateRecordsByKey(postgres_pool, tables, table, key_label, update_obj);
    }

    const item_ids_to_update = Object.keys(update_obj);
    if (item_ids_to_update.length === 0) return true;

    const output = await mongo_database.collection(table).bulkWrite(
        item_ids_to_update.map(item_id_to_update => ({
            updateOne: {
                filter: {[key_label]: item_id_to_update},
                update: { "$set": update_obj[item_id_to_update] }
            }
        })),
        { ordered: true }
    );
    return isMongoWriteAck(output);
}

exports.pushToRecordsArray = async (table, filter_obj, key, value) => {
    // local db override
    if (using_local_db) {
        exports.applyFilterLocalDB(local_db.get(table), filter_obj, 'find').get(key).push(value).write();
        return true;
    }

    if (getActiveDBType() === DB_TYPES.postgres) {
        return await postgres_store.pushToRecordsArray(postgres_pool, tables, table, filter_obj, key, value);
    }

    const output = await mongo_database.collection(table).updateOne(filter_obj, {$push: {[key]: value}});
    return isMongoWriteAck(output);
}

exports.pullFromRecordsArray = async (table, filter_obj, key, value) => {
    // local db override
    if (using_local_db) {
        exports.applyFilterLocalDB(local_db.get(table), filter_obj, 'find').get(key).pull(value).write();
        return true;
    }

    if (getActiveDBType() === DB_TYPES.postgres) {
        return await postgres_store.pullFromRecordsArray(postgres_pool, tables, table, filter_obj, key, value);
    }

    const output = await mongo_database.collection(table).updateOne(filter_obj, {$pull: {[key]: value}});
    return isMongoWriteAck(output);
}

// Delete

exports.removeRecord = async (table, filter_obj) => {
    // local db override
    if (using_local_db) {
        exports.applyFilterLocalDB(local_db.get(table), filter_obj, 'remove').write();
        return true;
    }

    if (getActiveDBType() === DB_TYPES.postgres) {
        return await postgres_store.removeRecord(postgres_pool, tables, table, filter_obj);
    }

    const output = await mongo_database.collection(table).deleteOne(filter_obj);
    return isMongoWriteAck(output);
}

// exports.removeRecordsByUIDBulk = async (table, uids) => {
//     // local db override
//     if (using_local_db) {
//         exports.applyFilterLocalDB(local_db.get(table), filter_obj, 'remove').write();
//         return true;
//     }

//     const table_collection = database.collection(table);
        
//     let bulk = table_collection.initializeOrderedBulkOp(); // Initialize the Ordered Batch

//     const item_ids_to_remove = 

//     for (let i = 0; i < item_ids_to_update.length; i++) {
//         const item_id_to_update = item_ids_to_update[i];
//         bulk.find({[key_label]: item_id_to_update }).updateOne({
//             "$set": update_obj[item_id_to_update]
//         });
//     }

//     const output = await bulk.execute();
//     return !!(output['result']['ok']);
// }


exports.findDuplicatesByKey = async (table, key) => {
    let duplicates = [];
    if (using_local_db) {
        // this can probably be optimized
        const all_records = await exports.getRecords(table);
        const existing_records = {};
        for (let i = 0; i < all_records.length; i++) {
            const record = all_records[i];
            const value = record[key];

            if (existing_records[value]) {
                duplicates.push(record);
            }

            existing_records[value] = true;
        }
        return duplicates;
    }

    if (getActiveDBType() === DB_TYPES.postgres) {
        return await postgres_store.findDuplicatesByKey(postgres_pool, tables, table, key);
    }
    
    const duplicated_values = await mongo_database.collection(table).aggregate([
        {"$group" : { "_id": `$${key}`, "count": { "$sum": 1 } } },
        {"$match": {"_id" :{ "$ne" : null } , "count" : {"$gt": 1} } }, 
        {"$project": {[key] : "$_id", "_id" : 0} }
    ]).toArray();

    for (let i = 0; i < duplicated_values.length; i++) {
        const duplicated_value = duplicated_values[i];
        const duplicated_records = await exports.getRecords(table, duplicated_value, false);
        if (duplicated_records.length > 1) {
            duplicates = duplicates.concat(duplicated_records.slice(1, duplicated_records.length));
        }
    }
    return duplicates;
}

exports.removeAllRecords = async (table = null, filter_obj = null) => {
    // local db override
    const tables_to_remove = table ? [table] : tables_list;
    logger.debug(`Removing all records from: ${tables_to_remove} with filter: ${JSON.stringify(filter_obj)}`)
    if (using_local_db) {
        for (let i = 0; i < tables_to_remove.length; i++) {
            const table_to_remove = tables_to_remove[i];
            if (filter_obj) exports.applyFilterLocalDB(local_db.get(table_to_remove), filter_obj, 'remove').write();
            else local_db.assign({[table_to_remove]: []}).write();
            logger.debug(`Successfully removed records from ${table_to_remove}`);
        }
        return true;
    }

    if (getActiveDBType() === DB_TYPES.postgres) {
        return await postgres_store.removeAllRecords(postgres_pool, tables, table, filter_obj);
    }

    let success = true;
    for (let i = 0; i < tables_to_remove.length; i++) {
        const table_to_remove = tables_to_remove[i];

        const output = await mongo_database.collection(table_to_remove).deleteMany(filter_obj ? filter_obj : {});
        logger.debug(`Successfully removed records from ${table_to_remove}`);
        success &= isMongoWriteAck(output);
    }
    return success;
}

// Stats

exports.getDBStats = async () => {
    const stats_by_table = {};
    for (let i = 0; i < tables_list.length; i++) {
        const table = tables_list[i];
        if (table === 'test') continue;

        stats_by_table[table] = await getDBTableStats(table);
    }
    const current_db_type = getActiveDBType();
    const configured_remote_db_type = getConfiguredRemoteDBType({ preferMigrationTarget: true });
    return {
        stats_by_table: stats_by_table,
        using_local_db: using_local_db,
        current_db_type: current_db_type,
        current_db_label: getDBLabel(current_db_type),
        configured_remote_db_type: configured_remote_db_type,
        configured_remote_db_label: getDBLabel(configured_remote_db_type)
    };
}

const getDBTableStats = async (table) => {
    const table_stats = {};
    // local db override
    if (using_local_db) {
        table_stats['records_count'] = local_db.get(table).value().length;
    } else if (getActiveDBType() === DB_TYPES.postgres) {
        const postgres_table_stats = await postgres_store.getTableStats(postgres_pool, table);
        table_stats['records_count'] = postgres_table_stats['records_count'];
    } else {
        table_stats['records_count'] = await mongo_database.collection(table).countDocuments({});
    }
    return table_stats;
}

// JSON to DB

exports.generateJSONTables = async (db_json, users_json) => {
    // create records
    let files = db_json['files'] || [];
    let playlists = db_json['playlists'] || [];
    let categories = db_json['categories'] || [];
    let subscriptions = db_json['subscriptions'] || [];

    const users = users_json['users'];

    for (let i = 0; i < users.length; i++) {
        const user = users[i];

        if (user['files']) {
            user['files'] = user['files'].map(file => ({ ...file, user_uid: user['uid'] }));
            files = files.concat(user['files']);
        }
        if (user['playlists']) {
            user['playlists'] = user['playlists'].map(playlist => ({ ...playlist, user_uid: user['uid'] }));
            playlists = playlists.concat(user['playlists']);
        }
        if (user['categories']) {
            user['categories'] = user['categories'].map(category => ({ ...category, user_uid: user['uid'] }));
            categories = categories.concat(user['categories']);
        }

        if (user['subscriptions']) {
            user['subscriptions'] = user['subscriptions'].map(subscription => ({ ...subscription, user_uid: user['uid'] }));
            subscriptions = subscriptions.concat(user['subscriptions']);
        }
    }

    const tables_obj = {};
    
    // TODO: use create*Records funcs to strip unnecessary properties
    tables_obj.files = createFilesRecords(files, subscriptions);
    tables_obj.playlists = playlists;
    tables_obj.categories = categories;
    tables_obj.subscriptions = createSubscriptionsRecords(subscriptions);
    tables_obj.users = createUsersRecords(users);
    tables_obj.roles = createRolesRecords(users_json['roles']);
    tables_obj.downloads = createDownloadsRecords(db_json['downloads'])
    
    return tables_obj;
}

exports.importJSONToDB = async (db_json, users_json) => {
    await fs.writeFile(`appdata/db.json.${Date.now()/1000}.bak`, JSON.stringify(db_json, null, 2));
    await fs.writeFile(`appdata/users_db.json.${Date.now()/1000}.bak`, JSON.stringify(users_json, null, 2));

    await exports.removeAllRecords();
    const tables_obj = await exports.generateJSONTables(db_json, users_json);

    const table_keys = Object.keys(tables_obj);
    
    let success = true;
    for (let i = 0; i < table_keys.length; i++) {
        const table_key = table_keys[i];
        if (!tables_obj[table_key] || tables_obj[table_key].length === 0) continue;
        success &= await exports.insertRecordsIntoTable(table_key, tables_obj[table_key], true);
    }

    return success;
}

const createFilesRecords = (files, subscriptions) => {
    for (let i = 0; i < subscriptions.length; i++) {
        const subscription = subscriptions[i];
        if (!subscription['videos']) continue;
        subscription['videos'] = subscription['videos'].map(file => ({ ...file, sub_id: subscription['id'], user_uid: subscription['user_uid'] ? subscription['user_uid'] : undefined}));
        files = files.concat(subscriptions[i]['videos']);
    }

    return files;
}

const createPlaylistsRecords = async (playlists) => {

}

const createCategoriesRecords = async (categories) => {

}

const createSubscriptionsRecords = (subscriptions) => {
    for (let i = 0; i < subscriptions.length; i++) {
        delete subscriptions[i]['videos'];
    }

    return subscriptions;
}

const createUsersRecords = (users) => {
    users.forEach(user => {
        delete user['files'];
        delete user['playlists'];
        delete user['subscriptions'];
    });
    return users;
}

const createRolesRecords = (roles) => {
    const new_roles = [];
    Object.keys(roles).forEach(role_key => {
        new_roles.push({
            key: role_key,
            ...roles[role_key]
        });
    });
    return new_roles;
}

const createDownloadsRecords = (downloads) => {
    const new_downloads = [];
    Object.keys(downloads).forEach(session_key => {
        new_downloads.push({
            key: session_key,
            ...downloads[session_key]
        });
    });
    return new_downloads;
}

exports.backupDB = async () => {
    const backup_dir = path.join('appdata', 'db_backup');
    fs.ensureDirSync(backup_dir);
    const backup_file_name = `${using_local_db ? 'local' : 'remote'}_db.json.${Date.now()/1000}.bak`;
    const path_to_backups = path.join(backup_dir, backup_file_name);

    logger.info(`Backing up ${using_local_db ? 'local' : 'remote'} DB to ${path_to_backups}`);

    const table_to_records = {};
    for (let i = 0; i < tables_list.length; i++) {
        const table = tables_list[i];
        table_to_records[table] = await exports.getRecords(table);
    }

    fs.writeJsonSync(path_to_backups, table_to_records);

    return backup_file_name;
}

exports.restoreDB = async (file_name) => {
    const backup_dir = path.join('appdata', 'db_backup');
    const path_to_backup = path.join(backup_dir, file_name);
    const relative_backup_path = path.relative(backup_dir, path_to_backup);
    if (!file_name || path.basename(file_name) !== file_name || relative_backup_path.startsWith('..') || path.isAbsolute(relative_backup_path)) {
        logger.error(`Failed to restore DB! Unsafe backup file name '${file_name}'.`);
        return false;
    }

    logger.debug('Reading database backup file.');
    const table_to_records = fs.readJSONSync(path_to_backup);

    if (!table_to_records) {
        logger.error(`Failed to restore DB! Backup file '${path_to_backup}' could not be read.`);
        return false;
    }

    logger.debug('Clearing database.');
    await exports.removeAllRecords();

    logger.debug('Database cleared! Beginning restore.');
    let success = true;
    for (let i = 0; i < tables_list.length; i++) {
        const table = tables_list[i];
        if (!table_to_records[table] || table_to_records[table].length === 0) continue;
        success &= await exports.bulkInsertRecordsIntoTable(table, table_to_records[table]);
    }

    logger.debug('Restore finished!');

    return success;
}

exports.transferDB = async (local_to_remote) => {
    const table_to_records = {};
    for (let i = 0; i < tables_list.length; i++) {
        const table = tables_list[i];
        table_to_records[table] = await exports.getRecords(table);
    }

    logger.info('Backup up DB...');
    await exports.backupDB(); // should backup always

    using_local_db = !local_to_remote;
    if (local_to_remote) {
        const db_connected = await exports.connectToDB(5, true);
        if (!db_connected) {
            logger.error(`Failed to transfer database - could not connect to ${getDBLabel(getConfiguredRemoteDBType({ preferMigrationTarget: true }))}. Verify that your connection URL is valid.`);
            return false;
        }
    }
    let success = true;

    logger.debug('Clearing new database before transfer...');

    await exports.removeAllRecords();

    logger.debug('Database cleared! Beginning transfer.');

    for (let i = 0; i < tables_list.length; i++) {
        const table = tables_list[i];
        if (!table_to_records[table] || table_to_records[table].length === 0) continue;
        success &= await exports.bulkInsertRecordsIntoTable(table, table_to_records[table]);
    }

    config_api.setConfigItem('ytdl_use_local_db', using_local_db);

    logger.debug('Transfer finished!');

    return success;
}

async function readAllTablesFromMongo(connection_string) {
    const client = new MongoClient(connection_string);
    await client.connect();
    const database = client.db('ytdl_material');
    try {
        const table_to_records = {};
        for (const table of tables_list) {
            table_to_records[table] = await database.collection(table).find().toArray();
        }
        return table_to_records;
    } finally {
        await client.close().catch(() => null);
    }
}

async function replaceAllTablesInMongo(connection_string, table_to_records = {}) {
    const client = new MongoClient(connection_string);
    await client.connect();
    const database = client.db('ytdl_material');
    try {
        await prepareMongoDatabase(database);
        for (const table of tables_list) {
            await database.collection(table).deleteMany({});
            const records = Array.isArray(table_to_records[table]) ? table_to_records[table] : [];
            if (records.length > 0) {
                await database.collection(table).insertMany(records, { ordered: true });
            }
        }
        return true;
    } finally {
        await client.close().catch(() => null);
    }
}

async function readAllTablesFromPostgres(connection_string) {
    const pool = await postgres_store.createConnection(connection_string, tables);
    try {
        return await postgres_store.readAllTables(pool, tables);
    } finally {
        await postgres_store.closeConnection(pool).catch(() => null);
    }
}

async function replaceAllTablesInPostgres(connection_string, table_to_records = {}) {
    const pool = await postgres_store.createConnection(connection_string, tables);
    try {
        return await postgres_store.replaceAllTables(pool, tables, table_to_records);
    } finally {
        await postgres_store.closeConnection(pool).catch(() => null);
    }
}

async function readAllTablesFromRemote(db_type, connection_string) {
    if (db_type === DB_TYPES.postgres) return await readAllTablesFromPostgres(connection_string);
    return await readAllTablesFromMongo(connection_string);
}

async function replaceAllTablesInRemote(db_type, connection_string, table_to_records = {}) {
    if (db_type === DB_TYPES.postgres) return await replaceAllTablesInPostgres(connection_string, table_to_records);
    return await replaceAllTablesInMongo(connection_string, table_to_records);
}

async function migrateRemoteDB(source_db_type, target_db_type, source_connection_string, target_connection_string) {
    const table_to_records = await readAllTablesFromRemote(source_db_type, source_connection_string);
    await replaceAllTablesInRemote(target_db_type, target_connection_string, table_to_records);
    return true;
}

exports.runConfiguredDBMigration = async () => {
    const migration_target = normalizeDBType(config_api.getConfigItem('ytdl_db_migrate'));
    if (!migration_target) return true;

    if (config_api.getConfigItem('ytdl_use_local_db')) {
        throw new Error('ytdl_db_migrate requires ytdl_use_local_db to be false.');
    }

    const source_db_type = migration_target === DB_TYPES.mongo ? DB_TYPES.postgres : DB_TYPES.mongo;
    const source_connection_string = getRemoteConnectionStringForType(source_db_type);
    const target_connection_string = getRemoteConnectionStringForType(migration_target);

    if (!source_connection_string || !target_connection_string) {
        throw new Error(`ytdl_db_migrate=${migration_target} requires both ytdl_mongodb_connection_string and ytdl_postgresdb_connection_string to be set.`);
    }

    logger.info(`Beginning configured DB migration from ${getDBLabel(source_db_type)} to ${getDBLabel(migration_target)}.`);

    try {
        await migrateRemoteDB(source_db_type, migration_target, source_connection_string, target_connection_string);
        remote_db_type = migration_target;
        logger.info(`Configured DB migration from ${getDBLabel(source_db_type)} to ${getDBLabel(migration_target)} completed successfully.`);
        return true;
    } catch (error) {
        logger.error(`Configured DB migration from ${getDBLabel(source_db_type)} to ${getDBLabel(migration_target)} failed. The source database was left untouched.`);
        throw error;
    }
}

/*
    This function is necessary to emulate mongodb's ability to search for null or missing values.
        A filter of null or undefined for a property will find docs that have that property missing, or have it
        null or undefined. We want that same functionality for the local DB as well

        error:    {$ne: null}
          ^            ^
          |            |
      filter_prop  filter_prop_value
*/
exports.applyFilterLocalDB = (db_path, filter_obj, operation) => {
    const filter_props = Object.keys(filter_obj);
    const return_val = db_path[operation](record => {
        if (!filter_props) return true;
        let filtered = true;
        for (let i = 0; i < filter_props.length; i++) {
            const filter_prop = filter_props[i];
            const filter_prop_value = filter_obj[filter_prop];
            if (filter_prop_value === undefined || filter_prop_value === null) {
                filtered &= record[filter_prop] === undefined || record[filter_prop] === null;
            } else {
                if (typeof filter_prop_value === 'object') {
                    const record_value = filter_prop.includes('.')
                        ? utils.searchObjectByString(record, filter_prop)
                        : record[filter_prop];
                    if ('$regex' in filter_prop_value) {
                        filtered &= typeof record_value === 'string'
                            && (record_value.search(new RegExp(filter_prop_value['$regex'], filter_prop_value['$options'])) !== -1);
                    } else if ('$ne' in filter_prop_value) {
                        filtered &= record_value !== undefined && record_value !== filter_prop_value['$ne'];
                    } else if ('$lt' in filter_prop_value) {
                        filtered &= record_value !== undefined && record_value < filter_prop_value['$lt'];
                    } else if ('$gt' in filter_prop_value) {
                        filtered &= record_value !== undefined && record_value > filter_prop_value['$gt'];
                    } else if ('$lte' in filter_prop_value) {
                        filtered &= record_value !== undefined && record_value <= filter_prop_value['$lte'];
                    } else if ('$gte' in filter_prop_value) {
                        filtered &= record_value !== undefined && record_value >= filter_prop_value['$gte'];
                    } else if ('$in' in filter_prop_value) {
                        filtered &= Array.isArray(filter_prop_value['$in']) && filter_prop_value['$in'].includes(record_value);
                    }
                } else {
                    // handle case of nested property check
                    if (filter_prop.includes('.'))
                        filtered &= utils.searchObjectByString(record, filter_prop) === filter_prop_value;
                    else
                        filtered &= record[filter_prop] === filter_prop_value;
                }
            }
        }
        return filtered;
    });
    return return_val;
}

// should only be used for tests
exports.setLocalDBMode = (mode) => {
    using_local_db = mode;
    if (mode) remote_db_type = null;
}

exports.isUsingLocalDB = () => {
    return using_local_db;
}

exports.isUsingPostgresDB = () => {
    return !using_local_db && getActiveDBType() === DB_TYPES.postgres;
}

exports.isUsingMongoDB = () => {
    return !using_local_db && getActiveDBType() === DB_TYPES.mongo;
}

exports.getConfiguredRemoteDBType = getConfiguredRemoteDBType;
exports.getActiveDBType = getActiveDBType;
exports.getDBLabel = getDBLabel;
exports._migrateRemoteDB = migrateRemoteDB;
exports.setPostgresPoolFactory = postgres_store.setPoolFactory;
exports.resetPostgresPoolFactory = postgres_store.resetPoolFactory;
exports.parsePostgresConnectionConfig = postgres_store.parsePostgresConnectionConfig;
