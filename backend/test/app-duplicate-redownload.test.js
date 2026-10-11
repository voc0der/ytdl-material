const assert = require('assert');
const fs = require('fs-extra');
const path = require('path');
const {startApp} = require('./helpers/app-process');

describe('Duplicate retry through the server', function() {
    this.timeout(30000);
    let app, alice, bob, admin;

    before(async function() {
        app = await startApp({
            env: {ytdl_max_concurrent_downloads: '0', ytdl_multi_user_mode: 'true',
                ytdl_header_auth_enabled: 'true', ytdl_header_auth_trusted_proxies: '127.0.0.1, ::1',
                ytdl_header_auth_groups_header: 'Remote-Groups'},
            prepare: async ({root}) => {
                await fs.writeJSON(path.join(root, 'appdata', 'db.json'), {
                    simplified_db_migration_complete: true, new_db_system_migration_complete: true
                });
                await fs.writeJSON(path.join(root, 'appdata', 'local_db.json'), {
                    files: [{uid: 'original', user_uid: 'alice', isAudio: false}],
                    roles: [{key: 'viewer', permissions: []}],
                    download_queue: ['copy', 'overwrite', 'restricted'].map(uid => ({uid, user_uid: 'alice',
                        finished: true, duplicate_skip_only: true, file_uids: ['original'],
                        url: 'https://example.com/clip', type: 'video', options: {maxHeight: '720'}}))
                });
            }
        });
        const login = async (user, groups = '') => (await app.api.post('/api/auth/header/login')
            .set('Remote-User', user).set('Remote-Groups', groups).expect(200)).body.token;
        alice = await login('alice');
        bob = await login('bob');
        admin = await login('admin', 'admin');
    });

    after(async function() {
        if (app) await app.stop();
    });

    it('requires authentication and ownership, and validates the action', async function() {
        await app.api.post('/api/retryDuplicateDownload').send({download_uid: 'overwrite', action: 'overwrite'}).expect(401);
        await app.api.post('/api/retryDuplicateDownload').query({jwt: bob})
            .send({download_uid: 'overwrite', action: 'overwrite'}).expect(400);
        await app.api.post('/api/retryDuplicateDownload').query({jwt: alice})
            .send({download_uid: 'overwrite', action: 'delete'}).expect(400);
    });

    it('queues an overwrite with stored options and rejects reusing the same skip', async function() {
        const res = await app.api.post('/api/retryDuplicateDownload').query({jwt: alice})
            .send({download_uid: 'overwrite', action: 'overwrite'}).expect(200);
        assert.strictEqual(res.body.download.user_uid, 'alice');
        assert.strictEqual(res.body.download.options.maxHeight, '720');
        assert.strictEqual(res.body.download.options.replaceFileUID, 'original');
        await app.api.post('/api/retryDuplicateDownload').query({jwt: alice})
            .send({download_uid: 'overwrite', action: 'overwrite'}).expect(400);
    });

    it('requires file management for overwrite but still allows keeping a copy', async function() {
        await app.api.post('/api/updateUser').query({jwt: admin})
            .send({change_object: {uid: 'alice', role: 'viewer'}}).expect(200);
        await app.api.post('/api/retryDuplicateDownload').query({jwt: alice})
            .send({download_uid: 'restricted', action: 'overwrite'}).expect(403);
        const res = await app.api.post('/api/retryDuplicateDownload').query({jwt: alice})
            .send({download_uid: 'copy', action: 'copy'}).expect(200);
        assert.strictEqual(res.body.download.options.duplicateAction, 'copy');
        assert.strictEqual(res.body.download.options.replaceFileUID, null);
    });
});
