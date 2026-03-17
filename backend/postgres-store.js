const fs = require('fs');
const _ = require('lodash');

const BLOCKED_OBJECT_KEYS = new Set(['__proto__', 'prototype', 'constructor']);
const NUMERIC_PATTERN = '^-?[0-9]+(\\.[0-9]+)?$';

function createDefaultPoolFactory() {
    return (config) => {
        const { Pool } = require('pg');
        return new Pool(config);
    };
}

let poolFactory = createDefaultPoolFactory();

function quoteIdentifier(identifier) {
    if (typeof identifier !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(identifier)) {
        throw new Error(`Unsafe SQL identifier '${identifier}'.`);
    }
    return `"${identifier}"`;
}

function sanitizeIndexName(name) {
    return name.replace(/[^A-Za-z0-9_]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 63) || 'idx';
}

function validateFieldPath(fieldPath) {
    if (typeof fieldPath !== 'string' || fieldPath.length === 0) {
        throw new Error('Field path must be a non-empty string.');
    }

    const pathParts = fieldPath.split('.');
    for (const part of pathParts) {
        if (!part || !/^[A-Za-z0-9_]+$/.test(part) || part.startsWith('$') || BLOCKED_OBJECT_KEYS.has(part)) {
            throw new Error(`Unsafe field path '${fieldPath}'.`);
        }
    }
}

function getFieldPathParts(fieldPath) {
    validateFieldPath(fieldPath);
    return fieldPath.split('.');
}

function toPathLiteral(pathParts = []) {
    return `'{${pathParts.join(',')}}'`;
}

function addParam(params, value) {
    params.push(value);
    return `$${params.length}`;
}

function getPrimaryKey(tableMeta = {}) {
    return tableMeta.primary_key || null;
}

function getDocKeyPath(tableMeta = {}) {
    const primaryKey = getPrimaryKey(tableMeta);
    return primaryKey ? toPathLiteral(getFieldPathParts(primaryKey)) : null;
}

function getFieldType(tableMeta = {}, fieldPath, value = undefined) {
    const hintedType = tableMeta.field_types && tableMeta.field_types[fieldPath];
    if (hintedType) return hintedType;
    if (typeof value === 'number') return 'numeric';
    if (typeof value === 'boolean') return 'boolean';
    return 'text';
}

function buildIndexJsonbExpr(tableMeta, fieldPath, docRef = 'doc') {
    const primaryKey = getPrimaryKey(tableMeta);
    if (fieldPath === primaryKey) return `to_jsonb(doc_key)`;

    return `${docRef} #> ${toPathLiteral(getFieldPathParts(fieldPath))}`;
}

function buildIndexTextExpr(tableMeta, fieldPath, docRef = 'doc') {
    const primaryKey = getPrimaryKey(tableMeta);
    if (fieldPath === primaryKey) return `doc_key`;

    return `${docRef} #>> ${toPathLiteral(getFieldPathParts(fieldPath))}`;
}

function buildIndexNumericExpr(tableMeta, fieldPath, docRef = 'doc') {
    const jsonbExpr = buildIndexJsonbExpr(tableMeta, fieldPath, docRef);
    const textExpr = buildIndexTextExpr(tableMeta, fieldPath, docRef);
    return [
        'CASE',
        `WHEN jsonb_typeof(${jsonbExpr}) = 'number' THEN (${textExpr})::numeric`,
        `WHEN jsonb_typeof(${jsonbExpr}) = 'string' AND (${textExpr}) ~ '${NUMERIC_PATTERN}' THEN (${textExpr})::numeric`,
        'ELSE NULL',
        'END'
    ].join(' ');
}

function buildIndexBooleanExpr(tableMeta, fieldPath, docRef = 'doc') {
    const jsonbExpr = buildIndexJsonbExpr(tableMeta, fieldPath, docRef);
    const textExpr = buildIndexTextExpr(tableMeta, fieldPath, docRef);
    return [
        'CASE',
        `WHEN jsonb_typeof(${jsonbExpr}) = 'boolean' THEN (${textExpr})::boolean`,
        `WHEN lower(COALESCE(${textExpr}, '')) IN ('true', 'false') THEN (${textExpr})::boolean`,
        'ELSE NULL',
        'END'
    ].join(' ');
}

function buildIndexComparableExpr(tableMeta, fieldPath, value = undefined, docRef = 'doc') {
    const fieldType = getFieldType(tableMeta, fieldPath, value);
    if (fieldType === 'numeric') return buildIndexNumericExpr(tableMeta, fieldPath, docRef);
    if (fieldType === 'boolean') return buildIndexBooleanExpr(tableMeta, fieldPath, docRef);
    return buildIndexTextExpr(tableMeta, fieldPath, docRef);
}

function buildRuntimeFieldRef(tableMeta, fieldPath, params, docRef = 'doc') {
    validateFieldPath(fieldPath);
    const primaryKey = getPrimaryKey(tableMeta);
    if (fieldPath === primaryKey) {
        return {
            jsonbExpr: 'to_jsonb(doc_key)',
            textExpr: 'doc_key'
        };
    }

    const pathPlaceholder = `${addParam(params, getFieldPathParts(fieldPath))}::text[]`;
    return {
        jsonbExpr: `jsonb_extract_path(${docRef}, VARIADIC ${pathPlaceholder})`,
        textExpr: `jsonb_extract_path_text(${docRef}, VARIADIC ${pathPlaceholder})`
    };
}

