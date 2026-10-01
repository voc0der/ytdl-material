const assert = require('assert');
const fs = require('fs-extra');
const path = require('path');
const { startApp } = require('./helpers/app-process');

for (const multi_user_mode of [false, true]) {
    describe(`Download notifications after playback (${multi_user_mode ? 'multi' : 'single'}-user)`, function() {
        this.timeout(30000);
        let app;
        let token;
        const owner = multi_user_mode ? 'admin' : null;
        const notification = (uid, type, file_uid, user_uid = owner, read = false) => ({
            uid, type, user_uid, read, timestamp: 1, data: {file_uid}
        });
        const notifications = [
            notification('played-unread', 'download_complete', 'played'),
            notification('played-read', 'download_complete', 'played', owner, true),
            notification('unplayed', 'download_complete', 'unplayed'),
            notification('error', 'download_error', 'played'),
            notification('task', 'task_finished', 'played'),
            notification('other-owner', 'download_complete', 'played', 'someone-else')
        ];
        const post = route => app.api.post(route).query(token ? {jwt: token} : {});
        const storedNotifications = () => fs.readJSONSync(path.join(app.root, 'appdata', 'local_db.json')).notifications;

        before(async function() {
            app = await startApp({
                env: {ytdl_multi_user_mode: String(multi_user_mode)},
                prepare: async ({root}) => {
                    await fs.outputJSON(path.join(root, 'appdata', 'db.json'), {
                        simplified_db_migration_complete: true, new_db_system_migration_complete: true
                    });
                    await fs.outputJSON(path.join(root, 'appdata', 'local_db.json'), {
                        files: [{uid: 'played', user_uid: owner, local_view_count: 0, sharingEnabled: true}],
                        notifications
                    });
                }
            });
            if (multi_user_mode) {
                await app.api.post('/api/auth/register').send({userid: 'admin', username: 'admin', password: 'test-password'}).expect(200);
                token = (await app.api.post('/api/auth/login').send({username: 'admin', password: 'test-password'}).expect(200)).body.token;
            }
        });

        after(async function() {
            if (app) await app.stop();
        });

        it('leaves notifications intact if the file cannot be viewed', async function() {
            await post('/api/incrementViewCount').send({file_uid: 'missing'}).expect(404);
            assert.deepStrictEqual(storedNotifications(), notifications);
        });

        if (multi_user_mode) {
            it('leaves the owner\'s notifications intact when a guest plays a shared file', async function() {
                await app.api.post('/api/incrementViewCount').send({file_uid: 'played', uuid: owner}).expect(200);
                assert.deepStrictEqual(storedNotifications(), notifications);
            });
        }

        it('removes only the viewer\'s completed-download alerts for the played file', async function() {
            const response = await post('/api/incrementViewCount').send({file_uid: 'played'}).expect(200);
            assert.strictEqual(response.body.success, true);
            assert.deepStrictEqual(storedNotifications(), notifications.slice(2));
            const remaining = (await post('/api/getNotifications').send({}).expect(200)).body.notifications;
            assert.deepStrictEqual(remaining.map(note => note.uid).sort(), ['error', 'task', 'unplayed']);
        });

        it('can play again when the matching notifications are already gone', async function() {
            await post('/api/incrementViewCount').send({file_uid: 'played'}).expect(200);
            assert.deepStrictEqual(storedNotifications(), notifications.slice(2));
        });
    });
}
