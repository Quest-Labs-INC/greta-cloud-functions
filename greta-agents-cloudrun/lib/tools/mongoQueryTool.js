const { MongoClient } = require('mongodb');

const clientCache = new Map();

async function getDb(projectMongoUrl) {
    if (clientCache.has(projectMongoUrl)) {
        return clientCache.get(projectMongoUrl);
    }
    const client = new MongoClient(projectMongoUrl, {
        serverSelectionTimeoutMS: 10000,
        connectTimeoutMS: 10000,
        readPreference: 'secondaryPreferred',
    });
    await client.connect();
    const db = client.db();
    clientCache.set(projectMongoUrl, db);
    console.log(`[MongoQueryTool] Connected to project DB: ${db.databaseName}`);
    return db;
}

const BLOCKED_OPERATORS = new Set(['$where', '$function', '$accumulator', '$out', '$merge']);

const ALLOWED_PIPELINE_STAGES = new Set([
    '$match', '$group', '$project', '$sort', '$limit', '$skip', '$unwind',
    '$count', '$addFields', '$set', '$replaceRoot', '$replaceWith',
    '$lookup', '$facet', '$bucket', '$bucketAuto', '$sortByCount',
    '$sample', '$densify', '$fill',
]);

const COLLECTION_NAME_RE = /^[a-zA-Z0-9_.\-]{1,64}$/;

function validateCollectionName(name) {
    if (!name || typeof name !== 'string') return 'collection is required';
    if (!COLLECTION_NAME_RE.test(name)) return `Invalid collection name: "${name}"`;
    return null;
}

function findBlockedOp(val, depth = 0) {
    if (depth > 20) return '$deep_nest';
    if (!val || typeof val !== 'object') return null;
    for (const key of Object.keys(val)) {
        if (BLOCKED_OPERATORS.has(key)) return key;
        const child = findBlockedOp(val[key], depth + 1);
        if (child) return child;
    }
    return null;
}

function validateLookupStage(stage) {
    const spec = stage['$lookup'];
    if (!spec || typeof spec !== 'object') return null;
    if (spec.db !== undefined) return '$lookup.db (cross-database lookup) is not allowed';
    return null;
}

function validatePipeline(pipeline) {
    if (!Array.isArray(pipeline)) return 'pipeline must be an array';
    for (let i = 0; i < pipeline.length; i++) {
        const stage = pipeline[i];
        if (!stage || typeof stage !== 'object') return `stage ${i} is not an object`;
        const stageKeys = Object.keys(stage);
        if (stageKeys.length !== 1) return `stage ${i} must have exactly one operator key`;
        const stageOp = stageKeys[0];
        if (!ALLOWED_PIPELINE_STAGES.has(stageOp)) return `pipeline stage "${stageOp}" is not allowed`;
        const blocked = findBlockedOp(stage);
        if (blocked) return `operator "${blocked}" is not allowed`;
        if (stageOp === '$lookup') {
            const lookupErr = validateLookupStage(stage);
            if (lookupErr) return lookupErr;
        }
    }
    return null;
}

function sanitiseDoc(doc, maxStrLen = 500) {
    if (!doc || typeof doc !== 'object') return doc;
    const out = {};
    for (const [k, v] of Object.entries(doc)) {
        if (typeof v === 'string' && v.length > maxStrLen) {
            out[k] = v.slice(0, maxStrLen) + `…[truncated ${v.length - maxStrLen} chars]`;
        } else if (Array.isArray(v)) {
            out[k] = v.slice(0, 20).map(item => sanitiseDoc(item, maxStrLen));
        } else if (v && typeof v === 'object' && !(v instanceof Date)) {
            out[k] = sanitiseDoc(v, maxStrLen);
        } else {
            out[k] = v;
        }
    }
    return out;
}