function buildRuntimeNumericExpr(tableMeta, fieldPath, params, value = undefined, docRef = 'doc') {
    const fieldRef = buildRuntimeFieldRef(tableMeta, fieldPath, params, docRef);
    return [
        'CASE',
        `WHEN jsonb_typeof(${fieldRef.jsonbExpr}) = 'number' THEN (${fieldRef.textExpr})::numeric`,
        `WHEN jsonb_typeof(${fieldRef.jsonbExpr}) = 'string' AND (${fieldRef.textExpr}) ~ '${NUMERIC_PATTERN}' THEN (${fieldRef.textExpr})::numeric`,
        'ELSE NULL',
        'END'
    ].join(' ');
}

function buildRuntimeBooleanExpr(tableMeta, fieldPath, params, docRef = 'doc') {
    const fieldRef = buildRuntimeFieldRef(tableMeta, fieldPath, params, docRef);
    return [
        'CASE',
        `WHEN jsonb_typeof(${fieldRef.jsonbExpr}) = 'boolean' THEN (${fieldRef.textExpr})::boolean`,
        `WHEN lower(COALESCE(${fieldRef.textExpr}, '')) IN ('true', 'false') THEN (${fieldRef.textExpr})::boolean`,
        'ELSE NULL',
        'END'
    ].join(' ');
}

function buildRuntimeComparableExpr(tableMeta, fieldPath, params, value = undefined, docRef = 'doc') {
    const fieldType = getFieldType(tableMeta, fieldPath, value);
    if (fieldType === 'numeric') return buildRuntimeNumericExpr(tableMeta, fieldPath, params, value, docRef);
    if (fieldType === 'boolean') return buildRuntimeBooleanExpr(tableMeta, fieldPath, params, docRef);
    return buildRuntimeFieldRef(tableMeta, fieldPath, params, docRef).textExpr;
}

function buildEqualityClause(tableMeta, fieldPath, value, params, docRef = 'doc') {
    const jsonbExpr = buildRuntimeFieldRef(tableMeta, fieldPath, params, docRef).jsonbExpr;
    const placeholder = addParam(params, JSON.stringify(value));
    return `${jsonbExpr} = ${placeholder}::jsonb`;
}

function buildFilterClause(tableMeta, fieldPath, filterValue, params, docRef = 'doc') {
    const fieldRef = buildRuntimeFieldRef(tableMeta, fieldPath, params, docRef);
    const jsonbExpr = fieldRef.jsonbExpr;
    const textExpr = fieldRef.textExpr;

    if (filterValue === undefined || filterValue === null) {
        return `${textExpr} IS NULL`;
    }

    if (_.isPlainObject(filterValue)) {
        if ('$eq' in filterValue) {
            return buildEqualityClause(tableMeta, fieldPath, filterValue.$eq, params, docRef);
        }

        if ('$regex' in filterValue) {
            const regexPlaceholder = addParam(params, filterValue.$regex);
            const options = typeof filterValue.$options === 'string' ? filterValue.$options : '';
            const operator = options.includes('i') ? '~*' : '~';
            return `${textExpr} IS NOT NULL AND ${textExpr} ${operator} ${regexPlaceholder}`;
        }

        if ('$ne' in filterValue) {
            const placeholder = addParam(params, JSON.stringify(filterValue.$ne));
            return `${textExpr} IS NOT NULL AND NOT (${jsonbExpr} = ${placeholder}::jsonb)`;
        }

        if ('$lt' in filterValue || '$gt' in filterValue || '$lte' in filterValue || '$gte' in filterValue) {
            const comparisons = [];
            const comparisonKeys = ['$lt', '$gt', '$lte', '$gte'];
            const comparableExpr = buildRuntimeComparableExpr(tableMeta, fieldPath, params, filterValue.$lt ?? filterValue.$gt ?? filterValue.$lte ?? filterValue.$gte, docRef);
            const operators = {
                $lt: '<',
                $gt: '>',
                $lte: '<=',
                $gte: '>='
            };

            for (const key of comparisonKeys) {
                if (!(key in filterValue)) continue;
                const placeholder = addParam(params, filterValue[key]);
                comparisons.push(`${comparableExpr} ${operators[key]} ${placeholder}`);
            }

            return comparisons.join(' AND ');
        }

        if ('$in' in filterValue) {
            if (!Array.isArray(filterValue.$in) || filterValue.$in.length === 0) return 'FALSE';
            const values = filterValue.$in;
            if (values.every(value => typeof value === 'string')) {
                const placeholder = addParam(params, values);
                return `${textExpr} = ANY(${placeholder}::text[])`;
            }
            if (values.every(value => typeof value === 'number')) {
                const placeholder = addParam(params, values);
                return `${buildRuntimeNumericExpr(tableMeta, fieldPath, params, undefined, docRef)} = ANY(${placeholder}::numeric[])`;
            }
            if (values.every(value => typeof value === 'boolean')) {
                const placeholder = addParam(params, values);
                return `${buildRuntimeBooleanExpr(tableMeta, fieldPath, params, docRef)} = ANY(${placeholder}::boolean[])`;
            }

            const orClauses = values.map(value => buildEqualityClause(tableMeta, fieldPath, value, params, docRef));
            return `(${orClauses.join(' OR ')})`;
        }
    }

    return buildEqualityClause(tableMeta, fieldPath, filterValue, params, docRef);
}

