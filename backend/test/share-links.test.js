const express = require('express');
const request = require('supertest');

const { assert, config_api, db_api, files_api } = require('./test-shared');
const share_links = require('../share-links');

const SHARE_ID_SHAPE = /^[A-Za-z0-9]{11}$/;

describe('Short share links', function() {
    const original_getConfigItem = config_api.getConfigItem;
    let multi_user_mode = false;

    const FILE = {uid: 'share_link_file', share_id: 'FileLink123', user_uid: 'share_link_owner', title: 'A file', duration: 10};
    const PLAYLIST = {id: 'share_link_playlist', share_id: 'ListLink123', user_uid: 'share_link_owner', name: 'A playlist', uids: []};

    async function clear() {
        await db_api.removeAllRecords('files', {user_uid: 'share_link_owner'});
        await db_api.removeAllRecords('playlists', {user_uid: 'share_link_owner'});
    }

    before(function() {
        config_api.getConfigItem = (key) => key === 'ytdl_multi_user_mode' ? multi_user_mode : original_getConfigItem(key);
    });

    after(async function() {
        config_api.getConfigItem = original_getConfigItem;
        await clear();
    });

    beforeEach(async function() {
        multi_user_mode = false;
        await clear();
        await db_api.insertRecordIntoTable('files', {...FILE});
        await db_api.insertRecordIntoTable('playlists', {...PLAYLIST});
    });

    describe('ids', function() {
        it('draws eleven letters and digits, a different id every time', function() {
            const drawn = new Set();
            for (let i = 0; i < 1000; i++) {
                const share_id = share_links.generateShareId();
                assert.match(share_id, SHARE_ID_SHAPE);
                assert(share_links.isShareId(share_id));
                drawn.add(share_id);
            }
            assert.strictEqual(drawn.size, 1000);
        });

        it('takes nothing else for one', function() {
            for (const value of ['FileLink12', 'FileLink1234', 'FileLink-12', 'File_Link12', '../FileLink', '', null, undefined, ['FileLink123']]) {
                assert.strictEqual(share_links.isShareId(value), false, `${JSON.stringify(value)} is not an id`);
            }
        });

        it('gives a new playlist one', async function() {
            const playlist = await files_api.createPlaylist('New', [FILE.uid], 'share_link_owner');
            assert.match(playlist.share_id, SHARE_ID_SHAPE);
            assert.strictEqual((await db_api.getRecord('playlists', {id: playlist.id})).share_id, playlist.share_id);
        });

        it('gives records without one an id, and leaves the rest as they are', async function() {
            await db_api.insertRecordIntoTable('files', {uid: 'share_link_old_file', user_uid: 'share_link_owner'});
            await db_api.insertRecordIntoTable('playlists', {id: 'share_link_old_playlist', user_uid: 'share_link_owner', name: 'Old', uids: []});

            assert(await share_links.assignMissingShareIds() >= 2);

            const old_file = await db_api.getRecord('files', {uid: 'share_link_old_file'});
            const old_playlist = await db_api.getRecord('playlists', {id: 'share_link_old_playlist'});
            assert.match(old_file.share_id, SHARE_ID_SHAPE);
            assert.match(old_playlist.share_id, SHARE_ID_SHAPE);
            assert.notStrictEqual(old_file.share_id, old_playlist.share_id);
            assert.strictEqual((await db_api.getRecord('files', {uid: FILE.uid})).share_id, FILE.share_id);
            assert.strictEqual((await db_api.getRecord('playlists', {id: PLAYLIST.id})).share_id, PLAYLIST.share_id);

            // Every record has one now, so there is nothing left to do.
            assert.strictEqual(await share_links.assignMissingShareIds(), 0);
            assert.strictEqual((await db_api.getRecord('files', {uid: 'share_link_old_file'})).share_id, old_file.share_id);
        });
    });

    describe('where a link goes', function() {
        it('opens a file or a playlist in the player', async function() {
            assert.strictEqual(await share_links.resolveShareLink(FILE.share_id), `/player;uid=${FILE.uid}`);
            assert.strictEqual(await share_links.resolveShareLink(PLAYLIST.share_id), `/player;playlist_id=${PLAYLIST.id}`);
        });

        it('starts at the time it is given', async function() {
            assert.strictEqual(await share_links.resolveShareLink(FILE.share_id, 90), `/player;uid=${FILE.uid};timestamp=90`);
        });

        it('names the owner for a share in multi-user mode, and only then', async function() {
            multi_user_mode = true;
            assert.strictEqual(await share_links.resolveShareLink(FILE.share_id), `/player;uid=${FILE.uid}`);

            await db_api.updateRecord('files', {uid: FILE.uid}, {sharingEnabled: true});
            await db_api.updateRecord('playlists', {id: PLAYLIST.id}, {sharingEnabled: true});
            assert.strictEqual(await share_links.resolveShareLink(FILE.share_id), `/player;uid=${FILE.uid};uuid=share_link_owner`);
            assert.strictEqual(await share_links.resolveShareLink(PLAYLIST.share_id), `/player;playlist_id=${PLAYLIST.id};uuid=share_link_owner`);

            // Single-user mode finds the file without one.
            multi_user_mode = false;
            assert.strictEqual(await share_links.resolveShareLink(FILE.share_id), `/player;uid=${FILE.uid}`);
        });

        it('goes nowhere for an id nothing has', async function() {
            assert.strictEqual(await share_links.resolveShareLink('NoSuchLink1'), null);
            assert.strictEqual(await share_links.resolveShareLink('not an id'), null);
        });

        it('reads a start time in seconds, and ignores anything else', function() {
            assert.strictEqual(share_links.parseStartTime('90'), 90);
            assert.strictEqual(share_links.parseStartTime('90.5'), 90.5);
            for (const value of ['0', '-5', '1e3', '1:30', 'abc', '', ['1', '2'], undefined]) {
                assert.strictEqual(share_links.parseStartTime(value), null, `${JSON.stringify(value)} is not a start time`);
            }
        });
    });

    describe('the route', function() {
        const app = express();
        app.get('/s/:share_id', share_links.redirect);

        it('redirects to the player at the address the link was opened at', async function() {
            const res = await request(app).get(`/s/${FILE.share_id}`).expect(302);
            assert.strictEqual(res.headers.location, `../#/player;uid=${FILE.uid}`);

            const with_slash = await request(app).get(`/s/${FILE.share_id}/`).expect(302);
            assert.strictEqual(with_slash.headers.location, `../../#/player;uid=${FILE.uid}`);
        });

        it('passes a start time on, and drops one it cannot read', async function() {
            const timed = await request(app).get(`/s/${FILE.share_id}`).query({t: '90'}).expect(302);
            assert.strictEqual(timed.headers.location, `../#/player;uid=${FILE.uid};timestamp=90`);

            const unreadable = await request(app).get(`/s/${FILE.share_id}`).query({t: 'soon'}).expect(302);
            assert.strictEqual(unreadable.headers.location, `../#/player;uid=${FILE.uid}`);
        });

        it('answers a link to nothing with a 404', async function() {
            await request(app).get('/s/NoSuchLink1').expect(404);
            await request(app).get('/s/short').expect(404);
        });
    });
});
