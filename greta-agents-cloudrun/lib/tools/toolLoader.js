const { tool } = require('@langchain/core/tools');
const { z } = require('zod');
const { MongoClient } = require('mongodb');
const axios = require('axios');
const { createSelfConfigTools } = require('./selfConfigTools');

class ToolLoader {
    constructor({ backendGatewayUrl, gatewaySignature, mongoConnectionString, agentId, userId }) {
        this.backendGatewayUrl = backendGatewayUrl;
        this.gatewaySignature = gatewaySignature;
        this.agentId = agentId;
        this.userId = userId;
        this.mongoConnectionString = mongoConnectionString;
        this.mongoClient = null;

        console.log('[ToolLoader] Initialized with SECURE gateway mode');
    }

    async loadAll(agent) {
        const tools = [];

        if (agent.onboardingStatus === 'in_progress') {
            const selfConfigTools = createSelfConfigTools({
                agentId: this.agentId,
                userId: this.userId,
                gatewayUrl: this.backendGatewayUrl,
                composioApps: agent.composioApps || []
            });
            tools.push(...selfConfigTools);
            console.log(`[ToolLoader] Loaded ${selfConfigTools.length} self-config tools (onboarding)`);
        }

        if (agent.composioEnabled && agent.composioApps?.length > 0 && this.backendGatewayUrl) {
            try {
                const composioTools = await this.loadComposioTools(agent.composioApps);
                tools.push(...composioTools);
                console.log(`[ToolLoader] Loaded ${composioTools.length} Composio tools via gateway`);
            } catch (error) {
                console.error('[ToolLoader] Failed to load Composio tools:', error);
            }
        }

        if (agent.hasMongodb && this.mongoConnectionString) {
            const mongoTools = this.createMongoTools(agent);
            tools.push(...mongoTools);
            console.log(`[ToolLoader] Loaded ${mongoTools.length} MongoDB tools`);
        }

        if (agent.webhookConfig?.allowedUrls?.length > 0) {
            tools.push(this.createWebhookTool(agent.webhookConfig.allowedUrls, agent.agentId));
            console.log('[ToolLoader] Loaded 1 webhook tool');
        }

        console.log(`[ToolLoader] Total tools loaded: ${tools.length}`);
        return tools;
    }

    async loadComposioTools(apps) {
        const response = await axios.post(
            `${this.backendGatewayUrl}/api/greta/gateway/composio/tools`,
            { agentId: this.agentId, userId: this.userId, apps },
            { headers: { 'x-gateway-signature': this.gatewaySignature } }
        );
        if (!response.data.success) throw new Error(`Gateway rejected: ${response.data.error}`);
        return (response.data.tools || []).map(toolDef => this.createGatewayProxyTool(toolDef));
    }

    buildZodFromJsonSchema(jsonSchema) {
        const properties = jsonSchema?.properties || {};
        const required = jsonSchema?.required || [];
        const zodShape = {};
        for (const [key, value] of Object.entries(properties)) {
            let zodType;
            switch (value.type) {
                case 'string': zodType = z.string(); break;
                case 'number': case 'integer': zodType = z.number(); break;
                case 'boolean': zodType = z.boolean(); break;
                case 'array': zodType = z.array(z.any()); break;
                case 'object': zodType = z.record(z.any()); break;
                default: zodType = z.any(); break;
            }
            if (value.description) zodType = zodType.describe(value.description);
            if (!required.includes(key)) zodType = zodType.optional();
            zodShape[key] = zodType;
        }
        return Object.keys(zodShape).length > 0 ? z.object(zodShape) : z.record(z.any());
    }

    createGatewayProxyTool(toolDef) {
        const name = toolDef.function?.name || toolDef.name;
        const description = toolDef.function?.description || toolDef.description || '';
        const jsonSchema = toolDef.function?.parameters || toolDef.parameters || {};
        const schema = this.buildZodFromJsonSchema(jsonSchema);

        return tool(
            async (params) => {
                try {
                    const response = await axios.post(
                        `${this.backendGatewayUrl}/api/greta/gateway/composio/execute`,
                        { agentId: this.agentId, userId: this.userId, action: name, params },
                        { headers: { 'Content-Type': 'application/json', 'x-gateway-signature': this.gatewaySignature } }
                    );
                    if (!response.data.success) throw new Error(response.data.error || 'Tool execution failed');
                    return JSON.stringify(response.data.data);
                } catch (error) {
                    if (error.response?.status === 403) return `Permission denied: ${error.response.data.error}`;
                    return `Error executing ${name}: ${error.message}`;
                }
            },
            { name, description, schema }
        );
    }

    async getMongoConnection() {
        if (!this.mongoClient) {
            this.mongoClient = await MongoClient.connect(this.mongoConnectionString, { maxPoolSize: 10, minPoolSize: 1 });
        }
        return this.mongoClient.db();
    }

