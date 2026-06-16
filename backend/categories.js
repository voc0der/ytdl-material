const utils = require('./utils');
const logger = require('./logger');
const db_api = require('./db');
const path = require('path');
const { v4: uuid } = require('uuid');
/*

Categories:

    Categories are a way to organize videos based on dynamic rules set by the user. Categories are universal (so not per-user).
    
    Categories, besides rules, have an optional custom output. This custom output can help users create their
        desired directory structure.

Rules:
    A category rule consists of a property, a comparison, and a value. For example, "uploader includes 'VEVO'"

    Rules are stored as an object with the above fields. In addition to those fields, it also has a preceding_operator, which
        is either OR or AND, and signifies whether the rule should be ANDed with the previous rules, or just ORed. For the first
        rule, this field is null.

    Ex. (title includes 'Rihanna' OR title includes 'Beyonce' AND uploader includes 'VEVO')

*/

const DEFAULT_CATEGORY_TEMPLATES = [
    {
        name: 'Music',
        rules: [
            rule('categories', 'includes', 'Music'),
            rule('uploader', 'includes', 'VEVO'),
            rule('fulltitle', 'includes', 'official music video'),
            rule('fulltitle', 'includes', 'live performance'),
            rule('fulltitle', 'includes', 'lyric video'),
            rule('tags', 'includes', 'music')
        ]
    },
    {
        name: 'Technology',
        rules: [
            rule('categories', 'includes', 'Science & Technology'),
            rule('uploader', 'includes', 'MKBHD'),
            rule('uploader', 'includes', 'Linus Tech Tips'),
            rule('fulltitle', 'includes', 'tech review'),
            rule('fulltitle', 'includes', 'phone review'),
            rule('fulltitle', 'includes', 'laptop review'),
            rule('fulltitle', 'includes', 'PC build'),
            rule('fulltitle', 'includes', 'computer setup')
        ]
    },
    {
        name: 'Sports',
        rules: [
            rule('categories', 'includes', 'Sports'),
            rule('fulltitle', 'includes', 'sports highlights'),
            rule('fulltitle', 'includes', 'match highlights'),
            rule('fulltitle', 'includes', 'game recap'),
            rule('fulltitle', 'includes', 'postgame'),
            rule('uploader', 'includes', 'ESPN')
        ]
    },
    {
        name: 'Documentary',
        rules: [
            rule('fulltitle', 'includes', 'documentary'),
            rule('fulltitle', 'includes', 'full documentary'),
            rule('fulltitle', 'includes', 'explained')
        ]
    },
    {
        name: 'Education',
        rules: [
            rule('categories', 'includes', 'Education'),
            rule('fulltitle', 'includes', 'tutorial'),
            rule('fulltitle', 'includes', 'course'),
            rule('fulltitle', 'includes', 'lecture'),
            rule('fulltitle', 'includes', 'how to')
        ]
    },
    {
        name: 'News',
        rules: [
            rule('categories', 'includes', 'News & Politics'),
            rule('uploader', 'includes', 'BBC News'),
            rule('uploader', 'includes', 'PBS NewsHour'),
            rule('uploader', 'includes', 'Reuters'),
            rule('fulltitle', 'includes', 'breaking news')
        ]
    },
    {
        name: 'Gaming',
        rules: [
            rule('categories', 'includes', 'Gaming'),
            rule('fulltitle', 'includes', 'gameplay'),
            rule('fulltitle', 'includes', 'walkthrough'),
            rule('fulltitle', 'includes', 'lets play'),
            rule('fulltitle', 'includes', 'let\'s play'),
            rule('uploader', 'includes', 'IGN')
        ]
    },
    {
        name: 'Entertainment',
        rules: [
            rule('categories', 'includes', 'Entertainment'),
            rule('fulltitle', 'includes', 'behind the scenes'),
            rule('fulltitle', 'includes', 'reaction')
        ]
    },
    {
        name: 'Film & TV',
        rules: [
            rule('categories', 'includes', 'Film & Animation'),
            rule('fulltitle', 'includes', 'movie'),
            rule('fulltitle', 'includes', 'film'),
            rule('fulltitle', 'includes', 'tv show'),
            rule('fulltitle', 'includes', 'trailer')
        ]
    },
    {
        name: 'Comedy',
        rules: [
            rule('categories', 'includes', 'Comedy'),
            rule('fulltitle', 'includes', 'comedy'),
            rule('fulltitle', 'includes', 'stand up'),
            rule('fulltitle', 'includes', 'stand-up'),
            rule('fulltitle', 'includes', 'sketch')
        ]
    },
    {
        name: 'Podcasts & Interviews',
        rules: [
            rule('fulltitle', 'includes', 'podcast'),
            rule('fulltitle', 'includes', 'interview'),
            rule('fulltitle', 'includes', 'conversation')
        ]
    },
    {
        name: 'Cooking',
        rules: [
            rule('fulltitle', 'includes', 'recipe'),
            rule('fulltitle', 'includes', 'cooking'),
            rule('fulltitle', 'includes', 'bake'),
            rule('tags', 'includes', 'cooking'),
            rule('uploader', 'includes', 'Bon App')
        ]
    },
    {
        name: 'Travel',
        rules: [
            rule('categories', 'includes', 'Travel & Events'),
            rule('fulltitle', 'includes', 'travel'),
            rule('fulltitle', 'includes', 'travel vlog'),
            rule('fulltitle', 'includes', 'city guide')
        ]
    },
    {
        name: 'Fitness',
        rules: [
            rule('fulltitle', 'includes', 'workout'),
            rule('fulltitle', 'includes', 'exercise'),
            rule('fulltitle', 'includes', 'fitness'),
            rule('tags', 'includes', 'fitness')
        ]
    },
    {
        name: 'DIY',
        rules: [
            rule('fulltitle', 'includes', 'diy'),
            rule('fulltitle', 'includes', 'repair'),
            rule('fulltitle', 'includes', 'build'),
            rule('tags', 'includes', 'diy')
        ]
    }
];

