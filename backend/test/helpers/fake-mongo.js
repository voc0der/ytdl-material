const assert = require('assert');
const crypto = require('crypto');

/*************************************************
 * An in-memory MongoDB, for the half of db.js that
 * only runs against one.
 *
 * CI has no MongoDB to talk to, so every db.js
 * function's MongoDB branch went untested, and the
 * suite in database.test.js that runs each
 * operation against both stores skipped its remote
 * half. db.js takes the driver's client class
 * through setMongoClientCtor, so this stands in for
 * it.
 *
 * It implements the part of the driver db.js calls,
 * by MongoDB's rules for that part: a null filter
 * value matches a missing field, a value matches an
 * array that holds it, undefined is stored as null,
 * unique indexes refuse duplicates, sorting orders
 * by type before value, and writes answer in the
 * driver's own result shapes. Any other operator,
 * stage or update throws, so code that starts using
 * more of the driver fails here instead of quietly
 * matching nothing.
 *
 * Seeded documents are stored exactly as given.
 * Documents written through the driver get an _id,
 * which, as with the real driver, is also set on
 * the object passed in.
 *
 * `behavior` changes what the server does:
 *   connect(connection_string)  throw to refuse it
 *   writeResult(method, result) return a result to
 *                               answer a write with
 *   renameFailure(from, to)     true to fail a rename
 *   dropError(name)             an error to throw
 *                               from a drop
 ************************************************/

const DATABASE_NAME = 'ytdl_material';

const isPlainObject = value => Object.prototype.toString.call(value) === '[object Object]';
const isOperatorObject = value => isPlainObject(value) && Object.keys(value).length > 0 && Object.keys(value).every(key => key.startsWith('$'));
const newObjectId = () => crypto.randomBytes(12).toString('hex');

// What a value looks like once it has been through BSON and back. The driver's default
// (ignoreUndefined: false) writes undefined as null; copying also keeps a caller's later
// changes out of what is stored. Nothing here changes a pattern, so one is kept as it is
// rather than compiled again from data.
function stored(value) {
    if (value === undefined) return null;
    if (value === null || typeof value !== 'object') return value;
    if (value instanceof Date) return new Date(value.getTime());
    if (value instanceof RegExp) return value;
    if (Array.isArray(value)) return value.map(stored);
    const copy = {};
    for (const [key, item] of Object.entries(value)) copy[key] = stored(item);
    return copy;
}

function getPath(doc, field_path) {
    let current = doc;
    for (const part of field_path.split('.')) {
        if (Array.isArray(current) && !/^\d+$/.test(part)) {
            throw new Error(`fake-mongo: the path '${field_path}' runs through an array, which is not supported`);
        }
        if (current === null || typeof current !== 'object' || !Object.prototype.hasOwnProperty.call(current, part)) {
            return {found: false, value: undefined};
        }
        current = current[part];
    }
    return {found: true, value: current};
}

function setPath(doc, field_path, value) {
    const parts = field_path.split('.');
    let current = doc;
    for (const part of parts.slice(0, -1)) {
        if (current[part] === undefined || current[part] === null) current[part] = {};
        if (typeof current[part] !== 'object') {
            throw new Error(`fake-mongo: cannot create field '${field_path}' inside a ${typeof current[part]}`);
        }
        current = current[part];
    }
    current[parts[parts.length - 1]] = value;
}

function unsetPath(doc, field_path) {
    const parts = field_path.split('.');
    const parent = parts.length === 1 ? {found: true, value: doc} : getPath(doc, parts.slice(0, -1).join('.'));
    if (parent.found && parent.value !== null && typeof parent.value === 'object') delete parent.value[parts[parts.length - 1]];
}