function buildWhereClause(tableMeta, filterObj = null, params = [], docRef = 'doc') {
    if (!filterObj || Object.keys(filterObj).length === 0) return 'TRUE';
    const clauses = Object.entries(filterObj).map(([fieldPath, filterValue]) => buildFilterClause(tableMeta, fieldPath, filterValue, params, docRef));
    return clauses.length > 0 ? clauses.join(' AND ') : 'TRUE';
}

function buildSortClause(tableMeta, sort = null, params = [], docRef = 'doc') {
    if (!sort || !sort.by) return '';
    const direction = sort.order === -1 ? 'DESC' : 'ASC';
    const sortExpr = buildRuntimeComparableExpr(tableMeta, sort.by, params, undefined, docRef);
    return ` ORDER BY ${sortExpr} ${direction} NULLS LAST`;
}

function buildRangeClause(range = null, params = []) {
    if (!Array.isArray(range) || range.length !== 2) return '';

    const offset = Math.max(0, Number(range[0]) || 0);
    const limit = Math.max(0, (Number(range[1]) || 0) - offset);
    const offsetPlaceholder = addParam(params, offset);
    const limitPlaceholder = addParam(params, limit);
    return ` OFFSET ${offsetPlaceholder} LIMIT ${limitPlaceholder}`;
}

function extractDocKey(tableMeta = {}, doc = {}) {
    const primaryKey = getPrimaryKey(tableMeta);
    if (!primaryKey || !doc || typeof doc !== 'object') return null;

    return doc[primaryKey] !== undefined && doc[primaryKey] !== null
        ? String(doc[primaryKey])
        : null;
}

function buildAggregateFilterClause(filterObj = {}, params = []) {
    if (!filterObj || Object.keys(filterObj).length === 0) return 'TRUE';

    const clauses = [];
    for (const [fieldName, filterValue] of Object.entries(filterObj)) {
        const fieldIdentifier = quoteIdentifier(fieldName);
        if (filterValue === undefined || filterValue === null) {
            clauses.push(`${fieldIdentifier} IS NULL`);
            continue;
        }

        if (_.isPlainObject(filterValue)) {
            if ('$eq' in filterValue) {
                const placeholder = addParam(params, filterValue.$eq);
                clauses.push(`${fieldIdentifier} = ${placeholder}`);
                continue;
            }
            if ('$ne' in filterValue) {
                const placeholder = addParam(params, filterValue.$ne);
                clauses.push(`${fieldIdentifier} IS NOT NULL AND ${fieldIdentifier} <> ${placeholder}`);
                continue;
            }

            const comparisonOperators = {
                $lt: '<',
                $gt: '>',
                $lte: '<=',
                $gte: '>='
            };
            const comparisons = [];
            for (const [comparisonKey, comparisonOperator] of Object.entries(comparisonOperators)) {
                if (!(comparisonKey in filterValue)) continue;
                const placeholder = addParam(params, filterValue[comparisonKey]);
                comparisons.push(`${fieldIdentifier} ${comparisonOperator} ${placeholder}`);
            }
            if (comparisons.length > 0) {
                clauses.push(comparisons.join(' AND '));
                continue;
            }
            return null;
        }

        const placeholder = addParam(params, filterValue);
        clauses.push(`${fieldIdentifier} = ${placeholder}`);
    }

    return clauses.join(' AND ') || 'TRUE';
}

function buildAggregateSortClause(sortStage = {}) {
    const sortEntries = Object.entries(sortStage || {});
    if (sortEntries.length === 0) return '';

    const sortClauses = [];
    for (const [fieldName, direction] of sortEntries) {
        const fieldIdentifier = quoteIdentifier(fieldName);
        const sortDirection = Number(direction) === -1 ? 'DESC' : 'ASC';
        sortClauses.push(`${fieldIdentifier} ${sortDirection} NULLS LAST`);
    }

    return sortClauses.length > 0 ? ` ORDER BY ${sortClauses.join(', ')}` : '';
}

