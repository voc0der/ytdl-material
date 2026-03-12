/* eslint-disable no-undef */
const {
    assert,
    fs,
    auth_api,
    db_api,
    utils,
    subscriptions_api,
    files_api,
    sample_video_json
} = require('./test-shared');

describe('Multi User', async function() {
    this.timeout(120000);
    const user_to_test = 'test_user';
    const user_password = 'test_pass';
    const sub_to_test = '';
    const playlist_to_test = '';
    beforeEach(async function() {
        // await db_api.connectToDB();
        await auth_api.deleteUser(user_to_test);
    });
    describe('Basic', function() {
        it('Register', async function() {
            const user = await auth_api.registerUser(user_to_test, user_to_test, user_password);
            assert(user);
        });
        it('Login', async function() {
            await auth_api.registerUser(user_to_test, user_to_test, user_password);
            const user = await auth_api.login(user_to_test, user_password);
            assert(user);
        });
    });
    describe('Video player - normal', async function() {
        beforeEach(async function() {
            await db_api.removeRecord('files', {uid: sample_video_json['uid']});
            await db_api.insertRecordIntoTable('files', sample_video_json);
        });
        const video_to_test = sample_video_json['uid'];
        it('Get video', async function() {
            const video_obj = await files_api.getVideo(video_to_test);
            assert(video_obj);
        });

        it('Video access - disallowed', async function() {
            await db_api.setVideoProperty(video_to_test, {sharingEnabled: false});
            const video_obj = await auth_api.getUserVideo(user_to_test, video_to_test, true);
            assert(!video_obj);
        });

        it('Video access - allowed', async function() {
            await db_api.setVideoProperty(video_to_test, {sharingEnabled: true}, user_to_test);
            const video_obj = await auth_api.getUserVideo(user_to_test, video_to_test, true);
            assert(video_obj);
        });
    });
    describe.skip('Zip generators', function() {
        it('Playlist zip generator', async function() {
            const playlist = await files_api.getPlaylist(playlist_to_test, user_to_test);
            assert(playlist);
            const playlist_files_to_download = [];
            for (let i = 0; i < playlist['uids'].length; i++) {
                const uid = playlist['uids'][i];
                const playlist_file = await files_api.getVideo(uid, user_to_test);
                playlist_files_to_download.push(playlist_file);
            }
            const zip_path = await utils.createContainerZipFile(playlist, playlist_files_to_download);
            const zip_exists = fs.pathExistsSync(zip_path);
            assert(zip_exists);
            if (zip_exists) fs.unlinkSync(zip_path);
        });

        it('Subscription zip generator', async function() {
            const sub = await subscriptions_api.getSubscription(sub_to_test.id, user_to_test);
            const sub_videos = await db_api.getRecords('files', {sub_id: sub.id});
            assert(sub);
            const sub_files_to_download = [];
            for (let i = 0; i < sub_videos.length; i++) {
                const sub_file = sub_videos[i];
                sub_files_to_download.push(sub_file);
            }
            const zip_path = await utils.createContainerZipFile(sub, sub_files_to_download);
            const zip_exists = fs.pathExistsSync(zip_path);
            assert(zip_exists);
            if (zip_exists) fs.unlinkSync(zip_path);
        });
    });
    // describe('Video player - subscription', function() {
    //     const sub_to_test = '';
    //     const video_to_test = 'ebbcfffb-d6f1-4510-ad25-d1ec82e0477e';
    //     it('Get video', async function() {
    //         const video_obj = files_api.getVideo(video_to_test, 'admin', );
    //         assert(video_obj);
    //     });

    //     it('Video access - disallowed', async function() {
    //         await db_api.setVideoProperty(video_to_test, {sharingEnabled: false}, user_to_test, sub_to_test);
    //         const video_obj = auth_api.getUserVideo('admin', video_to_test, true);
    //         assert(!video_obj);
    //     });

    //     it('Video access - allowed', async function() {
    //         await db_api.setVideoProperty(video_to_test, {sharingEnabled: true}, user_to_test, sub_to_test);
    //         const video_obj = auth_api.getUserVideo('admin', video_to_test, true);
    //         assert(video_obj);
    //     });
    // });

});
    
