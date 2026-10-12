const assert = require('assert');
const fs = require('fs-extra');
const path = require('path');

const { startApp } = require('./helpers/app-process');

const MONGO_URL = 'mongodb://fake-mongo.test:27017/ytdl_material';

const FILES = [
    {uid: 'first-file', title: 'First', isAudio: false, registered: 1},
    {uid: 'second-file', title: 'Second', isAudio: false, registered: 2}
];

/*************************************************
 * The database page's controls: checking a
 * connection string, and moving the library from
 * the local store to MongoDB and back while the
 * server keeps answering.
 *
 * The server process gets an in-memory MongoDB in
 * place of the driver (helpers/fake-mongo-server.js),
 * so nothing outside it is touched.
 ************************************************/
describe('Moving the database through the server', function() {
    this.timeout(30000);

    let app;
    const info = async () => (await app.api.get('/api/getDBInfo').expect(200)).body;
    const fileTitles = async () => (await app.api.post('/api/getAllFiles').send({}).expect(200)).body.files.map(file => `${file.uid}:${file.title}`).sort();
    const savedConfig = () => fs.readJSONSync(app.config_path).YtdlMaterial.Database;

    before(async function() {
        app = await startApp({
            env: {ytdl_remote_db_type: 'mongo', ytdl_mongodb_connection_string: MONGO_URL},
            preload: path.join(__dirname, 'helpers', 'fake-mongo-server.js'),
            prepare: async ({root}) => {
                await fs.outputJSON(path.join(root, 'appdata', 'local_db.json'), {files: FILES});
            }
        });
    });

    after(async function() {
        if (app) await app.stop();
    });

    it('checks a connection string without switching to it', async function() {
        const works = await app.api.post('/api/testConnectionString').send({connection_string: 'mongodb://fake-mongo.test:27017/'}).expect(200);
        assert.deepStrictEqual(works.body, {success: true, error: ''});
        const fails = await app.api.post('/api/testConnectionString').send({connection_string: 'mongodb://unreachable.test:27017/'}).expect(200);
        assert.deepStrictEqual(fails.body, {success: false, error: 'Connection string failed.'});

        assert.strictEqual((await info()).current_db_type, 'local');
    });

    it('refuses to move to the store it is already using', async function() {
        const res = await app.api.post('/api/transferDB').send({local_to_remote: false}).expect(200);
        assert.deepStrictEqual(res.body, {success: false, error: 'Failed to transfer DB as it cannot transition into its current status: Local DB'});
    });

    it('moves the library to MongoDB, and keeps serving it from there', async function() {
        const res = await app.api.post('/api/transferDB').send({local_to_remote: true}).expect(200);
        assert(res.body.success);
        assert.strictEqual(res.body.error, '');

        const now = await info();
        assert.strictEqual(now.current_db_label, 'MongoDB');
        assert.strictEqual(now.stats_by_table.files.records_count, FILES.length);
        assert.deepStrictEqual(await fileTitles(), ['first-file:First', 'second-file:Second']);
        assert.strictEqual(savedConfig().use_local_db, false);
    });

    it('moves it back to the local store, with what changed meanwhile', async function() {
        const edited = await app.api.post('/api/updateFile').send({uid: 'second-file', change_obj: {title: 'Renamed in MongoDB'}}).expect(200);
        assert.deepStrictEqual(edited.body, {success: true});

        const res = await app.api.post('/api/transferDB').send({local_to_remote: false}).expect(200);
        assert(res.body.success);

        assert.strictEqual((await info()).current_db_type, 'local');
        assert.deepStrictEqual(await fileTitles(), ['first-file:First', 'second-file:Renamed in MongoDB']);
        assert.strictEqual(savedConfig().use_local_db, true);
    });
});