function tryBuildAggregateQuery(tables, tableName, pipeline = []) {
    const tableMeta = tables[tableName];
    if (!tableMeta || !Array.isArray(pipeline) || pipeline.length === 0) return null;

    let stageIndex = 0;
    let preGroupMatch = null;
    if (pipeline[stageIndex] && pipeline[stageIndex].$match) {
        preGroupMatch = pipeline[stageIndex].$match;
        stageIndex += 1;
    }

    const groupStage = pipeline[stageIndex] && pipeline[stageIndex].$group;
    if (!groupStage || typeof groupStage._id !== 'string' || !groupStage._id.startsWith('$')) return null;
    stageIndex += 1;

    const params = [];
    const tableIdentifier = quoteIdentifier(tableName);
    const groupFieldPath = groupStage._id.slice(1);
    const groupFieldExpr = buildRuntimeFieldRef(tableMeta, groupFieldPath, params).textExpr;
    const selectClauses = [`${groupFieldExpr} AS ${quoteIdentifier('_id')}`];

    for (const [outputField, aggregation] of Object.entries(groupStage)) {
        if (outputField === '_id') continue;
        const outputIdentifier = quoteIdentifier(outputField);

        if (_.isPlainObject(aggregation) && aggregation.$sum === 1) {
            selectClauses.push(`COUNT(*)::integer AS ${outputIdentifier}`);
            continue;
        }

        if (_.isPlainObject(aggregation) && typeof aggregation.$max === 'string' && aggregation.$max.startsWith('$')) {
            const sourceField = aggregation.$max.slice(1);
            const maxExpr = buildRuntimeComparableExpr(tableMeta, sourceField, params, undefined, 'doc');
            selectClauses.push(`MAX(${maxExpr}) AS ${outputIdentifier}`);
            continue;
        }

        return null;
    }

    const whereClauses = [];
    if (preGroupMatch) whereClauses.push(buildWhereClause(tableMeta, preGroupMatch, params));
    whereClauses.push(`${groupFieldExpr} IS NOT NULL`);

    let queryText = `SELECT ${selectClauses.join(', ')} FROM ${tableIdentifier} WHERE ${whereClauses.join(' AND ')} GROUP BY ${groupFieldExpr}`;

    if (pipeline[stageIndex] && pipeline[stageIndex].$match) {
        const aggregateWhereClause = buildAggregateFilterClause(pipeline[stageIndex].$match, params);
        if (!aggregateWhereClause) return null;
        queryText = `SELECT * FROM (${queryText}) AS grouped_records WHERE ${aggregateWhereClause}`;
        stageIndex += 1;
    }

    if (pipeline[stageIndex] && pipeline[stageIndex].$sort) {
        queryText += buildAggregateSortClause(pipeline[stageIndex].$sort);
        stageIndex += 1;
    }

    if (pipeline[stageIndex] && pipeline[stageIndex].$count) {
        const outputIdentifier = quoteIdentifier(pipeline[stageIndex].$count);
        queryText = `SELECT COUNT(*)::integer AS ${outputIdentifier} FROM (${queryText}) AS counted_records`;
        stageIndex += 1;
    }

    if (stageIndex !== pipeline.length) return null;
    return { queryText, params };
}

function buildUpdatedDocExpression(tableMeta, updateObj = {}, params = [], docRef = 'doc') {
    let currentExpr = docRef;
    for (const [fieldPath, value] of Object.entries(updateObj)) {
        if (fieldPath === '_id') continue;
        const pathPlaceholder = `${addParam(params, getFieldPathParts(fieldPath))}::text[]`;
        const valuePlaceholder = addParam(params, JSON.stringify(value));
        currentExpr = `jsonb_set(${currentExpr}, ${pathPlaceholder}, ${valuePlaceholder}::jsonb, true)`;
    }
    return currentExpr;
}

function buildRemovedDocExpression(tableMeta, removeObj = {}, params = [], docRef = 'doc') {
    let currentExpr = docRef;
    for (const fieldPath of Object.keys(removeObj || {})) {
        if (fieldPath === '_id') continue;
        const pathPlaceholder = `${addParam(params, getFieldPathParts(fieldPath))}::text[]`;
        currentExpr = `(${currentExpr} #- ${pathPlaceholder})`;
    }
    return currentExpr;
}

function buildDocKeyExpr(tableMeta, params = [], docExpr = 'doc') {
    const primaryKey = getPrimaryKey(tableMeta);
    if (!primaryKey) return 'doc_key';
    const pathPlaceholder = `${addParam(params, getFieldPathParts(primaryKey))}::text[]`;
    return `jsonb_extract_path_text(${docExpr}, VARIADIC ${pathPlaceholder})`;
}

function getIndexExpression(tableMeta, fieldPath) {
    const fieldType = getFieldType(tableMeta, fieldPath);
    if (fieldType === 'numeric') return buildIndexNumericExpr(tableMeta, fieldPath);
    if (fieldType === 'boolean') return buildIndexBooleanExpr(tableMeta, fieldPath);
    return buildIndexTextExpr(tableMeta, fieldPath);
}