async function executeMongoQuery(projectMongoUrl, args) {
    const {
        operation, collection, filter = {}, pipeline = [], limit, sort, projection,
        field, groupBy: groupByField, metric, metricField, timePeriod, dateField,
    } = args;

    const collErr = validateCollectionName(collection);
    if (collErr) return { error: collErr };

    const blockedInFilter = findBlockedOp(filter);
    if (blockedInFilter) return { error: `Operator "${blockedInFilter}" is not allowed in filter` };

    const safeLimit = Math.min(Math.max(1, limit || 20), 100);
    const maxTimeMS = 8000;

    try {
        const db = await getDb(projectMongoUrl);
        const coll = db.collection(collection);

        switch (operation) {
            case 'find': {
                let cursor = coll.find(filter, { projection: projection || {}, maxTimeMS });
                if (sort) cursor = cursor.sort(sort);
                const docs = await cursor.limit(safeLimit).toArray();
                return { count: docs.length, documents: docs.map(d => sanitiseDoc(d)) };
            }
            case 'findOne': {
                const doc = await coll.findOne(filter, { projection: projection || {}, maxTimeMS });
                return { document: doc ? sanitiseDoc(doc) : null };
            }
            case 'count': {
                const count = await coll.countDocuments(filter, { maxTimeMS });
                return { count };
            }
            case 'aggregate': {
                const pipeErr = validatePipeline(pipeline);
                if (pipeErr) return { error: pipeErr };
                if (pipeline.length === 0) return { error: 'pipeline must have at least one stage' };
                const hasLimit = pipeline.some(s => '$limit' in s);
                const safePipeline = hasLimit ? pipeline : [...pipeline, { $limit: safeLimit }];
                const results = await coll.aggregate(safePipeline, { maxTimeMS, allowDiskUse: false }).toArray();
                return { count: results.length, results: results.map(d => sanitiseDoc(d)) };
            }
            case 'distinct': {
                if (!field) return { error: '"field" is required for distinct operation' };
                if (typeof field !== 'string' || !/^[a-zA-Z0-9_.]{1,100}$/.test(field)) return { error: 'Invalid field name' };
                const values = await coll.distinct(field, filter, { maxTimeMS });
                return { count: values.length, values };
            }
            case 'groupBy': {
                const gField = groupByField || field;
                if (!gField) return { error: '"groupBy" or "field" is required for groupBy operation' };
                if (typeof gField !== 'string' || !/^[a-zA-Z0-9_.]{1,100}$/.test(gField)) return { error: 'Invalid groupBy field name' };
                const m = (metric || 'count').toLowerCase();
                let groupStage;
                if (m === 'count') groupStage = { $group: { _id: `$${gField}`, count: { $sum: 1 } } };
                else if (m === 'sum') {
                    if (!metricField) return { error: '"metricField" required when metric is "sum"' };
                    groupStage = { $group: { _id: `$${gField}`, total: { $sum: `$${metricField}` } } };
                } else if (m === 'avg') {
                    if (!metricField) return { error: '"metricField" required when metric is "avg"' };
                    groupStage = { $group: { _id: `$${gField}`, average: { $avg: `$${metricField}` } } };
                } else return { error: 'metric must be "count", "sum", or "avg"' };
                const gbPipeline = [
                    ...(Object.keys(filter).length > 0 ? [{ $match: filter }] : []),
                    groupStage,
                    { $sort: { count: -1, total: -1, average: -1 } },
                    { $limit: safeLimit },
                ];
                const pipeErr2 = validatePipeline(gbPipeline);
                if (pipeErr2) return { error: pipeErr2 };
                const results = await coll.aggregate(gbPipeline, { maxTimeMS, allowDiskUse: false }).toArray();
                return { count: results.length, results };
            }
            case 'timeSeries': {
                const dField = dateField || 'createdAt';
                const period = (timePeriod || 'day').toLowerCase();
                if (typeof dField !== 'string' || !/^[a-zA-Z0-9_.]{1,100}$/.test(dField)) return { error: 'Invalid dateField name' };
                const truncMap = {
                    hour:  { hour: '$hour', day: '$dayOfMonth', month: '$month', year: '$year' },
                    day:   { day: '$dayOfMonth', month: '$month', year: '$year' },
                    week:  { week: '$week', year: '$year' },
                    month: { month: '$month', year: '$year' },
                    year:  { year: '$year' },
                };
                if (!truncMap[period]) return { error: 'timePeriod must be hour, day, week, month, or year' };
                const dateParts = {};
                for (const [partKey, op] of Object.entries(truncMap[period])) {
                    dateParts[partKey] = { [op]: `$${dField}` };
                }
                const m = (metric || 'count').toLowerCase();
                let accumulator;
                if (m === 'count') accumulator = { $sum: 1 };
                else if (m === 'sum') {
                    if (!metricField) return { error: '"metricField" required when metric is "sum"' };
                    accumulator = { $sum: `$${metricField}` };
                } else return { error: 'timeSeries metric must be "count" or "sum"' };
                const tsPipeline = [
                    ...(Object.keys(filter).length > 0 ? [{ $match: filter }] : []),
                    { $group: { _id: dateParts, value: accumulator } },
                    { $sort: { '_id.year': 1, '_id.month': 1, '_id.week': 1, '_id.day': 1, '_id.hour': 1 } },
                    { $limit: 500 },
                ];
                const pipeErr3 = validatePipeline(tsPipeline);
                if (pipeErr3) return { error: pipeErr3 };
                const results = await coll.aggregate(tsPipeline, { maxTimeMS, allowDiskUse: false }).toArray();
                return { count: results.length, series: results };
            }
            default:
                return { error: `Unknown operation "${operation}". Supported: find, findOne, count, aggregate, distinct, groupBy, timeSeries` };
        }
    } catch (err) {
        const safeMessage = err.message.replace(/mongodb(\+srv)?:\/\/[^\s]*/gi, '[redacted]');
        return { error: safeMessage };
    }
}