// BSON equality: embedded documents match field for field, in order.
function valuesEqual(a, b) {
    if (a instanceof Date || b instanceof Date) return a instanceof Date && b instanceof Date && a.getTime() === b.getTime();
    if (Array.isArray(a) || Array.isArray(b)) {
        return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((item, i) => valuesEqual(item, b[i]));
    }
    if (isPlainObject(a) || isPlainObject(b)) {
        if (!isPlainObject(a) || !isPlainObject(b)) return false;
        const keys_a = Object.keys(a);
        const keys_b = Object.keys(b);
        return keys_a.length === keys_b.length && keys_a.every((key, i) => key === keys_b[i] && valuesEqual(a[key], b[key]));
    }
    return a === b;
}

function matchesEquality({found, value}, target) {
    if (target === null || target === undefined) return !found || value === null;
    if (!found) return false;
    if (valuesEqual(value, target)) return true;
    return Array.isArray(value) && !Array.isArray(target) && value.some(item => valuesEqual(item, target));
}

// The order MongoDB sorts and compares in: by type first, then by value.
function typeRank(value) {
    if (value === null || value === undefined) return 1;
    if (typeof value === 'number') return 2;
    if (typeof value === 'string') return 3;
    if (Array.isArray(value)) return 5;
    if (value instanceof Date) return 9;
    if (typeof value === 'boolean') return 8;
    if (typeof value === 'object') return 4;
    throw new Error(`fake-mongo: cannot compare a ${typeof value}`);
}

function compareValues(a, b) {
    const rank_a = typeRank(a);
    const rank_b = typeRank(b);
    if (rank_a !== rank_b) return rank_a - rank_b;
    if (rank_a === 1) return 0;
    if (rank_a === 2) return a - b;
    if (rank_a === 3) return a < b ? -1 : a > b ? 1 : 0;
    if (rank_a === 8) return Number(a) - Number(b);
    if (rank_a === 9) return a.getTime() - b.getTime();
    throw new Error('fake-mongo: comparing objects or arrays is not supported');
}

function matchesComparison(field, target, test) {
    if (!field.found) return false;
    const candidates = Array.isArray(field.value) ? field.value : [field.value];
    return candidates.some(candidate => typeRank(candidate) === typeRank(target) && test(compareValues(candidate, target)));
}

function matchesOperators(field, operators) {
    return Object.entries(operators).every(([operator, target]) => {
        switch (operator) {
        case '$eq': return matchesEquality(field, target);
        case '$ne': return !matchesEquality(field, target);
        case '$in':
            assert(Array.isArray(target), '$in needs an array');
            return target.some(item => matchesEquality(field, item));
        case '$nin':
            assert(Array.isArray(target), '$nin needs an array');
            return !target.some(item => matchesEquality(field, item));
        case '$gt': return matchesComparison(field, target, order => order > 0);
        case '$gte': return matchesComparison(field, target, order => order >= 0);
        case '$lt': return matchesComparison(field, target, order => order < 0);
        case '$lte': return matchesComparison(field, target, order => order <= 0);
        case '$exists': return field.found === !!target;
        default:
            throw new Error(`fake-mongo: the query operator ${operator} is not supported`);
        }
    });
}

function matches(doc, filter = {}) {
    if (!isPlainObject(filter)) throw new Error('fake-mongo: a filter must be a document');
    return Object.entries(filter).every(([key, target]) => {
        if (key.startsWith('$')) throw new Error(`fake-mongo: the top-level operator ${key} is not supported`);
        const field = getPath(doc, key);
        if (target instanceof RegExp) throw new Error(`fake-mongo: matching '${key}' by a pattern is not supported`);
        if (isPlainObject(target) && Object.keys(target).some(item => item.startsWith('$'))) {
            if (!isOperatorObject(target)) throw new Error(`fake-mongo: '${key}' mixes operators and fields`);
            return matchesOperators(field, target);
        }
        return matchesEquality(field, target);
    });
}