const RULE_PROPERTY_ALIASES = {
    fulltitle: ['fulltitle', 'title'],
    webpage_url: ['webpage_url', 'url'],
    _filename: ['_filename', 'path'],
    id: ['id', 'source_id', 'uid'],
    categories: ['categories']
};

function rule(property, comparator, value, preceding_operator = 'or') {
    return {
        preceding_operator: preceding_operator,
        property: property,
        comparator: comparator,
        value: value
    };
}

function cloneDefaultCategoryTemplate(category) {
    return {
        name: category.name,
        uid: uuid(),
        rules: category.rules.map((category_rule, index) => ({
            ...category_rule,
            preceding_operator: index === 0 ? null : category_rule.preceding_operator
        })),
        show_as_filter: false,
        custom_output: ''
    };
}

async function categorize(file_jsons) {
    // to make the logic easier, let's assume the file metadata is an array
    if (!Array.isArray(file_jsons)) file_jsons = [file_jsons];

    const categories = await getCategories();
    if (!categories) {
        logger.warn('Categories could not be found.');
        return null;
    }

    return getCategoryForMetadata(file_jsons, categories);
}

function getCategoryForMetadata(file_jsons, categories) {
    let selected_category = null;
    if (!Array.isArray(file_jsons)) file_jsons = [file_jsons];
    if (!Array.isArray(categories) || categories.length === 0) return null;

    for (const file_json of file_jsons) {
        for (const category of categories) {
            const rules = category['rules'];
            if (!Array.isArray(rules) || rules.length === 0) continue;
    
            // if rules for current category apply, then that is the selected category
            if (applyCategoryRules(file_json, rules, category['name'])) {
                selected_category = category;
                logger.verbose(`Selected category ${category['name']} for ${file_json['webpage_url']}`);
                return selected_category;
            }
        }
    }
    
    return selected_category;
}

async function getCategories() {
    const categories = await db_api.getRecords('categories');
    return categories ? categories : null;
}

function getDefaultCategories() {
    return DEFAULT_CATEGORY_TEMPLATES.map(cloneDefaultCategoryTemplate);
}

async function createDefaultCategories() {
    const categories = getDefaultCategories();
    await db_api.insertRecordsIntoTable('categories', categories);
    return categories;
}

async function getCategoriesAsPlaylists() {
    const categories_as_playlists = [];
    const available_categories = await getCategories();
    if (!available_categories || available_categories.length === 0) return categories_as_playlists;

    const category_uids = available_categories.map(category => category['uid']).filter(Boolean);
    if (category_uids.length === 0) return categories_as_playlists;

    const categorized_files = await db_api.getRecords('files', {'category.uid': {$in: category_uids}});
    if (!categorized_files || categorized_files.length === 0) return categories_as_playlists;

    const files_by_category_uid = new Map();
    for (const categorized_file of categorized_files) {
        const category_uid = categorized_file?.category?.uid;
        if (!category_uid) continue;

        if (!files_by_category_uid.has(category_uid)) {
            files_by_category_uid.set(category_uid, []);
        }
        files_by_category_uid.get(category_uid).push(categorized_file);
    }

    for (const category of available_categories) {
        const files_that_match = files_by_category_uid.get(category['uid']);
        if (!files_that_match || files_that_match.length === 0) continue;

        const category_playlist = {...category};
        category_playlist['thumbnailURL'] = files_that_match[0].thumbnailURL;
        category_playlist['thumbnailPath'] = files_that_match[0].thumbnailPath;
        category_playlist['duration'] = files_that_match.reduce((a, b) => a + utils.durationStringToNumber(b.duration), 0);
        category_playlist['id'] = category_playlist['uid'];
        category_playlist['auto'] = true;
        categories_as_playlists.push(category_playlist);
    }

    return categories_as_playlists;
}

