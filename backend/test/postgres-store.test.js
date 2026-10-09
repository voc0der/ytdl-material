const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {newDb} = require('pg-mem');
const store = require('../postgres-store');

const TABLES = {
    files: {primary_key: 'uid', field_types: {size: 'numeric', favorite: 'boolean'}},
    events: {}
};
const FIRST = {uid: 'first', title: 'First clip', size: 10};
const SECOND = {uid: 'second', title: 'Second clip', size: 20};

function recordingPool(respond = () => ({rows: [], rowCount: 1})) {
    const calls = [];
    return {
        calls,
        async query(sql, params = []) {
            // Every bound value must be used, and every placeholder must have a value.
            const placeholders = [...sql.matchAll(/\$(\d+)/g)].map(match => Number(match[1]));
            assert.deepEqual([...new Set(placeholders)].sort((a, b) => a - b), params.map((_, i) => i + 1));
            calls.push({sql, params});
            return respond(sql, params);
        }
    };
}

describe('PostgreSQL store persistence', function() {
    let pool;

    beforeEach(async function() {
        // Execute the basic SQL against an isolated database. pg-mem does not implement
        // all JSONB operators or transaction rollback; those contracts are tested below.
        const {Pool} = newDb().adapters.createPg();
        pool = new Pool();
        await store.ensureSchema(pool, TABLES);
    });

    afterEach(async function() {
        await store.closeConnection(pool);
    });

    it('inserts, replaces and deletes a record without changing its neighbors', async function() {
        assert.equal(await store.insertRecords(pool, TABLES, 'files', [FIRST, SECOND]), true);
        assert.deepEqual(await store.getRecord(pool, TABLES, 'files', {uid: 'first'}), FIRST);
        assert.equal(await store.getRecord(pool, TABLES, 'files', {uid: 'missing'}), null);

        const replacement = {...FIRST, title: 'Renamed'};
        assert.equal(await store.insertRecord(pool, TABLES, 'files', replacement, {uid: 'first'}), true);
        assert.deepEqual(await store.getRecord(pool, TABLES, 'files', {uid: 'first'}), replacement);
        assert.deepEqual(await store.getRecord(pool, TABLES, 'files', {uid: 'second'}), SECOND);
        assert.deepEqual(await store.getTableStats(pool, 'files'), {records_count: 2});

        assert.equal(await store.removeRecord(pool, TABLES, 'files', {uid: 'first'}), true);
        assert.deepEqual(await store.getRecords(pool, TABLES, 'files'), [SECOND]);
        assert.equal(await store.getRecords(pool, TABLES, 'files', null, true), 1);
    });

    it('rejects duplicate keys unless explicitly told to ignore conflicts', async function() {
        await store.insertRecord(pool, TABLES, 'files', FIRST);
        await assert.rejects(store.insertRecord(pool, TABLES, 'files', FIRST), /duplicate key/);
        await store.insertRecords(pool, TABLES, 'files', [{...FIRST, title: 'Must not replace'}, SECOND], true);
        assert.deepEqual(await store.getRecords(pool, TABLES, 'files', null, false, {by: 'uid'}), [FIRST, SECOND]);

        // Tables without a document key still accept multiple records.
        await store.insertRecords(pool, TABLES, 'events', [{message: 'one'}, {message: 'two'}], true);
        assert.deepEqual(await store.getTableStats(pool, 'events'), {records_count: 2});
    });

    it('reads and replaces snapshots, clearing tables omitted from the snapshot', async function() {
        await store.bulkInsertRecords(pool, TABLES, 'files', [FIRST, SECOND]);
        await store.insertRecord(pool, TABLES, 'events', {message: 'old'});
        assert.deepEqual(await store.readAllTables(pool, TABLES), {files: [FIRST, SECOND], events: [{message: 'old'}]});

        assert.equal(await store.replaceAllTables(pool, TABLES, {files: [SECOND]}), true);
        assert.deepEqual(await store.readAllTables(pool, TABLES), {files: [SECOND], events: []});
        await store.replaceAllTables(pool, TABLES, {files: null});
        assert.deepEqual(await store.readAllTables(pool, TABLES), {files: [], events: []});
    });

    it('deletes only matching records in the selected table, or clears all tables', async function() {
        await store.bulkInsertRecords(pool, TABLES, 'files', [FIRST, SECOND]);
        await store.insertRecord(pool, TABLES, 'events', {message: 'keep'});
        await store.removeAllRecords(pool, TABLES, 'files', {uid: 'first'});
        assert.deepEqual(await store.readAllTables(pool, TABLES), {files: [SECOND], events: [{message: 'keep'}]});
        await store.removeAllRecords(pool, TABLES);
        assert.deepEqual(await store.getTableStats(pool, 'files'), {records_count: 0});
        assert.equal(await store.getRecords(pool, TABLES, 'events', null, true), 0);
    });

    it('pages sorted records with an exclusive end and clamps negative ranges', async function() {
        await store.insertRecords(pool, TABLES, 'files', [SECOND, FIRST]);
        assert.deepEqual(await store.getRecords(pool, TABLES, 'files', null, false, {by: 'uid'}, [1, 2]), [SECOND]);
        assert.deepEqual(await store.getRecords(pool, TABLES, 'files', null, false, {by: 'uid', order: -1}, [-1, 1]), [SECOND]);
        assert.deepEqual(await store.getRecords(pool, TABLES, 'files', null, false, null, [2, 1]), []);
    });
});