// {a: 1} keeps only a (and _id), {a: 0} keeps everything else, and _id follows its own
// setting either way.
function project(doc, projection = null) {
    const copy = stored(doc);
    if (!projection || Object.keys(projection).length === 0) return copy;
    const fields = Object.entries(projection).filter(([key]) => key !== '_id');
    const including = fields.length > 0 ? !!fields[0][1] : !!projection._id;
    if (fields.some(([, value]) => !!value !== including)) {
        throw new Error('fake-mongo: a projection cannot mix inclusion and exclusion');
    }
    const keep_id = projection._id === undefined ? true : !!projection._id;

    if (!including) {
        for (const [key] of fields) unsetPath(copy, key);
        if (!keep_id) delete copy._id;
        return copy;
    }

    const projected = {};
    if (keep_id && copy._id !== undefined) projected._id = copy._id;
    for (const [key] of fields) {
        const field = getPath(copy, key);
        if (field.found) setPath(projected, key, field.value);
    }
    return projected;
}

function sortDocuments(docs, sort_spec) {
    const keys = Object.entries(sort_spec);
    return [...docs].sort((a, b) => {
        for (const [key, direction] of keys) {
            const value_a = getPath(a, key).value;
            const value_b = getPath(b, key).value;
            const order = compareValues(value_a === undefined ? null : value_a, value_b === undefined ? null : value_b);
            if (order !== 0) return Number(direction) === -1 ? -order : order;
        }
        return 0;
    });
}

function applyUpdate(doc, update) {
    if (!isOperatorObject(update)) throw new Error('fake-mongo: an update must use update operators');
    for (const [operator, fields] of Object.entries(update)) {
        for (const [key, value] of Object.entries(fields)) {
            if (key === '_id' || key.startsWith('_id.')) throw new Error("fake-mongo: the _id field is immutable");
            switch (operator) {
            case '$set': setPath(doc, key, stored(value)); break;
            case '$unset': unsetPath(doc, key); break;
            case '$push': {
                const field = getPath(doc, key);
                if (!field.found || field.value === null) setPath(doc, key, [stored(value)]);
                else if (Array.isArray(field.value)) field.value.push(stored(value));
                else throw new Error(`fake-mongo: cannot $push to the non-array field '${key}'`);
                break;
            }
            case '$pull': {
                if (isPlainObject(value)) throw new Error('fake-mongo: $pull by condition is not supported');
                const field = getPath(doc, key);
                if (field.found && Array.isArray(field.value)) setPath(doc, key, field.value.filter(item => !valuesEqual(item, value)));
                break;
            }
            default:
                throw new Error(`fake-mongo: the update operator ${operator} is not supported`);
            }
        }
    }
}

function evaluate(expression, doc) {
    if (typeof expression === 'string' && expression.startsWith('$')) {
        const value = getPath(doc, expression.slice(1)).value;
        return value === undefined ? null : value;
    }
    if (isPlainObject(expression)) {
        if (isOperatorObject(expression)) throw new Error(`fake-mongo: the expression ${Object.keys(expression)[0]} is not supported`);
        const result = {};
        for (const [key, item] of Object.entries(expression)) result[key] = evaluate(item, doc);
        return result;
    }
    return expression;
}

function groupDocuments(docs, spec) {
    const groups = [];
    for (const doc of docs) {
        const key = evaluate(spec._id, doc);
        let group = groups.find(candidate => valuesEqual(candidate.key, key));
        if (!group) {
            group = {key, docs: []};
            groups.push(group);
        }
        group.docs.push(doc);
    }
    return groups.map(({key, docs: grouped}) => {
        const result = {_id: key};
        for (const [field, accumulator] of Object.entries(spec)) {
            if (field === '_id') continue;
            const [[operator, expression]] = Object.entries(accumulator);
            const values = grouped.map(doc => evaluate(expression, doc));
            switch (operator) {
            case '$sum': result[field] = values.reduce((total, value) => total + (typeof value === 'number' ? value : 0), 0); break;
            case '$max': result[field] = values.reduce((max, value) => (max === null || compareValues(value, max) > 0 ? value : max), null); break;
            case '$min': result[field] = values.reduce((min, value) => (min === null || compareValues(value, min) < 0 ? value : min), null); break;
            case '$first': result[field] = values[0]; break;
            case '$push': result[field] = values; break;
            default: throw new Error(`fake-mongo: the accumulator ${operator} is not supported`);
            }
        }
        return result;
    });
}

