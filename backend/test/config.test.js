/* eslint-disable no-undef */
const { assert, config_api } = require('./test-shared');

describe('Config', async function() {
    it('findChangedConfigItems', async function() {
        const old_config = {
            "YtdlMaterial": {
                "test_object1": {
                    "test_prop1": true,
                    "test_prop2": false
                },
                "test_object2": {
                    "test_prop3": {
                        "test_prop3_1": true,
                        "test_prop3_2": false
                    },
                    "test_prop4": false
                },
                "test_object3": {
                    "test_prop5": {
                        "test_prop5_1": true,
                        "test_prop5_2": false
                    },
                    "test_prop6": false
                }
            }
        };

        const new_config = {
            "YtdlMaterial": {
                "test_object1": {
                    "test_prop1": false,
                    "test_prop2": false
                },
                "test_object2": {
                    "test_prop3": {
                        "test_prop3_1": false,
                        "test_prop3_2": false
                    },
                    "test_prop4": true
                },
                "test_object3": {
                    "test_prop5": {
                        "test_prop5_1": true,
                        "test_prop5_2": false
                    },
                    "test_prop6": true
                }
            }
        };

        const changes = config_api.findChangedConfigItems(old_config, new_config);
        assert(changes[0]['key'] === 'test_prop1' && changes[0]['old_value'] === true && changes[0]['new_value'] === false);
        assert(changes[1]['key'] === 'test_prop3' &&
                changes[1]['old_value']['test_prop3_1'] === true &&
                changes[1]['new_value']['test_prop3_1'] === false &&
                changes[1]['old_value']['test_prop3_2'] === false &&
                changes[1]['new_value']['test_prop3_2'] === false);
        assert(changes[2]['key'] === 'test_prop4' && changes[2]['old_value'] === false && changes[2]['new_value'] === true);
        assert(changes[3]['key'] === 'test_prop6' && changes[3]['old_value'] === false && changes[3]['new_value'] === true);
    });
});