function createMongoQueryTool(projectMongoUrl) {
    const toolDef = {
        type: 'function',
        function: {
            name: 'mongo_query',
            description: `Query the linked Greta v2 project's MongoDB database. Read-only — cannot modify data. Supports analytics: counting, grouping, time-series, and aggregation pipelines.`,
            parameters: {
                type: 'object',
                properties: {
                    operation: { type: 'string', enum: ['find', 'findOne', 'count', 'aggregate', 'distinct', 'groupBy', 'timeSeries'], description: '"find" — list documents. "findOne" — single document. "count" — count matching docs. "aggregate" — custom pipeline. "distinct" — unique values. "groupBy" — count/sum/avg grouped by field. "timeSeries" — count or sum over time buckets.' },
                    collection: { type: 'string', description: 'MongoDB collection name (e.g. "users", "orders").' },
                    filter: { type: 'object', description: 'MongoDB query filter. Omit to match all.' },
                    pipeline: { type: 'array', description: 'Aggregation pipeline for "aggregate".', items: { type: 'object' } },
                    limit: { type: 'number', description: 'Max documents to return (1–100, default 20).' },
                    sort: { type: 'object', description: 'Sort order, e.g. {"createdAt": -1}.' },
                    projection: { type: 'object', description: 'Fields to include/exclude.' },
                    field: { type: 'string', description: 'Field name for "distinct" or "groupBy".' },
                    groupBy: { type: 'string', description: 'Field to group by.' },
                    metric: { type: 'string', enum: ['count', 'sum', 'avg'], description: 'Aggregation metric (default: "count").' },
                    metricField: { type: 'string', description: 'Numeric field to sum/avg.' },
                    dateField: { type: 'string', description: 'Date field for "timeSeries" (default: "createdAt").' },
                    timePeriod: { type: 'string', enum: ['hour', 'day', 'week', 'month', 'year'], description: 'Time bucket size (default: "day").' },
                },
                required: ['operation', 'collection'],
            },
        },
    };

    return {
        toolDef,
        execute: (args) => executeMongoQuery(projectMongoUrl, args),
    };
}

module.exports = { createMongoQueryTool };