function applyCategoryRules(file_json, rules, category_name) {
    let rules_apply = false;
    for (let i = 0; i < rules.length; i++) {
        const rule = rules[i];
        let rule_applies = null;

        let preceding_operator = rule['preceding_operator'];

        switch (rule['comparator']) {
            case 'includes':
                rule_applies = valueIncludes(getRulePropertyValue(file_json, rule['property']), rule['value']);
                break;
            case 'not_includes':
                rule_applies = !valueIncludes(getRulePropertyValue(file_json, rule['property']), rule['value']);
                break;
            case 'equals':
                rule_applies = valueEquals(getRulePropertyValue(file_json, rule['property']), rule['value']);
                break;
            case 'not_equals':
                rule_applies = !valueEquals(getRulePropertyValue(file_json, rule['property']), rule['value']);
                break;
            default:
                logger.warn(`Invalid comparison used for category ${category_name}`)
                break;
        }

        // OR the first rule with rules_apply, which will be initially false
        if (i === 0) preceding_operator = 'or';

        // update rules_apply based on current rule
        if (preceding_operator === 'or')
            rules_apply = rules_apply || rule_applies;
        else
            rules_apply = rules_apply && rule_applies;
    }

    return rules_apply;
}

function getRulePropertyValue(file_json, property) {
    if (!file_json || !property) return null;
    const aliases = RULE_PROPERTY_ALIASES[property] || [property];

    for (const candidate_property of aliases) {
        const value = file_json[candidate_property];
        if (value !== undefined && value !== null) return value;
    }

    return null;
}

function normalizeComparableValues(value) {
    if (value === undefined || value === null) return [];
    if (Array.isArray(value)) return value.flatMap(normalizeComparableValues);
    if (typeof value === 'object') return [JSON.stringify(value)];
    return [String(value)];
}

function normalizeRuleValue(value) {
    if (value === undefined || value === null) return '';
    return String(value).trim();
}

function valueIncludes(value, rule_value) {
    const normalized_rule_value = normalizeRuleValue(rule_value);
    if (!normalized_rule_value) return false;

    const lower_rule_value = normalized_rule_value.toLowerCase();
    return normalizeComparableValues(value)
        .some(candidate => candidate.toLowerCase().includes(lower_rule_value));
}

function valueEquals(value, rule_value) {
    const normalized_rule_value = normalizeRuleValue(rule_value);
    if (!normalized_rule_value) return false;

    return normalizeComparableValues(value)
        .some(candidate => candidate === normalized_rule_value);
}

function buildMetadataForFile(file_obj = {}) {
    const type = file_obj.isAudio ? 'audio' : 'video';
    const sidecar_metadata = file_obj.path ? utils.getJSON(file_obj.path, type) : null;
    const metadata = sidecar_metadata && typeof sidecar_metadata === 'object' ? sidecar_metadata : {};
    const merged_metadata = {
        ...file_obj,
        ...metadata,
        title: metadata.title || file_obj.title,
        fulltitle: metadata.fulltitle || metadata.title || file_obj.title,
        webpage_url: metadata.webpage_url || file_obj.url,
        url: metadata.webpage_url || metadata.url || file_obj.url,
        uploader: metadata.uploader || file_obj.uploader,
        view_count: metadata.view_count || file_obj.view_count,
        _filename: metadata._filename || file_obj.path,
        path: file_obj.path || metadata._filename
    };

    if (!merged_metadata.id) merged_metadata.id = file_obj.source_id || file_obj.id || file_obj.uid;
    if (!merged_metadata._filename && file_obj.path) merged_metadata._filename = path.basename(file_obj.path);

    return merged_metadata;
}

async function applyCategoriesToExistingFiles() {
    const categories = await getCategories();
    const files = await db_api.getRecords('files') || [];
    let categorized_count = 0;
    let uncategorized_count = 0;

    for (const file_obj of files) {
        const category = getCategoryForMetadata(buildMetadataForFile(file_obj), categories);
        const stripped_category = category ? {name: category['name'], uid: category['uid']} : null;
        await db_api.updateRecord('files', {uid: file_obj.uid}, {category: stripped_category});

        if (stripped_category) categorized_count++;
        else uncategorized_count++;
    }

    logger.info(`Applied categories to ${files.length} existing files (${categorized_count} categorized, ${uncategorized_count} uncategorized).`);
    return {
        file_count: files.length,
        categorized_count: categorized_count,
        uncategorized_count: uncategorized_count
    };
}

// async function addTagToVideo(tag, video, user_uid) {
//     // TODO: Implement
// }

// async function removeTagFromVideo(tag, video, user_uid) {
//     // TODO: Implement
// }

// // adds tag to list of existing tags (used for tag suggestions)
// async function addTagToExistingTags(tag) {
//     const existing_tags = db.get('tags').value();
//     if (!existing_tags.includes(tag)) {
//         db.get('tags').push(tag).write();
//     }
// }

module.exports = {
    categorize: categorize,
    getCategories: getCategories,
    getDefaultCategories: getDefaultCategories,
    createDefaultCategories: createDefaultCategories,
    getCategoriesAsPlaylists: getCategoriesAsPlaylists,
    applyCategoriesToExistingFiles: applyCategoriesToExistingFiles,
    _applyCategoryRules: applyCategoryRules
}