function projectStage(docs, spec) {
    const computed = Object.values(spec).some(value => typeof value === 'string' || isPlainObject(value));
    if (!computed) return docs.map(doc => project(doc, spec));
    return docs.map(doc => {
        const result = {};
        if (spec._id === undefined || spec._id) result._id = doc._id;
        for (const [key, value] of Object.entries(spec)) {
            if (key === '_id') continue;
            if (value === 1 || value === true) {
                const field = getPath(doc, key);
                if (field.found) setPath(result, key, stored(field.value));
            } else if (value === 0 || value === false) {
                throw new Error('fake-mongo: excluding fields next to computed ones is not supported');
            } else {
                setPath(result, key, stored(evaluate(value, doc)));
            }
        }
        return result;
    });
}

function runPipeline(docs, pipeline) {
    let current = docs;
    for (const stage of pipeline) {
        const [[name, spec]] = Object.entries(stage);
        switch (name) {
        case '$match': current = current.filter(doc => matches(doc, spec)); break;
        case '$group': current = groupDocuments(current, spec); break;
        case '$project': current = projectStage(current, spec); break;
        case '$sort': current = sortDocuments(current, spec); break;
        case '$skip': current = current.slice(spec); break;
        case '$limit': current = current.slice(0, spec); break;
        default: throw new Error(`fake-mongo: the pipeline stage ${name} is not supported`);
        }
    }
    return current.map(stored);
}

function duplicateKeyError(collection_name, index, keys) {
    const error = new Error(`E11000 duplicate key error collection: ${DATABASE_NAME}.${collection_name} index: ${Object.keys(keys).join('_')}`);
    error.name = 'MongoServerError';
    error.code = 11000;
    error.index = index;
    return error;
}

class FakeCollection {
    constructor(database, name) {
        this.database = database;
        this.collectionName = name;
    }

    get state() {
        return this.database.collections.get(this.collectionName) || {docs: [], indexes: []};
    }

    record(method, args) {
        this.database.calls.push({collection: this.collectionName, method, args: stored(args)});
    }

    answer(method, result) {
        const behavior = this.database.behavior;
        const override = typeof behavior.writeResult === 'function' ? behavior.writeResult(method, result) : undefined;
        return override === undefined ? result : override;
    }

    // Assigns the _id, checks unique indexes, and stores the document. Throws a duplicate
    // key error, as the server does, rather than store a second copy.
    insertDocument(doc, index) {
        if (!isPlainObject(doc)) throw new Error('fake-mongo: only documents can be inserted');
        if (doc._id === undefined) doc._id = newObjectId();
        const state = this.database.ensureCollection(this.collectionName);
        const candidate = stored(doc);
        const unique_indexes = [{keys: {_id: 1}}, ...state.indexes.filter(item => item.options && item.options.unique)];
        for (const unique_index of unique_indexes) {
            const key_fields = Object.keys(unique_index.keys);
            const values = key_fields.map(field => getPath(candidate, field).value ?? null);
            const clash = state.docs.some(existing => key_fields.every((field, i) => valuesEqual(getPath(existing, field).value ?? null, values[i])));
            if (clash) throw duplicateKeyError(this.collectionName, index, unique_index.keys);
        }
        state.docs.push(candidate);
        return doc._id;
    }

    updateMatching(filter, update, limit_one) {
        let matched = 0;
        let modified = 0;
        for (const doc of this.state.docs) {
            if (!matches(doc, filter)) continue;
            matched++;
            const before = JSON.stringify(doc);
            applyUpdate(doc, update);
            if (JSON.stringify(doc) !== before) modified++;
            if (limit_one) break;
        }
        return {matched, modified};
    }

    deleteMatching(filter, limit_one) {
        const state = this.state;
        let deleted = 0;
        state.docs = state.docs.filter(doc => {
            if ((limit_one && deleted > 0) || !matches(doc, filter)) return true;
            deleted++;
            return false;
        });
        return deleted;
    }