describe('PostgreSQL connection lifecycle', function() {
    afterEach(function() { store.resetPoolFactory(); });

    it('validates the connection URL and removes only driver SSL parameters', function() {
        for (const value of [undefined, null, '', '   ', 42]) {
            assert.throws(() => store.parsePostgresConnectionConfig(value), /connection string is required/);
        }
        assert.throws(() => store.parsePostgresConnectionConfig('https://db.test/database'), /Unsupported PostgreSQL protocol/);
        assert.throws(() => store.parsePostgresConnectionConfig('not a URL'), /Invalid URL/);
        assert.deepEqual(store.parsePostgresConnectionConfig('postgres://db.test/library?sslmode=disable&application_name=test'), {
            connectionString: 'postgres://db.test/library?application_name=test'
        });
        assert.equal(store.parsePostgresConnectionConfig('postgresql://db.test/library?sslmode=require').ssl.rejectUnauthorized, false);
        const verified = store.parsePostgresConnectionConfig('postgresql://db.test/library?sslmode=verify-full');
        assert.equal(verified.ssl.rejectUnauthorized, true);
        assert.equal(verified.ssl.checkServerIdentity, undefined);
    });

    it('loads client certificates and distinguishes CA verification from hostname verification', function() {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'postgres-store-certs-'));
        try {
            const url = new URL('postgresql://db.test/library');
            for (const [parameter, contents] of [['sslrootcert', 'test CA'], ['sslcert', 'test certificate'], ['sslkey', 'test key']]) {
                const filename = path.join(root, parameter);
                fs.writeFileSync(filename, contents);
                url.searchParams.set(parameter, filename);
            }
            url.searchParams.set('sslmode', 'verify-ca');
            const config = store.parsePostgresConnectionConfig(url.toString());
            assert.equal(config.connectionString, 'postgresql://db.test/library');
            assert.equal(config.ssl.ca, 'test CA');
            assert.equal(config.ssl.cert, 'test certificate');
            assert.equal(config.ssl.key, 'test key');
            assert.equal(config.ssl.rejectUnauthorized, true);
            assert.equal(config.ssl.checkServerIdentity('db.test', {}), undefined);
            fs.unlinkSync(path.join(root, 'sslkey'));
            assert.throws(() => store.parsePostgresConnectionConfig(url.toString()), {code: 'ENOENT'});
        } finally {
            fs.rmSync(root, {recursive: true, force: true});
        }
    });

    for (const testOnly of [true, false]) {
        it(`opens and closes a ${testOnly ? 'connection check without schema writes' : 'store with its schema'}`, async function() {
            let ended = false;
            const pool = recordingPool();
            pool.end = async () => { ended = true; };
            store.setPoolFactory(config => {
                assert.deepEqual(config, {connectionString: 'postgres://db.test/library'});
                return pool;
            });
            assert.equal(await store.createConnection('postgres://db.test/library', TABLES, {testOnly}), pool);
            assert.equal(pool.calls[0].sql, 'SELECT 1');
            assert.equal(pool.calls.some(({sql}) => sql.includes('CREATE TABLE')), !testOnly);
            assert.equal(ended, false);
            await store.closeConnection(pool);
            assert.equal(ended, true);
            await store.closeConnection(null);
        });
    }

    for (const failAt of ['SELECT 1', 'CREATE TABLE']) {
        it(`closes a failed pool and preserves the error from ${failAt}`, async function() {
            const failure = new Error('connection or schema failed');
            let ended = false;
            const pool = recordingPool(sql => {
                if (sql.includes(failAt)) throw failure;
                return {rows: []};
            });
            pool.end = async () => { ended = true; throw new Error('cleanup failed'); };
            store.setPoolFactory(() => pool);
            await assert.rejects(store.createConnection('postgres://db.test/library', TABLES), error => error === failure);
            assert.equal(ended, true);
        });
    }
});

