/* eslint-disable no-undef */
const { assert, path, fs, uuid, db_api, subscriptions_api } = require('./test-shared');

describe('Subscriptions', function() {
    const new_sub = {
        name: 'test_sub',
        url: 'https://www.youtube.com/channel/UCzofo-P8yMMCOv8rsPfIR-g',
        maxQuality: null,
        id: uuid(),
        user_uid: null,
        type: 'video',
        paused: true
    };
    beforeEach(async function() {
        await db_api.removeAllRecords('subscriptions');
    });
    it('Subscribe', async function () {
        const success = await subscriptions_api.subscribe(new_sub, null, true);
        assert(success);
        const sub_exists = await db_api.getRecord('subscriptions', {id: new_sub['id']});
        assert(sub_exists);
    });
    it('Unsubscribe', async function () {
        await subscriptions_api.subscribe(new_sub, null, true);
        await subscriptions_api.unsubscribe(new_sub);
        const sub_exists = await db_api.getRecord('subscriptions', {id: new_sub['id']});
        assert(!sub_exists);
    });
    it('Delete subscription file', async function () {
        
    });
    it('Get subscription by name', async function () {
        await subscriptions_api.subscribe(new_sub, null, true);
        const sub_by_name = await subscriptions_api.getSubscriptionByName('test_sub');
        assert(sub_by_name);
    });
    it('Get subscriptions', async function() {
        await subscriptions_api.subscribe(new_sub, null, true);
        const subs = await subscriptions_api.getSubscriptions(null);
        assert(subs && subs.length === 1);
    });
    it('Update subscription', async function () {
        await subscriptions_api.subscribe(new_sub, null, true);
        const sub_update = Object.assign({}, new_sub, {name: 'updated_name'});
        await subscriptions_api.updateSubscription(sub_update);
        const updated_sub = await db_api.getRecord('subscriptions', {id: new_sub['id']});
        assert(updated_sub['name'] === 'updated_name');
    });
    it('Update subscription property', async function () {
        await subscriptions_api.subscribe(new_sub, null, true);
        const sub_update = Object.assign({}, new_sub, {name: 'updated_name'});
        await subscriptions_api.updateSubscriptionPropertyMultiple([sub_update], {name: 'updated_name'});
        const updated_sub = await db_api.getRecord('subscriptions', {id: new_sub['id']});
        assert(updated_sub['name'] === 'updated_name');
    });
    it('Write subscription metadata', async function() {
        const metadata_path = path.join('subscriptions', 'channels', 'test_sub', 'subscription_backup.json');
        if (fs.existsSync(metadata_path)) fs.unlinkSync(metadata_path);
        await subscriptions_api.subscribe(new_sub, null, true);
        assert(fs.existsSync(metadata_path));
    });
    it('Fresh uploads', async function() {

    });
});