    // insertMany and bulkWrite: an ordered batch stops at its first error, an unordered one
    // carries on, and either way the driver throws once the batch is done.
    runBatch(operations, ordered, apply) {
        const write_errors = [];
        const totals = {insertedCount: 0, matchedCount: 0, modifiedCount: 0, deletedCount: 0, insertedIds: {}};
        for (let i = 0; i < operations.length; i++) {
            try {
                apply(operations[i], i, totals);
            } catch (error) {
                if (error.code !== 11000) throw error;
                write_errors.push({index: i, code: error.code, errmsg: error.message});
                if (ordered) break;
            }
        }
        if (write_errors.length > 0) {
            const error = new Error(write_errors[0].errmsg);
            error.name = 'MongoBulkWriteError';
            error.code = 11000;
            error.writeErrors = write_errors;
            error.result = totals;
            throw error;
        }
        return totals;
    }

    async createIndex(keys, options = {}) {
        this.record('createIndex', [keys, options]);
        this.database.ensureCollection(this.collectionName).indexes.push({keys, options});
        return Object.keys(keys).join('_');
    }

    async insertOne(doc) {
        this.record('insertOne', [doc]);
        const inserted_id = this.insertDocument(doc, 0);
        return this.answer('insertOne', {acknowledged: true, insertedId: inserted_id});
    }

    async insertMany(docs = [], options = {}) {
        this.record('insertMany', [docs, options]);
        const totals = this.runBatch(docs, options.ordered !== false, (doc, i, result) => {
            result.insertedIds[i] = this.insertDocument(doc, i);
            result.insertedCount++;
        });
        return this.answer('insertMany', {acknowledged: true, insertedCount: totals.insertedCount, insertedIds: totals.insertedIds});
    }

    async bulkWrite(operations = [], options = {}) {
        this.record('bulkWrite', [operations, options]);
        const totals = this.runBatch(operations, options.ordered !== false, (operation, i, result) => {
            const [[type, spec]] = Object.entries(operation);
            switch (type) {
            case 'insertOne':
                result.insertedIds[i] = this.insertDocument(spec.document, i);
                result.insertedCount++;
                break;
            case 'updateOne':
            case 'updateMany': {
                if (spec.upsert) throw new Error('fake-mongo: upserts are not supported');
                const {matched, modified} = this.updateMatching(spec.filter, spec.update, type === 'updateOne');
                result.matchedCount += matched;
                result.modifiedCount += modified;
                break;
            }
            case 'deleteOne':
            case 'deleteMany':
                result.deletedCount += this.deleteMatching(spec.filter, type === 'deleteOne');
                break;
            default:
                throw new Error(`fake-mongo: the bulk operation ${type} is not supported`);
            }
        });
        // A BulkWriteResult: it reports ok rather than acknowledged.
        return this.answer('bulkWrite', {ok: 1, ...totals, upsertedCount: 0, upsertedIds: {}});
    }

    async findOne(filter = {}, options = {}) {
        this.record('findOne', [filter, options]);
        const doc = this.state.docs.find(candidate => matches(candidate, filter));
        return doc ? project(doc, options.projection) : null;
    }

    find(filter = {}) {
        this.record('find', [filter]);
        const collection = this;
        const query = {sort: null, skip: 0, limit: 0, projection: null};
        const cursor = {
            sort(spec) { query.sort = spec; return cursor; },
            skip(count) { query.skip = count; return cursor; },
            limit(count) { query.limit = count; return cursor; },
            project(spec) { query.projection = spec; return cursor; },
            async toArray() {
                let docs = collection.state.docs.filter(doc => matches(doc, filter));
                if (query.sort) docs = sortDocuments(docs, query.sort);
                docs = docs.slice(query.skip, query.limit > 0 ? query.skip + query.limit : undefined);
                return docs.map(doc => project(doc, query.projection));
            }
        };
        return cursor;
    }

    async countDocuments(filter = {}) {
        this.record('countDocuments', [filter]);
        return this.state.docs.filter(doc => matches(doc, filter)).length;
    }