describe('PostgreSQL query contracts', function() {
    it('does no database work for empty batch operations', async function() {
        const pool = recordingPool();
        for (const docs of [[], null, {}]) assert.equal(await store.insertRecords(pool, TABLES, 'files', docs), true);
        assert.equal(await store.bulkUpdateRecordsByKey(pool, TABLES, 'files', 'uid', {}), true);
        assert.equal(await store.hasAnyRecords(pool, {}), false);
        assert.deepEqual(pool.calls, []);
    });

    for (const [label, filter, fragment, value] of [
        ['null', {title: null}, /IS NULL/, ['title']],
        ['explicit equality', {uid: {$eq: "quote' OR TRUE --"}}, /doc_key = \$1::text/, "quote' OR TRUE --"],
        ['numeric equality', {size: {$eq: 10}}, /= \$2::jsonb/, '10'],
        ['inequality', {favorite: {$ne: true}}, /IS NOT NULL AND NOT/, 'true'],
        ['case-sensitive regex', {title: {$regex: '^Clip'}}, / ~ \$2/, '^Clip'],
        ['case-insensitive regex', {title: {$regex: '^clip', $options: 'i'}}, / ~\* \$2/, '^clip'],
        ['numeric bounds', {size: {$gt: 1, $lte: 20}}, /> \$2 AND .* <= \$3/, 20],
        ['boolean sorting value', {favorite: {$gte: false}}, /::boolean.*>= \$2/, false],
        ['text bounds', {title: {$lt: 'z'}}, /< \$2/, 'z'],
        ['key membership', {uid: {$in: ['first', 'second']}}, /doc_key = ANY/, ['first', 'second']],
        ['numeric membership', {size: {$in: [10, 20]}}, /ANY\(\$1::numeric\[\]\)/, [10, 20]],
        ['boolean membership', {favorite: {$in: [true, false]}}, /ANY\(\$1::boolean\[\]\)/, [true, false]],
        ['numeric strings', {size: {$in: ['10', '20']}}, /ANY\(\$2::text\[\]\)/, ['10', '20']],
        ['mixed membership', {title: {$in: ['first', 10, false]}}, / OR /, 'false'],
        ['object equality', {metadata: {source: 'manual'}}, /= \$2::jsonb/, '{"source":"manual"}']
    ]) {
        it(`binds ${label} filters without interpolating values`, async function() {
            const pool = recordingPool(() => ({rows: [{doc: FIRST}]}));
            assert.deepEqual(await store.getRecords(pool, TABLES, 'files', filter), [FIRST]);
            assert.equal(pool.calls.length, 1);
            assert.match(pool.calls[0].sql, fragment);
            assert(pool.calls[0].params.some(param => JSON.stringify(param) === JSON.stringify(value)));
            assert(!pool.calls[0].sql.includes("quote' OR TRUE --"));
        });
    }

    it('makes empty and malformed membership filters match nothing', async function() {
        for (const values of [[], null, 'first']) {
            const pool = recordingPool();
            await store.getRecords(pool, TABLES, 'files', {uid: {$in: values}});
            assert.match(pool.calls[0].sql, /WHERE FALSE$/);
            assert.deepEqual(pool.calls[0].params, []);
        }
    });

    it('rejects unsafe identifiers and nested paths before sending any SQL', async function() {
        const pool = recordingPool();
        await assert.rejects(store.getRecords(pool, TABLES, 'files; DROP TABLE files'), /Unsafe SQL identifier/);
        for (const field of ['', 'title..name', 'title.$gt', 'constructor.name', '__proto__.polluted', 'metadata.prototype', "title' --"]) {
            await assert.rejects(store.getRecords(pool, TABLES, 'files', {[field]: 'bad'}), /field path/i);
            await assert.rejects(store.updateRecord(pool, TABLES, 'files', null, {[field]: true}), /field path/i);
            await assert.rejects(store.getRecords(pool, TABLES, 'files', null, false, null, null, [field]), /field path/i);
            await assert.rejects(store.pushToRecordsArray(pool, TABLES, 'files', null, field, 'bad'), /field path/i);
            await assert.rejects(store.pullFromRecordsArray(pool, TABLES, 'files', null, field, 'bad'), /field path/i);
        }
        assert.deepEqual(pool.calls, []);
        assert.equal({}.polluted, undefined);
    });

    it('keeps document keys synchronized during updates and property removal', async function() {
        const pool = recordingPool();
        await store.updateRecords(pool, TABLES, 'files', {uid: 'first'}, {uid: 'renamed', 'metadata.title': 'new', _id: 'ignored'});
        const update = pool.calls[0];
        assert.match(update.sql, /SET doc = jsonb_set/);
        assert.match(update.sql, /doc_key = jsonb_extract_path_text\(jsonb_set/);
        assert(update.params.includes('"renamed"'));
        assert(update.params.some(value => JSON.stringify(value) === '["metadata","title"]'));
        assert(!update.params.includes('"ignored"'));

        await store.removePropertyFromRecord(pool, TABLES, 'files', {uid: 'renamed'}, {'metadata.title': true, _id: true});
        assert.match(pool.calls[1].sql, /doc = \(doc #- \$1::text\[\]\)/);
        assert.deepEqual(pool.calls[1].params, [['metadata', 'title'], 'renamed', ['uid']]);
        await store.updateRecord(pool, TABLES, 'events', null, {message: 'new'});
        assert.match(pool.calls[2].sql, /doc_key = doc_key WHERE TRUE/);
    });

    it('normalizes missing arrays when appending and preserves an empty array after removal', async function() {
        const pool = recordingPool();
        const value = {uid: "quote'", enabled: true};
        await store.pushToRecordsArray(pool, TABLES, 'files', {uid: 'first'}, 'metadata.items', value);
        await store.pullFromRecordsArray(pool, TABLES, 'files', {uid: 'first'}, 'metadata.items', value);
        assert.deepEqual(pool.calls[0].params, [JSON.stringify([value]), ['metadata', 'items'], 'first', ['uid']]);
        assert.deepEqual(pool.calls[1].params, [JSON.stringify(value), ['metadata', 'items'], 'first', ['uid']]);
        assert.match(pool.calls[0].sql, /ELSE '\[\]'::jsonb END/);
        assert.match(pool.calls[0].sql, /\|\| \$1::jsonb/);
        assert.match(pool.calls[1].sql, /jsonb_array_elements/);
        assert.match(pool.calls[1].sql, /WHERE elem <> \$1::jsonb\), '\[\]'::jsonb\)/);
    });

    const transactions = {
        replacement: pool => store.insertRecord(pool, TABLES, 'files', FIRST, {uid: FIRST.uid}),
        'bulk update': pool => store.bulkUpdateRecordsByKey(pool, TABLES, 'files', 'uid', {first: {title: 'new'}, second: {title: 'later'}}),
        'table deletion': pool => store.removeAllRecords(pool, TABLES),
        'snapshot restore': pool => store.replaceAllTables(pool, TABLES, {files: [FIRST]})
    };
    for (const [label, operation] of Object.entries(transactions)) {
        it(`commits a successful ${label} and rolls back a failed statement`, async function() {
            const success = recordingPool();
            assert.equal(await operation(success), true);
            assert.equal(success.calls[0].sql, 'BEGIN');
            assert.equal(success.calls.at(-1).sql, 'COMMIT');
            assert(success.calls.length >= 4);

            const failure = new Error('write failed');
            let writes = 0;
            const failed = recordingPool(sql => {
                if (/^(INSERT|UPDATE|DELETE)/.test(sql) && ++writes === 2) throw failure;
                return {rows: [], rowCount: 1};
            });
            await assert.rejects(operation(failed), error => error === failure);
            assert.equal(failed.calls.at(-1).sql, 'ROLLBACK');
            assert.equal(failed.calls.some(({sql}) => sql === 'COMMIT'), false);
            assert.equal(writes, 2, 'no later write may run after a failure');
        });
    }

    it('checks only existing tables and stops at the first nonempty one', async function() {
        for (const hasRows of [false, true]) {
            const pool = recordingPool(sql => sql.includes('information_schema')
                ? {rows: [{table_name: 'events'}]}
                : {rows: [{has_rows: hasRows}]});
            assert.equal(await store.hasAnyRecords(pool, TABLES), hasRows);
            assert.deepEqual(pool.calls[0].params, [['files', 'events']]);
            assert.equal(pool.calls.length, 2);
            assert.match(pool.calls[1].sql, /FROM "events"/);
        }
        const pool = recordingPool(sql => sql.includes('information_schema')
            ? {rows: [{table_name: 'files'}, {table_name: 'events'}]}
            : {rows: [{has_rows: true}]});
        assert.equal(await store.hasAnyRecords(pool, TABLES), true);
        assert.equal(pool.calls.length, 2);
        assert.match(pool.calls[1].sql, /FROM "files"/);
    });

    it('finds later duplicates using a stable key and excludes missing grouping values', async function() {
        for (const table of ['files', 'events']) {
            const pool = recordingPool(() => ({rows: [{doc: SECOND}]}));
            assert.deepEqual(await store.findDuplicatesByKey(pool, TABLES, table, 'metadata.source'), [SECOND]);
            assert.match(pool.calls[0].sql, /row_number\(\) OVER \(PARTITION BY/);
            assert.match(pool.calls[0].sql, /IS NOT NULL/);
            assert.match(pool.calls[0].sql, /duplicate_rank > 1/);
            assert(pool.calls[0].sql.includes(table === 'files' ? 'ORDER BY doc_key' : 'ORDER BY row_id::text'));
            assert.deepEqual(pool.calls[0].params, [['metadata', 'source']]);
        }
    });
});

describe('PostgreSQL aggregate fallback', function() {
    const records = [
        {uid: 'a', title: 'Alpha', size: 10, metadata: {source: 'one'}, tags: ['keep']},
        {uid: 'b', title: 'beta', size: 20, metadata: {source: 'one'}, tags: ['other']},
        {uid: 'c', title: 'ALPHA', size: 20, metadata: {source: 'two'}, tags: ['keep']},
        {uid: 'd', title: 42, size: null, metadata: null},
        {uid: 'e'}
    ];
    const aggregate = pipeline => store.aggregateRecords(
        recordingPool(() => ({rows: records.map(doc => ({doc}))})), TABLES, 'files', pipeline);

    for (const [label, filter, uids] of [
        ['missing nested values', {'metadata.source': null}, ['d', 'e']],
        ['regex', {title: {$regex: '^alpha$', $options: 'i'}}, ['a', 'c']],
        ['inequality', {size: {$ne: 20}}, ['a', 'd']],
        ['less than', {size: {$lt: 20}}, ['a', 'd']],
        ['greater than', {size: {$gt: 10}}, ['b', 'c']],
        ['at most', {size: {$lte: 10}}, ['a', 'd']],
        ['at least', {size: {$gte: 20}}, ['b', 'c']],
        ['membership', {uid: {$in: ['a', 'c']}}, ['a', 'c']],
        ['empty membership', {uid: {$in: []}}, []],
        ['invalid membership', {uid: {$in: null}}, []],
        ['deep equality', {tags: ['keep']}, ['a', 'c']],
        ['combined fields', {'metadata.source': 'one', size: 20}, ['b']]
    ]) {
        it(`filters ${label} when the pipeline cannot be translated to SQL`, async function() {
            assert.deepEqual((await aggregate([{$match: filter}])).map(doc => doc.uid), uids);
        });
    }

    it('groups all records, computes count and maximum, and supports an empty result', async function() {
        assert.deepEqual(await aggregate([{$group: {_id: null, count: {$sum: 1}, max: {$max: '$size'}}}]), [
            {_id: null, count: 5, max: 20}
        ]);
        assert.deepEqual(await aggregate([{$match: {uid: 'missing'}}, {$count: 'total'}]), [{total: 0}]);
    });

    it('groups nested keys and filters and sorts the resulting groups', async function() {
        assert.deepEqual(await aggregate([
            {$group: {_id: '$metadata.source', count: {$sum: 1}, max: {$max: '$size'}}},
            // Regex on an aggregate result deliberately selects the JS fallback.
            {$match: {_id: {$regex: '^(one|two)$'}}},
            {$sort: {count: -1}}
        ]), [{_id: 'one', count: 2, max: 20}, {_id: 'two', count: 1, max: 20}]);
    });

    it('sorts by multiple fields, keeps ties stable and places missing values last', async function() {
        assert.deepEqual((await aggregate([{$sort: {size: -1, uid: 1}}])).map(doc => doc.uid), ['b', 'c', 'a', 'd', 'e']);
        assert.deepEqual((await aggregate([{$sort: {size: 1}}])).map(doc => doc.uid), ['a', 'b', 'c', 'd', 'e']);
        assert.deepEqual(await aggregate(null), records);
        assert.deepEqual(await aggregate([]), records);
    });
});