    createMongoTools(agent) {
        return [
            this.createMongoFindTool(agent),
            this.createMongoInsertTool(agent),
            this.createMongoUpdateTool(agent),
            this.createMongoDeleteTool(agent),
        ];
    }

    createMongoFindTool(agent) {
        return tool(
            async ({ collection, filter, limit, sort }) => {
                try {
                    const db = await this.getMongoConnection();
                    let finalFilter = filter || {};
                    if (agent.accessLevel === 'SELF' && agent.userId) finalFilter = { ...finalFilter, userId: agent.userId };
                    const query = db.collection(collection).find(finalFilter);
                    if (sort) query.sort(sort);
                    if (limit) query.limit(Math.min(limit, 100));
                    const docs = await query.toArray();
                    return docs.length === 0 ? `No documents found in "${collection}".` : JSON.stringify(docs, null, 2);
                } catch (error) { return `Error querying MongoDB: ${error.message}`; }
            },
            {
                name: 'mongo_find',
                description: 'Query documents from a MongoDB collection. READ-ONLY.',
                schema: z.object({
                    collection: z.string().describe('Collection name'),
                    filter: z.record(z.any()).optional().describe('MongoDB filter'),
                    limit: z.number().optional().describe('Max documents (max 100)'),
                    sort: z.record(z.any()).optional().describe('Sort order'),
                }),
            }
        );
    }

    createMongoInsertTool(agent) {
        return tool(
            async ({ collection, document }) => {
                try {
                    const db = await this.getMongoConnection();
                    const result = await db.collection(collection).insertOne({ ...document, createdAt: new Date() });
                    return `Inserted document with _id: ${result.insertedId}`;
                } catch (error) { return `Error inserting: ${error.message}`; }
            },
            {
                name: 'mongo_insert',
                description: 'Insert a new document into a MongoDB collection.',
                schema: z.object({
                    collection: z.string().describe('Collection name'),
                    document: z.record(z.any()).describe('Document to insert'),
                }),
            }
        );
    }

    createMongoUpdateTool(agent) {
        return tool(
            async ({ collection, filter, update }) => {
                try {
                    if (!filter || Object.keys(filter).length === 0) return 'Error: filter is required to prevent bulk updates.';
                    const db = await this.getMongoConnection();
                    const result = await db.collection(collection).updateOne(filter, { $set: { ...update, updatedAt: new Date() } });
                    return result.matchedCount === 0 ? `No document found matching filter.` : `Updated ${result.modifiedCount} document(s).`;
                } catch (error) { return `Error updating: ${error.message}`; }
            },
            {
                name: 'mongo_update',
                description: 'Update a document in a MongoDB collection. Requires a filter.',
                schema: z.object({
                    collection: z.string().describe('Collection name'),
                    filter: z.record(z.any()).describe('Filter to identify the document'),
                    update: z.record(z.any()).describe('Fields to set'),
                }),
            }
        );
    }

    createMongoDeleteTool(agent) {
        return tool(
            async ({ collection, filter }) => {
                try {
                    if (!filter || Object.keys(filter).length === 0) return 'Error: filter is required to prevent bulk deletions.';
                    const db = await this.getMongoConnection();
                    const result = await db.collection(collection).deleteOne(filter);
                    return result.deletedCount === 0 ? `No document found matching filter.` : `Deleted ${result.deletedCount} document(s).`;
                } catch (error) { return `Error deleting: ${error.message}`; }
            },
            {
                name: 'mongo_delete',
                description: 'Delete a document from a MongoDB collection. Requires a filter.',
                schema: z.object({
                    collection: z.string().describe('Collection name'),
                    filter: z.record(z.any()).describe('Filter to identify the document'),
                }),
            }
        );
    }

    createWebhookTool(allowedUrls, agentId) {
        return tool(
            async ({ url, payload, method }) => {
                try {
                    if (!allowedUrls.some(allowed => url.startsWith(allowed))) {
                        return `Error: URL "${url}" is not in the allowed list.`;
                    }
                    const response = await axios({
                        method: (method || 'POST').toLowerCase(), url, data: payload,
                        headers: { 'Content-Type': 'application/json', 'X-Greta-Agent': agentId },
                        timeout: 30000,
                    });
                    return `Webhook successful. Status: ${response.status}. Response: ${JSON.stringify(response.data).slice(0, 500)}`;
                } catch (error) { return `Error calling webhook: ${error.response?.status} ${error.message}`; }
            },
            {
                name: 'call_webhook',
                description: 'Call an external webhook/API endpoint. Only allowed URLs can be called.',
                schema: z.object({
                    url: z.string().url().describe('The webhook URL'),
                    payload: z.any().optional().describe('Request body'),
                    method: z.enum(['GET', 'POST', 'PUT', 'DELETE']).optional().describe('HTTP method (default: POST)'),
                }),
            }
        );
    }

    async cleanup() {
        if (this.mongoClient) {
            await this.mongoClient.close();
            console.log('[ToolLoader] MongoDB connection closed');
        }
    }
}

module.exports = { ToolLoader };