    async updateOne(filter, update, options = {}) {
        this.record('updateOne', [filter, update, options]);
        if (options.upsert) throw new Error('fake-mongo: upserts are not supported');
        const {matched, modified} = this.updateMatching(filter, update, true);
        return this.answer('updateOne', {acknowledged: true, matchedCount: matched, modifiedCount: modified, upsertedCount: 0, upsertedId: null});
    }

    async updateMany(filter, update, options = {}) {
        this.record('updateMany', [filter, update, options]);
        if (options.upsert) throw new Error('fake-mongo: upserts are not supported');
        const {matched, modified} = this.updateMatching(filter, update, false);
        return this.answer('updateMany', {acknowledged: true, matchedCount: matched, modifiedCount: modified, upsertedCount: 0, upsertedId: null});
    }

    async deleteOne(filter = {}) {
        this.record('deleteOne', [filter]);
        return this.answer('deleteOne', {acknowledged: true, deletedCount: this.deleteMatching(filter, true)});
    }

    async deleteMany(filter = {}) {
        this.record('deleteMany', [filter]);
        return this.answer('deleteMany', {acknowledged: true, deletedCount: this.deleteMatching(filter, false)});
    }

    aggregate(pipeline = []) {
        this.record('aggregate', [pipeline]);
        assert(Array.isArray(pipeline), 'a pipeline is an array of stages');
        return {toArray: async () => runPipeline(this.state.docs, pipeline)};
    }

    async rename(next_name, options = {}) {
        this.record('rename', [next_name, options]);
        const database = this.database;
        if (typeof database.behavior.renameFailure === 'function' && database.behavior.renameFailure(this.collectionName, next_name)) {
            throw new Error(`rename failed: ${this.collectionName} -> ${next_name}`);
        }
        const state = database.collections.get(this.collectionName);
        if (!state) throw new Error(`missing collection: ${this.collectionName}`);
        if (database.collections.has(next_name)) {
            if (!options.dropTarget) throw new Error(`target namespace exists: ${next_name}`);
            database.collections.delete(next_name);
        }
        database.collections.delete(this.collectionName);
        database.collections.set(next_name, state);
        return database.collection(next_name);
    }

    async drop() {
        this.record('drop', []);
        const database = this.database;
        const drop_error = typeof database.behavior.dropError === 'function' ? database.behavior.dropError(this.collectionName) : null;
        if (drop_error) throw drop_error;
        if (!database.collections.has(this.collectionName)) {
            const error = new Error('ns not found');
            error.codeName = 'NamespaceNotFound';
            throw error;
        }
        database.collections.delete(this.collectionName);
        return true;
    }
}

class FakeMongoDatabase {
    constructor(initial_collections = {}, behavior = {}) {
        this.collections = new Map();
        this.behavior = behavior;
        // Every collection call, with copies of its arguments, oldest first.
        this.calls = [];
        for (const [name, docs] of Object.entries(initial_collections)) {
            this.collections.set(name, {docs: stored(docs), indexes: []});
        }
    }

    listCollections(filter = {}) {
        const rows = [...this.collections.keys()]
            .filter(name => !filter.name || name === filter.name)
            .map(name => ({name}));
        return {toArray: async () => rows};
    }

    async createCollection(name) {
        this.ensureCollection(name);
        return this.collection(name);
    }

    collection(name) {
        return new FakeCollection(this, name);
    }

    ensureCollection(name) {
        if (!this.collections.has(name)) this.collections.set(name, {docs: [], indexes: []});
        return this.collections.get(name);
    }

    // What a collection holds, without the _ids the driver assigned.
    snapshot(name, {keep_ids = false} = {}) {
        const docs = stored((this.collections.get(name) || {docs: []}).docs);
        if (!keep_ids) docs.forEach(doc => delete doc._id);
        return docs;
    }

    collectionNames() {
        return [...this.collections.keys()].sort();
    }

