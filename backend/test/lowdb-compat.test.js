const assert = require('assert');
const fs = require('fs-extra');
const os = require('os');
const path = require('path');

const low = require('../lowdb-compat');
const FileSync = require('../lowdb-compat/adapters/FileSync');

/*************************************************
 * The stand-in for lowdb that every local database
 * read and write goes through. It is a thin layer
 * over lodash -- paths, deep defaults, merges, and
 * the object shorthand that find, filter and remove
 * accept -- so these pin the lodash behavior the
 * local database depends on as well as the layer.
 ************************************************/
describe('lowdb-compat', function() {
    let dir;
    const file = (name = 'db.json') => path.join(dir, name);
    const open = (name) => low(new FileSync(file(name)));

    beforeEach(function() {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ytdl-lowdb-test-'));
    });

    afterEach(function() {
        fs.removeSync(dir);
    });

    describe('FileSync', function() {
        it('creates a missing file, and the folders it is in, as an empty object', function() {
            const adapter = new FileSync(path.join(dir, 'nested', 'deeper', 'db.json'));
            assert.deepStrictEqual(adapter.read(), {});
            assert.deepStrictEqual(fs.readJSONSync(path.join(dir, 'nested', 'deeper', 'db.json')), {});
        });

        it('reads a file that is not JSON as empty, and leaves it alone', function() {
            fs.writeFileSync(file(), '{"half": ');
            assert.deepStrictEqual(new FileSync(file()).read(), {});
            assert.strictEqual(fs.readFileSync(file(), 'utf8'), '{"half": ');
        });

        it('passes on any other error', function() {
            fs.ensureDirSync(file());
            assert.throws(() => new FileSync(file()).read(), {code: 'EISDIR'});
        });

        it('writes indented JSON, creating folders as needed', function() {
            const target = path.join(dir, 'new', 'db.json');
            new FileSync(target).write({a: [1]});
            assert.strictEqual(fs.readFileSync(target, 'utf8'), '{\n  "a": [\n    1\n  ]\n}\n');
        });
    });

    describe('Reading and writing', function() {
        it('starts from what is on disk', function() {
            fs.writeJSONSync(file(), {users: [{uid: 'a'}]});
            assert.deepStrictEqual(open().get('users').value(), [{uid: 'a'}]);
        });

        it('starts empty when the file holds something other than an object', function() {
            fs.writeJSONSync(file(), 'just a string');
            assert.deepStrictEqual(open().value(), {});
        });

        it('only touches the disk on write', function() {
            const db = open();
            db.set('count', 1);
            assert.deepStrictEqual(fs.readJSONSync(file()), {});
            assert.deepStrictEqual(db.write(), {count: 1});
            assert.deepStrictEqual(fs.readJSONSync(file()), {count: 1});
        });

        it('picks up changes made on disk when read again', function() {
            const db = open();
            fs.writeJSONSync(file(), {changed: true});
            assert.deepStrictEqual(db.read(), {changed: true});
            assert.strictEqual(db.get('changed').value(), true);

            fs.writeJSONSync(file(), [1, 2]);
            assert.deepStrictEqual(db.read(), [1, 2]);
            fs.writeFileSync(file(), 'null');
            assert.deepStrictEqual(db.read(), {});
        });

        it('writes from any point in a chain', function() {
            const db = open();
            db.get('settings').set('theme', 'dark').write();
            assert.deepStrictEqual(fs.readJSONSync(file()), {settings: {theme: 'dark'}});
        });
    });

    describe('Paths', function() {
        it('reads and writes nested paths, as dotted strings or arrays', function() {
            const db = open();
            db.set('a.b.c', 1).set(['a', 'list', '0'], 'first');
            assert.strictEqual(db.get('a.b.c').value(), 1);
            assert.strictEqual(db.get(['a', 'b', 'c']).value(), 1);
            assert.deepStrictEqual(db.get('a.list').value(), ['first']);
            assert.strictEqual(db.get('a.missing.deeper').value(), undefined);
        });

        it('replaces a value that is not an object when something is set inside it', function() {
            const db = open();
            db.set('scalar', 5);
            db.get('scalar').set('inner', true);
            assert.deepStrictEqual(db.get('scalar').value(), {inner: true});

            db.set('flag', false);
            db.get('flag').get('nested').set('x', 1);
            assert.deepStrictEqual(db.get('flag').value(), {nested: {x: 1}});
        });

        it('sets through a chain on a path that does not exist yet', function() {
            const db = open();
            db.get('config').get('jwt_secret').assign({rotated: true});
            assert.deepStrictEqual(db.value(), {config: {jwt_secret: {rotated: true}}});
        });

        it('removes one path, or several', function() {
            const db = open();
            db.set('keep', 1).set('a', 1).set('b', {c: 1, d: 2});
            db.unset('a');
            db.unset(['b.c', 'missing.path']);
            assert.deepStrictEqual(db.value(), {keep: 1, b: {d: 2}});

            // Nothing to remove from inside a value that is not an object.
            db.get('keep').unset('x');
            assert.strictEqual(db.get('keep').value(), 1);
        });
    });

    describe('Defaults, assign and merge', function() {
        it('fills in missing defaults, deeply, without overwriting', function() {
            const db = open();
            db.set('roles', {admin: {permissions: ['settings']}});
            const defaults = {roles: {admin: {permissions: ['x']}, user: {permissions: ['sharing']}}, users: []};
            db.defaults(defaults);

            assert.deepStrictEqual(db.get('roles.admin.permissions').value(), ['settings']);
            assert.deepStrictEqual(db.get('roles.user.permissions').value(), ['sharing']);
            assert.deepStrictEqual(db.get('users').value(), []);

            // A copy, so the caller's object never becomes the stored one.
            defaults.roles.user.permissions.push('mutated later');
            assert.deepStrictEqual(db.get('roles.user.permissions').value(), ['sharing']);
        });

        it('starts from an object when the value is not one', function() {
            const db = open();
            db.set('a', 'text').set('b', null).set('c', 3);
            db.get('a').defaults({x: 1});
            db.get('b').assign({y: 2});
            db.get('c').merge({z: {deep: true}});
            assert.deepStrictEqual(db.value(), {a: {x: 1}, b: {y: 2}, c: {z: {deep: true}}});
        });

        it('assigns shallowly, and merges deeply', function() {
            const db = open();
            db.set('shallow', {nested: {a: 1, b: 1}});
            db.set('deep', {nested: {a: 1, b: 1}});
            db.get('shallow').assign({nested: {a: 2}});
            db.get('deep').merge({nested: {a: 2}});
            assert.deepStrictEqual(db.get('shallow').value(), {nested: {a: 2}});
            assert.deepStrictEqual(db.get('deep').value(), {nested: {a: 2, b: 1}});
        });
    });

    describe('Collections', function() {
        let db;

        beforeEach(function() {
            db = open();
            db.set('files', [
                {uid: '1', user_uid: 'alice', isAudio: false, tags: {favorite: true}},
                {uid: '2', user_uid: 'bob', isAudio: true, tags: {favorite: false}},
                {uid: '3', user_uid: 'alice', isAudio: true, tags: {favorite: true}}
            ]);
        });

        it('pushes onto an array, creating it when missing', function() {
            db.get('files').push({uid: '4'}, {uid: '5'});
            assert.deepStrictEqual(db.get('files').value().map(file => file.uid), ['1', '2', '3', '4', '5']);

            db.get('playlists').push({id: 'p1'});
            db.set('not_an_array', {}).get('not_an_array').push('x');
            assert.deepStrictEqual(db.get('playlists').value(), [{id: 'p1'}]);
            assert.deepStrictEqual(db.get('not_an_array').value(), ['x']);
        });

        it('pulls values out of an array, and ignores anything else', function() {
            db.set('ids', ['a', 'b', 'a', 'c']);
            db.get('ids').pull('a', 'c');
            assert.deepStrictEqual(db.get('ids').value(), ['b']);
            db.get('missing').pull('a');
            assert.strictEqual(db.get('missing').value(), undefined);
        });

        it('finds by an object shorthand, nested values included, or by a function', function() {
            assert.strictEqual(db.get('files').find({user_uid: 'alice', isAudio: true}).value().uid, '3');
            assert.strictEqual(db.get('files').find({tags: {favorite: false}}).value().uid, '2');
            assert.strictEqual(db.get('files').find(file => file.uid === '1').value().user_uid, 'alice');
            assert.strictEqual(db.get('files').find({user_uid: 'carol'}).value(), undefined);
        });

        it('edits a found record in place', function() {
            db.get('files').find({uid: '2'}).assign({user_uid: 'carol'}).set('tags.favorite', true);
            assert.deepStrictEqual(db.get('files').value()[1], {uid: '2', user_uid: 'carol', isAudio: true, tags: {favorite: true}});
        });

        it('replaces a found record that is not an object', function() {
            db.set('names', ['a', 'b']);
            db.get('names').find(name => name === 'b').set('upgraded', true);
            assert.deepStrictEqual(db.get('names').value(), ['a', {upgraded: true}]);

            db.set('by_key', {first: 1, second: 2});
            db.get('by_key').find(value => value === 2).assign({now: 'an object'});
            assert.deepStrictEqual(db.get('by_key').value(), {first: 1, second: {now: 'an object'}});
        });

        it('filters by an object shorthand into a copy', function() {
            const filtered = db.get('files').filter({user_uid: 'alice'});
            assert.deepStrictEqual(filtered.value().map(file => file.uid), ['1', '3']);
            filtered.set('ignored', true);
            assert.strictEqual(db.get('files').value().length, 3);
        });

        it('visits each entry', function() {
            const seen = [];
            db.get('files').each(file => { seen.push(file.uid); });
            assert.deepStrictEqual(seen, ['1', '2', '3']);
        });

        it('removes matching entries from an array or an object', function() {
            db.get('files').remove({user_uid: 'alice'});
            assert.deepStrictEqual(db.get('files').value().map(file => file.uid), ['2']);

            db.set('sessions', {a: {expired: true}, b: {expired: false}});
            db.get('sessions').remove(session => session.expired);
            assert.deepStrictEqual(db.get('sessions').value(), {b: {expired: false}});

            db.set('count', 1);
            db.get('count').remove(() => true);
            assert.strictEqual(db.get('count').value(), 1);
        });
    });
});
