const assert = require('node:assert/strict');
const store = require('../postgres-store');

const TABLES = {files: {primary_key: 'uid', field_types: {size: 'numeric'}}};

function recordingPool(respond = () => ({rows: []})) {
    const calls = [];
    return {
        calls,
        async query(sql, params = []) {
            calls.push({sql, params});
            return respond(sql, params);
        }
    };
}

// The SQL the PostgreSQL store writes for the less common filters, and what it does when a
// pipeline cannot be written as SQL at all.
describe('PostgreSQL store SQL', function() {
    afterEach(function() { store.resetPoolFactory(); });

    it('looks a record up by its key as text', async function() {
        const pool = recordingPool(() => ({rows: [{doc: {uid: 'first'}}]}));
        assert.deepEqual(await store.getRecords(pool, TABLES, 'files', {uid: 'first'}), [{uid: 'first'}]);
        assert.match(pool.calls[0].sql, /doc_key = \$1::text/);
        assert.deepEqual(pool.calls[0].params, ['first']);
    });

    it('filters grouped results in SQL by missing, equal, unequal and plain values', async function() {
        const pool = recordingPool(() => ({rows: [{_id: 'one', count: 2}]}));
        const groups = await store.aggregateRecords(pool, TABLES, 'files', [
            {$group: {_id: '$source', count: {$sum: 1}, biggest: {$max: '$size'}}},
            {$match: {missing: null, count: {$eq: 2}, biggest: {$ne: 5}, _id: 'one'}}
        ]);

        assert.deepEqual(groups, [{_id: 'one', count: 2}]);
        const {sql, params} = pool.calls[0];
        assert.match(sql, /"missing" IS NULL/);
        assert.match(sql, /"count" = \$\d+/);
        assert.match(sql, /"biggest" IS NOT NULL AND "biggest" <> \$\d+/);
        assert.match(sql, /"_id" = \$\d+/);
        assert.deepEqual(params.slice(-3), [2, 5, 'one']);
    });

    it('works out an aggregation it cannot write as SQL itself', async function() {
        const records = [{uid: 'a', source: 'one'}, {uid: 'b', source: 'one'}, {uid: 'c', source: 'two'}];
        const pool = recordingPool(() => ({rows: records.map(doc => ({doc}))}));
        const groups = await store.aggregateRecords(pool, TABLES, 'files', [{$group: {_id: '$source', first: {$first: '$uid'}}}]);

        assert.doesNotMatch(pool.calls[0].sql, /GROUP BY/);
        assert.deepEqual(groups.map(group => group._id).sort(), ['one', 'two']);
    });

    it('connects with the pg driver unless told otherwise, and gives up on a server that is not there', async function() {
        await assert.rejects(store.createConnection('postgres://nobody:secret@127.0.0.1:1/library', TABLES, {testOnly: true}));
    });
});