    callsTo(method, collection = null) {
        return this.calls.filter(call => call.method === method && (!collection || call.collection === collection));
    }
}

/*************************************************
 * Returns a client class to hand to db.js, and the
 * databases behind it, one per connection string
 * and created on first use. `collections` seeds
 * them: {connection_string: {table: [docs]}}.
 ************************************************/
function createFakeMongo({collections = {}, behavior = {}} = {}) {
    const databases = new Map(Object.entries(collections).map(([connection_string, initial]) => [connection_string, new FakeMongoDatabase(initial, behavior)]));
    const clients = [];

    class FakeMongoClient {
        constructor(connection_string) {
            this.connectionString = connection_string;
            this.connected = false;
            this.closed = false;
            clients.push(this);
        }

        async connect() {
            if (typeof behavior.connect === 'function') await behavior.connect(this.connectionString);
            this.connected = true;
            return this;
        }

        db(name) {
            assert.strictEqual(name, DATABASE_NAME);
            if (!databases.has(this.connectionString)) databases.set(this.connectionString, new FakeMongoDatabase({}, behavior));
            return databases.get(this.connectionString);
        }

        async close() {
            this.closed = true;
        }
    }

    return {FakeMongoClient, databases, clients};
}

const MONGO_URL = 'mongodb://fake-mongo.test:27017/ytdl_material';

/*************************************************
 * Points db.js at an in-memory MongoDB for a
 * describe block. `install()` swaps in a fresh one,
 * for a test that needs its own behavior or seed.
 *
 * The block starts from an empty local store and
 * hands back the one it found: the local test
 * database is shared by the whole run, and moving
 * it between stores would otherwise both depend on
 * and rewrite whatever earlier files left in it.
 * Backups the block writes are removed, the config
 * is put back, and db.js returns to local mode.
 ************************************************/
function useFakeMongo(defaults = {}) {
    const { db_api, config_api, fs, path } = require('../test-shared');
    const backup_dir = path.join('appdata', 'db_backup');
    const saved = {};
    const state = {mongo: null, database: null};

    state.install = async ({connect = false, ...options} = defaults) => {
        state.mongo = createFakeMongo(options);
        db_api.setMongoClientCtor(state.mongo.FakeMongoClient);
        config_api.setConfigItem('ytdl_remote_db_type', 'mongo');
        config_api.setConfigItem('ytdl_mongodb_connection_string', MONGO_URL);
        if (connect) {
            assert.strictEqual(await db_api.connectToDB(0, true), true);
            assert.strictEqual(db_api.isUsingMongoDB(), true);
        }
        state.database = state.mongo.databases.get(MONGO_URL) || null;
        if (state.database) state.database.calls.length = 0;
        return state.mongo;
    };

    before(async function() {
        saved.config = JSON.parse(JSON.stringify(config_api.getConfigFile()));
        saved.backups = new Set(fs.existsSync(backup_dir) ? fs.readdirSync(backup_dir) : []);

        db_api.setLocalDBMode(true);
        saved.tables = [...Object.keys((await db_api.getDBStats()).stats_by_table), 'test'];
        saved.local = {};
        for (const table of saved.tables) saved.local[table] = JSON.parse(JSON.stringify(await db_api.getRecords(table)));
        await db_api.removeAllRecords();

        await state.install();
    });

    after(async function() {
        db_api.setLocalDBMode(true);
        await db_api.removeAllRecords();
        for (const table of saved.tables) {
            if (saved.local[table].length > 0) await db_api.insertRecordsIntoTable(table, saved.local[table]);
        }
        config_api.setConfigFile(saved.config);
        db_api.resetMongoClientCtor();
        db_api.setLocalDBMode(!!config_api.getConfigItem('ytdl_use_local_db'));
        if (fs.existsSync(backup_dir)) {
            for (const name of fs.readdirSync(backup_dir)) {
                if (!saved.backups.has(name)) fs.removeSync(path.join(backup_dir, name));
            }
        }
    });

    return state;
}

module.exports = {createFakeMongo, useFakeMongo, MONGO_URL};