async function ensureTable(pool, tableName, tableMeta = {}) {
    const tableIdentifier = quoteIdentifier(tableName);
    await pool.query(`
        CREATE TABLE IF NOT EXISTS ${tableIdentifier} (
            row_id BIGSERIAL PRIMARY KEY,
            doc_key TEXT,
            doc JSONB NOT NULL
        )
    `);

    if (getPrimaryKey(tableMeta)) {
        const uniqueIndexName = sanitizeIndexName(`${tableName}_doc_key_unique_idx`);
        await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS ${quoteIdentifier(uniqueIndexName)} ON ${tableIdentifier} (doc_key)`);
    }

    const indexes = Array.isArray(tableMeta.indexes) ? tableMeta.indexes : [];
    for (const index of indexes) {
        if (!index || !index.keys || typeof index.keys !== 'object') continue;

        const indexFields = Object.entries(index.keys);
        if (indexFields.length === 0) continue;

        const expressions = indexFields.map(([fieldPath, order]) => {
            validateFieldPath(fieldPath);
            const direction = Number(order) === -1 ? 'DESC' : 'ASC';
            return `(${getIndexExpression(tableMeta, fieldPath)}) ${direction} NULLS LAST`;
        });

        const indexName = sanitizeIndexName(`${tableName}_${indexFields.map(([fieldPath]) => fieldPath.replace(/\./g, '_')).join('_')}_idx`);
        await pool.query(`CREATE INDEX IF NOT EXISTS ${quoteIdentifier(indexName)} ON ${tableIdentifier} (${expressions.join(', ')})`);
    }
}

async function ensureSchema(pool, tables = {}) {
    for (const [tableName, tableMeta] of Object.entries(tables)) {
        await ensureTable(pool, tableName, tableMeta);
    }
}

function sanitizeConnectionString(connectionString) {
    const url = new URL(connectionString);
    const cleanedUrl = new URL(connectionString);
    ['sslmode', 'sslrootcert', 'sslcert', 'sslkey'].forEach(param => cleanedUrl.searchParams.delete(param));
    return { originalUrl: url, cleanedConnectionString: cleanedUrl.toString() };
}

function parsePostgresConnectionConfig(connectionString) {
    if (typeof connectionString !== 'string' || connectionString.trim().length === 0) {
        throw new Error('A PostgreSQL connection string is required.');
    }

    const { originalUrl, cleanedConnectionString } = sanitizeConnectionString(connectionString);
    const protocol = originalUrl.protocol.toLowerCase();
    if (protocol !== 'postgres:' && protocol !== 'postgresql:') {
        throw new Error(`Unsupported PostgreSQL protocol '${protocol}'.`);
    }

    const sslMode = (originalUrl.searchParams.get('sslmode') || '').toLowerCase();
    const sslRootCert = originalUrl.searchParams.get('sslrootcert');
    const sslCert = originalUrl.searchParams.get('sslcert');
    const sslKey = originalUrl.searchParams.get('sslkey');
    const shouldUseSSL = (sslMode && sslMode !== 'disable') || sslRootCert || sslCert || sslKey;

    const config = {
        connectionString: cleanedConnectionString
    };

    if (!shouldUseSSL) return config;

    const ssl = {
        rejectUnauthorized: sslMode === 'verify-ca' || sslMode === 'verify-full'
    };

    if (sslRootCert) ssl.ca = fs.readFileSync(sslRootCert, 'utf8');
    if (sslCert) ssl.cert = fs.readFileSync(sslCert, 'utf8');
    if (sslKey) ssl.key = fs.readFileSync(sslKey, 'utf8');
    if (sslMode === 'verify-ca') ssl.checkServerIdentity = () => undefined;

    config.ssl = ssl;
    return config;
}

async function createConnection(connectionString, tables = {}, options = {}) {
    const { testOnly = false } = options;
    const pool = poolFactory(parsePostgresConnectionConfig(connectionString));
    try {
        await pool.query('SELECT 1');
        if (!testOnly) await ensureSchema(pool, tables);
        return pool;
    } catch (error) {
        await pool.end().catch(() => null);
        throw error;
    }
}

async function closeConnection(pool) {
    if (!pool) return;
    await pool.end();
}

async function withTransaction(pool, callback) {
    await pool.query('BEGIN');
    try {
        const result = await callback();
        await pool.query('COMMIT');
        return result;
    } catch (error) {
        await pool.query('ROLLBACK');
        throw error;
    }
}

async function insertRecord(pool, tables, tableName, doc, replaceFilter = null) {
    const tableMeta = tables[tableName];
    const tableIdentifier = quoteIdentifier(tableName);
    const docKey = extractDocKey(tableMeta, doc);

    if (replaceFilter) {
        const params = [];
        const whereClause = buildWhereClause(tableMeta, replaceFilter, params);
        await withTransaction(pool, async () => {
            await pool.query(`DELETE FROM ${tableIdentifier} WHERE ${whereClause}`, params);
            const insertParams = [docKey, JSON.stringify(doc)];
            await pool.query(`INSERT INTO ${tableIdentifier} (doc_key, doc) VALUES ($1, $2::jsonb)`, insertParams);
        });
        return true;
    }

    await pool.query(`INSERT INTO ${tableIdentifier} (doc_key, doc) VALUES ($1, $2::jsonb)`, [docKey, JSON.stringify(doc)]);
    return true;
}

async function insertRecords(pool, tables, tableName, docs = [], ignoreErrors = false) {
    if (!Array.isArray(docs) || docs.length === 0) return true;

    const tableMeta = tables[tableName];
    const tableIdentifier = quoteIdentifier(tableName);
    const params = [];
    const values = docs.map(doc => {
        const docKeyPlaceholder = addParam(params, extractDocKey(tableMeta, doc));
        const docPlaceholder = addParam(params, JSON.stringify(doc));
        return `(${docKeyPlaceholder}, ${docPlaceholder}::jsonb)`;
    });

    let conflictClause = '';
    const primaryKey = getPrimaryKey(tableMeta);
    if (ignoreErrors && primaryKey) {
        conflictClause = ' ON CONFLICT (doc_key) DO NOTHING';
    }

    await pool.query(`INSERT INTO ${tableIdentifier} (doc_key, doc) VALUES ${values.join(', ')}${conflictClause}`, params);
    return true;
}

async function bulkInsertRecords(pool, tables, tableName, docs = []) {
    return await insertRecords(pool, tables, tableName, docs);
}

async function getRecord(pool, tables, tableName, filterObj = null) {
    const records = await getRecords(pool, tables, tableName, filterObj, false, null, [0, 1]);
    return records.length > 0 ? records[0] : null;
}

async function getRecords(pool, tables, tableName, filterObj = null, returnCount = false, sort = null, range = null) {
    const tableMeta = tables[tableName];
    const tableIdentifier = quoteIdentifier(tableName);
    const params = [];
    const whereClause = buildWhereClause(tableMeta, filterObj, params);

    if (returnCount) {
        const result = await pool.query(`SELECT COUNT(*)::integer AS count FROM ${tableIdentifier} WHERE ${whereClause}`, params);
        return Number(result.rows[0] && result.rows[0].count ? result.rows[0].count : 0);
    }

    const sortClause = buildSortClause(tableMeta, sort, params);
    const rangeClause = buildRangeClause(range, params);
    const result = await pool.query(`SELECT doc FROM ${tableIdentifier} WHERE ${whereClause}${sortClause}${rangeClause}`, params);
    return result.rows.map(row => row.doc);
}

async function updateRecord(pool, tables, tableName, filterObj = null, updateObj = {}) {
    const tableMeta = tables[tableName];
    const tableIdentifier = quoteIdentifier(tableName);
    const params = [];
    const updatedDocExpr = buildUpdatedDocExpression(tableMeta, updateObj, params);
    const whereClause = buildWhereClause(tableMeta, filterObj, params);
    const result = await pool.query(
        `UPDATE ${tableIdentifier} SET doc = ${updatedDocExpr}, doc_key = ${buildDocKeyExpr(tableMeta, params, updatedDocExpr)} WHERE ${whereClause}`,
        params
    );
    return result.rowCount >= 0;
}

async function updateRecords(pool, tables, tableName, filterObj = null, updateObj = {}) {
    return await updateRecord(pool, tables, tableName, filterObj, updateObj);
}

async function removePropertyFromRecord(pool, tables, tableName, filterObj = null, removeObj = {}) {
    const tableMeta = tables[tableName];
    const tableIdentifier = quoteIdentifier(tableName);
    const params = [];
    const removedDocExpr = buildRemovedDocExpression(tableMeta, removeObj, params);
    const whereClause = buildWhereClause(tableMeta, filterObj, params);
    const result = await pool.query(
        `UPDATE ${tableIdentifier} SET doc = ${removedDocExpr}, doc_key = ${buildDocKeyExpr(tableMeta, params, removedDocExpr)} WHERE ${whereClause}`,
        params
    );
    return result.rowCount >= 0;
}

async function bulkUpdateRecordsByKey(pool, tables, tableName, keyLabel, updateObj = {}) {
    const entries = Object.entries(updateObj || {});
    if (entries.length === 0) return true;

    await withTransaction(pool, async () => {
        for (const [keyValue, changes] of entries) {
            await updateRecord(pool, tables, tableName, {[keyLabel]: keyValue}, changes);
        }
    });
    return true;
}

async function pushToRecordsArray(pool, tables, tableName, filterObj = null, key, value) {
    validateFieldPath(key);
    const tableMeta = tables[tableName];
    const tableIdentifier = quoteIdentifier(tableName);
    const params = [];
    const valuePlaceholder = addParam(params, JSON.stringify([value]));
    const pathPlaceholder = `${addParam(params, getFieldPathParts(key))}::text[]`;
    const whereClause = buildWhereClause(tableMeta, filterObj, params);
    const pathJsonbExpr = `jsonb_extract_path(doc, VARIADIC ${pathPlaceholder})`;
    const updatedDocExpr = `jsonb_set(doc, ${pathPlaceholder}, COALESCE(CASE WHEN jsonb_typeof(${pathJsonbExpr}) = 'array' THEN ${pathJsonbExpr} ELSE '[]'::jsonb END, '[]'::jsonb) || ${valuePlaceholder}::jsonb, true)`;
    const result = await pool.query(
        `UPDATE ${tableIdentifier} SET doc = ${updatedDocExpr}, doc_key = ${buildDocKeyExpr(tableMeta, params, updatedDocExpr)} WHERE ${whereClause}`,
        params
    );
    return result.rowCount >= 0;
}

async function pullFromRecordsArray(pool, tables, tableName, filterObj = null, key, value) {
    validateFieldPath(key);
    const tableMeta = tables[tableName];
    const tableIdentifier = quoteIdentifier(tableName);
    const params = [];
    const valuePlaceholder = addParam(params, JSON.stringify(value));
    const pathPlaceholder = `${addParam(params, getFieldPathParts(key))}::text[]`;
    const whereClause = buildWhereClause(tableMeta, filterObj, params);
    const pathJsonbExpr = `jsonb_extract_path(doc, VARIADIC ${pathPlaceholder})`;
    const updatedDocExpr = `jsonb_set(doc, ${pathPlaceholder}, COALESCE((SELECT jsonb_agg(elem) FROM jsonb_array_elements(CASE WHEN jsonb_typeof(${pathJsonbExpr}) = 'array' THEN ${pathJsonbExpr} ELSE '[]'::jsonb END) elem WHERE elem <> ${valuePlaceholder}::jsonb), '[]'::jsonb), true)`;
    const result = await pool.query(
        `UPDATE ${tableIdentifier} SET doc = ${updatedDocExpr}, doc_key = ${buildDocKeyExpr(tableMeta, params, updatedDocExpr)} WHERE ${whereClause}`,
        params
    );
    return result.rowCount >= 0;
}

async function removeRecord(pool, tables, tableName, filterObj = null) {
    const tableMeta = tables[tableName];
    const tableIdentifier = quoteIdentifier(tableName);
    const params = [];
    const whereClause = buildWhereClause(tableMeta, filterObj, params);
    const result = await pool.query(`DELETE FROM ${tableIdentifier} WHERE ${whereClause}`, params);
    return result.rowCount >= 0;
}

async function removeAllRecords(pool, tables, tableName = null, filterObj = null) {
    const tablesToRemove = tableName ? [tableName] : Object.keys(tables);
    await withTransaction(pool, async () => {
        for (const currentTableName of tablesToRemove) {
            const tableMeta = tables[currentTableName];
            const tableIdentifier = quoteIdentifier(currentTableName);
            const params = [];
            const whereClause = buildWhereClause(tableMeta, filterObj, params);
            await pool.query(`DELETE FROM ${tableIdentifier} WHERE ${whereClause}`, params);
        }
    });
    return true;
}

async function getTableStats(pool, tableName) {
    const tableIdentifier = quoteIdentifier(tableName);
    const result = await pool.query(`SELECT COUNT(*)::integer AS count FROM ${tableIdentifier}`);
    return { records_count: Number(result.rows[0] && result.rows[0].count ? result.rows[0].count : 0) };
}

async function hasAnyRecords(pool, tables = {}) {
    const tableNames = Object.keys(tables);
    if (tableNames.length === 0) return false;

    const existingTablesResult = await pool.query(`
        SELECT table_name
        FROM information_schema.tables
        WHERE table_schema = current_schema()
            AND table_name = ANY($1::text[])
    `, [tableNames]);
    const existingTables = new Set(existingTablesResult.rows.map(row => row.table_name));

    for (const tableName of tableNames) {
        if (!existingTables.has(tableName)) continue;
        const tableIdentifier = quoteIdentifier(tableName);
        const result = await pool.query(`SELECT EXISTS (SELECT 1 FROM ${tableIdentifier} LIMIT 1) AS has_rows`);
        if (result.rows[0] && result.rows[0].has_rows) return true;
    }

    return false;
}

async function readAllTables(pool, tables = {}) {
    const tableToRecords = {};
    for (const tableName of Object.keys(tables)) {
        tableToRecords[tableName] = await getRecords(pool, tables, tableName);
    }
    return tableToRecords;
}

async function replaceAllTables(pool, tables = {}, tableToRecords = {}) {
    await withTransaction(pool, async () => {
        for (const tableName of Object.keys(tables)) {
            const tableIdentifier = quoteIdentifier(tableName);
            await pool.query(`DELETE FROM ${tableIdentifier}`);
            const records = Array.isArray(tableToRecords[tableName]) ? tableToRecords[tableName] : [];
            if (records.length === 0) continue;

            const params = [];
            const values = records.map(record => {
                const docKeyPlaceholder = addParam(params, extractDocKey(tables[tableName], record));
                const docPlaceholder = addParam(params, JSON.stringify(record));
                return `(${docKeyPlaceholder}, ${docPlaceholder}::jsonb)`;
            });
            await pool.query(`INSERT INTO ${tableIdentifier} (doc_key, doc) VALUES ${values.join(', ')}`, params);
        }
    });
    return true;
}

async function findDuplicatesByKey(pool, tables, tableName, key) {
    validateFieldPath(key);
    const tableMeta = tables[tableName];
    const tableIdentifier = quoteIdentifier(tableName);
    const params = [];
    const textExpr = buildRuntimeFieldRef(tableMeta, key, params).textExpr;
    const sortExpr = getPrimaryKey(tableMeta) ? 'doc_key' : 'row_id::text';
    const result = await pool.query(`
        WITH ranked_records AS (
            SELECT doc, row_number() OVER (PARTITION BY ${textExpr} ORDER BY ${sortExpr}) AS duplicate_rank
            FROM ${tableIdentifier}
            WHERE ${textExpr} IS NOT NULL
        )
        SELECT doc
        FROM ranked_records
        WHERE duplicate_rank > 1
    `, params);
    return result.rows.map(row => row.doc);
}

function getValueByPath(record, fieldPath) {
    const pathParts = getFieldPathParts(fieldPath);
    let currentValue = record;
    for (const part of pathParts) {
        if (currentValue === null || currentValue === undefined) return undefined;
        currentValue = currentValue[part];
    }
    return currentValue;
}

function matchesFilter(record, filterObj = {}) {
    const filterEntries = Object.entries(filterObj || {});
    for (const [fieldPath, filterValue] of filterEntries) {
        const recordValue = getValueByPath(record, fieldPath);
        if (filterValue === undefined || filterValue === null) {
            if (recordValue !== undefined && recordValue !== null) return false;
            continue;
        }

        if (_.isPlainObject(filterValue)) {
            if ('$regex' in filterValue) {
                if (typeof recordValue !== 'string') return false;
                const regex = new RegExp(filterValue.$regex, filterValue.$options || '');
                if (recordValue.search(regex) === -1) return false;
                continue;
            }
            if ('$ne' in filterValue) {
                if (recordValue === undefined || _.isEqual(recordValue, filterValue.$ne)) return false;
                continue;
            }
            if ('$lt' in filterValue) {
                if (recordValue === undefined || !(recordValue < filterValue.$lt)) return false;
                continue;
            }
            if ('$gt' in filterValue) {
                if (recordValue === undefined || !(recordValue > filterValue.$gt)) return false;
                continue;
            }
            if ('$lte' in filterValue) {
                if (recordValue === undefined || !(recordValue <= filterValue.$lte)) return false;
                continue;
            }
            if ('$gte' in filterValue) {
                if (recordValue === undefined || !(recordValue >= filterValue.$gte)) return false;
                continue;
            }
            if ('$in' in filterValue) {
                if (!Array.isArray(filterValue.$in) || !filterValue.$in.some(value => _.isEqual(value, recordValue))) return false;
                continue;
            }
        }

        if (!_.isEqual(recordValue, filterValue)) return false;
    }
    return true;
}

function applyAggregateGroup(records = [], groupStage = {}) {
    const idReference = typeof groupStage._id === 'string' && groupStage._id.startsWith('$')
        ? groupStage._id.slice(1)
        : null;
    const groupedRecords = new Map();

    for (const record of records) {
        const groupKey = idReference ? getValueByPath(record, idReference) : null;
        const serializedKey = JSON.stringify(groupKey);
        if (!groupedRecords.has(serializedKey)) {
            groupedRecords.set(serializedKey, { _id: groupKey });
        }

        const aggregateRecord = groupedRecords.get(serializedKey);
        for (const [outputField, aggregation] of Object.entries(groupStage)) {
            if (outputField === '_id') continue;

            if (_.isPlainObject(aggregation) && aggregation.$sum === 1) {
                aggregateRecord[outputField] = Number(aggregateRecord[outputField] || 0) + 1;
                continue;
            }

            if (_.isPlainObject(aggregation) && typeof aggregation.$max === 'string' && aggregation.$max.startsWith('$')) {
                const sourceField = aggregation.$max.slice(1);
                const currentValue = getValueByPath(record, sourceField);
                if (aggregateRecord[outputField] === undefined || currentValue > aggregateRecord[outputField]) {
                    aggregateRecord[outputField] = currentValue;
                }
            }
        }
    }

    return [...groupedRecords.values()];
}

async function aggregateRecords(pool, tables, tableName, pipeline = []) {
    const aggregateQuery = tryBuildAggregateQuery(tables, tableName, pipeline);
    if (aggregateQuery) {
        const result = await pool.query(aggregateQuery.queryText, aggregateQuery.params);
        return result.rows;
    }

    let records = await getRecords(pool, tables, tableName);
    for (const stage of Array.isArray(pipeline) ? pipeline : []) {
        if (stage.$match) {
            records = records.filter(record => matchesFilter(record, stage.$match));
            continue;
        }
        if (stage.$group) {
            records = applyAggregateGroup(records, stage.$group);
            continue;
        }
        if (stage.$count) {
            records = [{ [stage.$count]: records.length }];
            continue;
        }
        if (stage.$sort) {
            const sortEntries = Object.entries(stage.$sort);
            records = records.sort((left, right) => {
                for (const [fieldPath, direction] of sortEntries) {
                    const leftValue = getValueByPath(left, fieldPath);
                    const rightValue = getValueByPath(right, fieldPath);
                    if (_.isEqual(leftValue, rightValue)) continue;
                    if (leftValue === undefined || leftValue === null) return 1;
                    if (rightValue === undefined || rightValue === null) return -1;
                    return leftValue > rightValue ? Number(direction) : Number(direction) * -1;
                }
                return 0;
            });
        }
    }

    return records;
}

exports.setPoolFactory = (factory) => {
    poolFactory = factory || createDefaultPoolFactory();
};

exports.resetPoolFactory = () => {
    poolFactory = createDefaultPoolFactory();
};

exports.parsePostgresConnectionConfig = parsePostgresConnectionConfig;
exports.createConnection = createConnection;
exports.closeConnection = closeConnection;
exports.ensureSchema = ensureSchema;
exports.insertRecord = insertRecord;
exports.insertRecords = insertRecords;
exports.bulkInsertRecords = bulkInsertRecords;
exports.getRecord = getRecord;
exports.getRecords = getRecords;
exports.updateRecord = updateRecord;
exports.updateRecords = updateRecords;
exports.removePropertyFromRecord = removePropertyFromRecord;
exports.bulkUpdateRecordsByKey = bulkUpdateRecordsByKey;
exports.pushToRecordsArray = pushToRecordsArray;
exports.pullFromRecordsArray = pullFromRecordsArray;
exports.removeRecord = removeRecord;
exports.removeAllRecords = removeAllRecords;
exports.getTableStats = getTableStats;
exports.hasAnyRecords = hasAnyRecords;
exports.readAllTables = readAllTables;
exports.replaceAllTables = replaceAllTables;
exports.findDuplicatesByKey = findDuplicatesByKey;
exports.aggregateRecords = aggregateRecords;
