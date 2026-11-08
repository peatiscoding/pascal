// client.js — API client for PASCAL server
const API = window.PASCAL_API_URL || '';
const BOT_URL = window.PASCAL_BOT_URL || '';

async function api(path, opts) {
    const resp = await fetch(API + path, opts);
    if (!resp.ok) {
        const text = await resp.text();
        throw new Error(text || resp.statusText);
    }
    if (resp.status === 204) return null;
    return resp.json();
}

async function healthCheck(url) {
    try {
        const resp = await fetch(url, { signal: AbortSignal.timeout(3000) });
        if (!resp.ok) return { status: 'down' };
        return await resp.json();
    } catch {
        return { status: 'down' };
    }
}

// --- Records ---

const Client = {
    // Health
    checkServer()  { return healthCheck(API + '/api/health'); },
    checkBot()     { return healthCheck(BOT_URL + '/health'); },
    checkMcp()     { return healthCheck(API + '/api/mcp/probe'); },

    // Records
    listRecords()              { return api('/api/records'); },
    createRecord(body)         { return api('/api/records', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); },
    updateRecord(hexId, body)  { return api('/api/records/' + hexId, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); },
    deleteRecord(hexId)        { return api('/api/records/' + hexId, { method: 'DELETE' }); },

    // Recipes
    listRecipes()              { return api('/api/recipes'); },
    getRecipe(u)               { return api('/api/recipes/' + encodeURIComponent(u)); },
    createRecipe(body)         { return api('/api/recipes', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); },
    updateRecipe(u, body)      { return api('/api/recipes/' + encodeURIComponent(u), { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); },
    deleteRecipe(u)            { return api('/api/recipes/' + encodeURIComponent(u), { method: 'DELETE' }); },

    // Ingestion / Drafts
    listDrafts() {
        return fetch(API + '/api/ingest/text').then(r => r.ok ? r.json() : []).catch(() => []);
    },
    ingestText(body) {
        return fetch(API + '/api/ingest/text', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        }).then(async r => {
            const data = await r.json();
            return { ok: r.ok, data };
        });
    },
    getDraft(id) {
        return fetch(API + '/api/ingest/text/' + id).then(async r => {
            if (!r.ok) return null;
            return r.json();
        });
    },
    dismissDraft(id) {
        return api('/api/ingest/text/' + id, { method: 'DELETE' }).catch(() => {});
    },

    // Tags
    listTags()                 { return api('/api/tags'); },
    createTag(body)            { return api('/api/tags', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); },
    updateTag(t, body)         { return api('/api/tags/' + encodeURIComponent(t), { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); },
    deleteTag(t)               { return api('/api/tags/' + encodeURIComponent(t), { method: 'DELETE' }); },

    // Scopes
    listScopes()               { return api('/api/scopes'); },
    createScope(body)          { return api('/api/scopes', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); },
    updateScope(id, body)      { return api('/api/scopes/' + id, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); },
    deleteScope(id)            { return api('/api/scopes/' + id, { method: 'DELETE' }); },

    // Master Values
    listValues()               { return api('/api/master-values'); },
    createValue(body)          { return api('/api/master-values', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); },
    updateValue(k, body)       { return api('/api/master-values/' + encodeURIComponent(k), { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); },
    deleteValue(k)             { return api('/api/master-values/' + encodeURIComponent(k), { method: 'DELETE' }); },

    // Logs (SSE)
    botLogSource()             { return new EventSource(API + '/api/logs/bot'); },

    // WebSocket
    connectWS(onMessage) {
        const wsBase = API || location.origin;
        const proto = wsBase.startsWith('https') ? 'wss:' : 'ws:';
        const host = wsBase.replace(/^https?:\/\//, '');
        const ws = new WebSocket(proto + '//' + host + '/ws');
        ws.onmessage = onMessage;
        return ws;
    },
};
