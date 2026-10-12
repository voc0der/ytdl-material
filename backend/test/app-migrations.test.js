const assert = require('assert');
const fs = require('fs-extra');
const path = require('path');

const { startApp } = require('./helpers/app-process');

const LIBRARY = {
    files: [{uid: 'kept-file', title: 'Kept', isAudio: false, registered: 1}],
    playlists: [{id: 'kept-playlist', name: 'Kept', uids: ['kept-file']}],
    users: [{uid: 'alice', name: 'alice', role: 'user'}]
};

const readJSON = (app, name) => fs.readJSONSync(path.join(app.root, 'appdata', name));

/*************************************************
 * The migrations that moved an install from before
 * 4.3, which kept its library in db.json and
 * users.json, into the database.
 *
 * They run when db.json lacks their flags. So does
 * a new install, or one whose db.json was lost or
 * deleted, and the second migration starts by
 * emptying the database: a library survived until
 * the next start without its db.json.
 ************************************************/
describe('Migrating from before 4.3', function() {
    this.timeout(30000);

    let app;

    afterEach(async function() {
        if (app) await app.stop();
        app = null;
    });

    it('keeps the library of an install whose db.json is gone', async function() {
        app = await startApp({prepare: ({root}) => fs.outputJSON(path.join(root, 'appdata', 'local_db.json'), LIBRARY)});

        const {files} = (await app.api.post('/api/getAllFiles').send({}).expect(200)).body;
        assert.deepStrictEqual(files.map(file => file.uid), ['kept-file']);
        const db = readJSON(app, 'local_db.json');
        assert.deepStrictEqual(db.playlists.map(playlist => playlist.id), ['kept-playlist']);
        assert.deepStrictEqual(db.users.map(user => user.uid), ['alice']);

        const db_json = readJSON(app, 'db.json');
        assert.strictEqual(db_json.simplified_db_migration_complete, true);
        assert.strictEqual(db_json.new_db_system_migration_complete, true);
        assert.doesNotMatch(app.output(), /Beginning migration: 4\.[12]->4\.[23]/);
    });

    it('still moves an install from before 4.3 into the database', async function() {
        app = await startApp({
            prepare: async ({root}) => {
                // The 4.1 layout, split by type, with one file of alice's.
                await fs.outputJSON(path.join(root, 'appdata', 'db.json'), {
                    files: {video: [{uid: 'old-video', title: 'Old video'}], audio: [{uid: 'old-song', title: 'Old song'}]},
                    playlists: {video: [], audio: []},
                    subscriptions: [],
                    downloads: {}
                });
                await fs.outputJSON(path.join(root, 'appdata', 'users.json'), {
                    users: [{
                        uid: 'alice', name: 'alice', role: 'user',
                        files: {video: [{uid: 'alices-video', title: 'Alice\'s video'}], audio: []},
                        playlists: {video: [], audio: []},
                        subscriptions: []
                    }],
                    roles: {admin: {permissions: ['settings']}, user: {permissions: ['filemanager']}}
                });
            }
        });

        const db = readJSON(app, 'local_db.json');
        assert.deepStrictEqual(db.files.map(file => [file.uid, file.user_uid]).sort(), [['alices-video', 'alice'], ['old-song', undefined], ['old-video', undefined]]);
        assert.deepStrictEqual(db.users.map(user => user.uid), ['alice']);
        assert.strictEqual(db.users[0].files, undefined);
        assert.match(app.output(), /4\.2->4\.3\+ migration complete!/);
        assert(fs.readdirSync(path.join(app.root, 'appdata')).some(name => /^db\.json\.[\d.]+\.bak$/.test(name)));
    });

    it('leaves a library in place rather than replace it with old records left in users.json', async function() {
        app = await startApp({
            prepare: async ({root}) => {
                await fs.outputJSON(path.join(root, 'appdata', 'local_db.json'), LIBRARY);
                await fs.outputJSON(path.join(root, 'appdata', 'users.json'), {
                    users: [{uid: 'someone-from-before', name: 'someone-from-before', files: [], playlists: [], subscriptions: []}]
                });
            }
        });

        const db = readJSON(app, 'local_db.json');
        assert.deepStrictEqual(db.files.map(file => file.uid), ['kept-file']);
        assert.deepStrictEqual(db.users.map(user => user.uid), ['alice']);
        assert.match(app.output(), /Skipped migration 4\.2->4\.3\+: the database already holds a library/);
        assert.strictEqual(readJSON(app, 'db.json').new_db_system_migration_complete, true);
    });
});
