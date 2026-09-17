const { assert, config_api, fs, path, test_config_path } = require('./test-shared');

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

    it('Strips the retired extractor client fallback setting on initialize', async function() {
        const config_json = config_api.getConfigFile();
        config_json['YtdlMaterial']['Downloader']['use_extractor_client_fallback'] = true;
        config_api.setConfigFile(config_json);

        config_api.initialize();

        const updated_config = config_api.getConfigFile();
        assert(!('use_extractor_client_fallback' in updated_config['YtdlMaterial']['Downloader']));
    });

    it('Strips the retired allow advanced download setting on initialize', async function() {
        const config_json = config_api.getConfigFile();
        // stored as false, which is the value that changes behavior now that it is removed
        config_json['YtdlMaterial']['Advanced']['allow_advanced_download'] = false;
        config_api.setConfigFile(config_json);

        config_api.initialize();

        const updated_config = config_api.getConfigFile();
        assert(!('allow_advanced_download' in updated_config['YtdlMaterial']['Advanced']));
    });

    it('Strips the retired shared API key settings on initialize', async function() {
        const config_json = config_api.getConfigFile();
        config_json['YtdlMaterial']['API']['use_API_key'] = true;
        config_json['YtdlMaterial']['API']['API_key'] = 'retired-key';
        config_api.setConfigFile(config_json);

        config_api.initialize();

        const api_config = config_api.getConfigFile()['YtdlMaterial']['API'];
        assert(!('use_API_key' in api_config));
        assert(!('API_key' in api_config));
    });

    it('Switches a retired youtube-dlc downloader to yt-dlp on initialize', async function() {
        const config_json = config_api.getConfigFile();
        config_json['YtdlMaterial']['Advanced']['default_downloader'] = 'youtube-dlc';
        config_api.setConfigFile(config_json);

        config_api.initialize();

        assert.strictEqual(config_api.getConfigItem('ytdl_default_downloader'), 'yt-dlp');
    });

    it('Keeps a supported downloader selection on initialize', async function() {
        const config_json = config_api.getConfigFile();
        const original_downloader = config_json['YtdlMaterial']['Advanced']['default_downloader'];
        config_json['YtdlMaterial']['Advanced']['default_downloader'] = 'youtube-dl';
        config_api.setConfigFile(config_json);

        try {
            config_api.initialize();
            assert.strictEqual(config_api.getConfigItem('ytdl_default_downloader'), 'youtube-dl');
        } finally {
            config_api.setConfigItem('ytdl_default_downloader', original_downloader);
        }
    });

    /*************************************************
     * Every write goes through the whole config
     * document, so a run pointed at the shipped file
     * leaves whatever a test last set in it. That is
     * how max_concurrent_downloads came to be 0 in
     * the tracked config, which stops the download
     * queue from starting anything at all.
     ************************************************/
    it('Writes settings to the configured file rather than the one that ships with the app', async function() {
        const shipped_config_path = path.join(__dirname, '..', 'appdata', 'default.json');
        const shipped_before = fs.readFileSync(shipped_config_path, 'utf8');
        const original_value = config_api.getConfigItem('ytdl_max_concurrent_downloads');

        try {
            config_api.setConfigItem('ytdl_max_concurrent_downloads', 0);

            assert.strictEqual(fs.readFileSync(shipped_config_path, 'utf8'), shipped_before);
            assert.notStrictEqual(shipped_config_path, test_config_path);
            const written = JSON.parse(fs.readFileSync(test_config_path, 'utf8'));
            assert.strictEqual(written['YtdlMaterial']['Downloader']['max_concurrent_downloads'], 0);
        } finally {
            config_api.setConfigItem('ytdl_max_concurrent_downloads', original_value);
        }
    });

    it('Ships a config that lets downloads run', async function() {
        const shipped_config = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'appdata', 'default.json'), 'utf8'));
        const max_concurrent_downloads = shipped_config['YtdlMaterial']['Downloader']['max_concurrent_downloads'];

        // 0 is a limit of none, not "no limit": -1 is what means unlimited.
        assert(max_concurrent_downloads === -1 || max_concurrent_downloads > 0,
            `the shipped config allows ${max_concurrent_downloads} concurrent downloads`);
    });

    it('Leaves the config alone when no retired settings are stored', async function() {
        config_api.initialize();
        const before = JSON.stringify(config_api.getConfigFile());

        config_api.initialize();

        assert.strictEqual(JSON.stringify(config_api.getConfigFile()), before);
    });
});
