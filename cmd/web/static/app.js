const API = window.PASCAL_API_URL || '';
const BOT_URL = window.PASCAL_BOT_URL || '';
const app = document.getElementById('app');
let logSource = null;

const STATUS_LABELS = ['Paused', 'Todo', 'Doing', 'Done'];
function statusLabel(st) { return `<span class="badge badge-st-${st}">${STATUS_LABELS[st] || st}</span>`; }

// --- Router ---

function route() {
    if (logSource) { logSource.close(); logSource = null; }
    const hash = location.hash || '#dashboard';
    document.querySelectorAll('cds-header-nav-item.nav-link').forEach(a => {
        const isActive = hash.startsWith(a.getAttribute('href'));
        a.toggleAttribute('active', isActive);
    });

    if (hash === '#dashboard') return renderDashboard();
    if (hash.startsWith('#draft/')) return renderDraft(hash.slice('#draft/'.length));
    if (hash === '#records') return renderRecords();
    if (hash === '#recipes') return renderRecipes();
    if (hash === '#recipes/new') return renderRecipeForm(null);
    if (hash.startsWith('#recipes/edit/')) return renderRecipeForm(decodeURIComponent(hash.slice('#recipes/edit/'.length)));
    if (hash === '#logs') return renderLogs();
    if (hash === '#master') return renderMaster('scopes');
    if (hash === '#master/scopes') return renderMaster('scopes');
    if (hash === '#master/tags') return renderMaster('tags');
    if (hash === '#master/values') return renderMaster('values');

    renderDashboard();
}

window.addEventListener('hashchange', route);
route();

// --- API helpers ---

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

// --- Dashboard ---

async function renderDashboard() {
    app.innerHTML = `
        <h2 style="margin-bottom:1rem">Dashboard</h2>
        <div class="health-grid">
            <div class="health-card" id="h-server"><h3>API Server</h3><span class="health-status loading">checking...</span></div>
            <div class="health-card" id="h-bot"><h3>Discord Bot</h3><span class="health-status loading">checking...</span></div>
            <div class="health-card" id="h-web"><h3>Web UI</h3><span class="health-status loading">checking...</span></div>
            <div class="health-card" id="h-mcp"><h3>MCP Server</h3><span class="health-status loading">checking...</span></div>
        </div>
        <div class="stats-row" id="dash-stats"></div>
    `;

    const [server, bot, web, mcp] = await Promise.all([
        healthCheck(API + '/api/health'),
        healthCheck(BOT_URL + '/health'),
        healthCheck('/health'),
        healthCheck(API + '/api/mcp/probe'),
    ]);

    renderHealthCard('h-server', server);
    renderHealthCard('h-bot', bot);
    renderHealthCard('h-web', web);
    renderHealthCard('h-mcp', mcp);

    // Stats from server health
    if (server.status !== 'down') {
        document.getElementById('dash-stats').innerHTML = `
            <div class="stat-box"><div class="val">${server.record_count ?? '—'}</div><div class="label">Records</div></div>
            <div class="stat-box"><div class="val">${server.queue_depth ?? '—'}</div><div class="label">Queue Depth</div></div>
            <div class="stat-box"><div class="val">${formatUptime(server.uptime_sec)}</div><div class="label">Server Uptime</div></div>
        `;
    }
}

function renderHealthCard(id, data) {
    const el = document.getElementById(id);
    const title = el.dataset.title || el.querySelector('h3')?.textContent || '';
    el.dataset.title = title;
    const ok = data.status && data.status !== 'down';
    el.innerHTML = `
        <h3>${esc(title)}</h3>
        <span class="health-status ${ok ? 'ok' : 'down'}">${ok ? 'Online' : 'Offline'}</span>
        ${ok && data.uptime_sec != null ? `<span class="health-detail">uptime: ${formatUptime(data.uptime_sec)}</span>` : ''}
    `;
}

function formatUptime(sec) {
    if (sec == null) return '—';
    if (sec < 60) return sec + 's';
    if (sec < 3600) return Math.floor(sec / 60) + 'm';
    if (sec < 86400) return Math.floor(sec / 3600) + 'h ' + Math.floor((sec % 3600) / 60) + 'm';
    return Math.floor(sec / 86400) + 'd ' + Math.floor((sec % 86400) / 3600) + 'h';
}

// --- Records ---

async function renderRecords() {
    app.innerHTML = '<h2 style="margin-bottom:1rem">Records</h2><div id="records-list">Loading...</div>';
    try {
        const records = await api('/api/records');
        const el = document.getElementById('records-list');
        if (!records || records.length === 0) {
            el.innerHTML = '<p class="empty">No records yet.</p>';
            return;
        }
        el.innerHTML = records.map(r => `
            <div class="record">
                <strong>${esc(r.tl)}</strong>
                <span class="scope">${esc(r.sc)}</span>
                ${(r.tags || []).map(t => `<span class="badge">${esc(t)}</span>`).join(' ')}
            </div>
        `).join('');
    } catch (e) {
        document.getElementById('records-list').innerHTML = `<p class="empty">Error: ${esc(e.message)}</p>`;
    }
}

// --- Recipes List ---

async function renderRecipes() {
    app.innerHTML = `
        <div class="toolbar">
            <h2>Recipes</h2>
            <a href="#recipes/new" class="btn btn-primary">+ New Recipe</a>
        </div>
        <div id="recipes-list">Loading...</div>
    `;
    try {
        const recipes = await api('/api/recipes');
        const el = document.getElementById('recipes-list');
        if (!recipes || recipes.length === 0) {
            el.innerHTML = '<p class="empty">No recipes yet. Create one to get started.</p>';
            return;
        }
        el.innerHTML = `
            <table>
                <thead><tr><th>Usecase</th><th>Description</th><th>Default Status</th><th>Scopes</th><th>Values</th></tr></thead>
                <tbody>
                    ${recipes.map(r => `
                        <tr class="clickable" onclick="location.hash='#recipes/edit/${encodeURIComponent(r.u)}'">
                            <td><strong>${esc(r.u)}</strong></td>
                            <td>${esc(r.d)}</td>
                            <td>${statusLabel(r.default_st)}</td>
                            <td><span class="badge">${(r.scopes || []).length}</span></td>
                            <td><span class="badge">${(r.values || []).length}</span></td>
                        </tr>
                    `).join('')}
                </tbody>
            </table>
        `;
    } catch (e) {
        document.getElementById('recipes-list').innerHTML = `<p class="empty">Error: ${esc(e.message)}</p>`;
    }
}

// --- Recipe Form ---

let _masterValues = null;
let _scopeOptions = null;

async function loadOptions() {
    if (!_masterValues) {
        _masterValues = await api('/api/master-values').catch(() => []);
    }
    if (!_scopeOptions) {
        _scopeOptions = await api('/api/scopes').catch(() => []);
    }
}

async function renderRecipeForm(usecase) {
    app.innerHTML = '<p>Loading...</p>';
    await loadOptions();

    let recipe = { u: '', d: '', values: [], scopes: [] };
    const isEdit = usecase != null;

    if (isEdit) {
        try {
            recipe = await api('/api/recipes/' + encodeURIComponent(usecase));
        } catch {
            app.innerHTML = `<p class="empty">Recipe not found.</p>`;
            return;
        }
    }

    app.innerHTML = `
        <div class="toolbar">
            <h2>${isEdit ? 'Edit' : 'New'} Recipe</h2>
            <a href="#recipes" class="btn btn-secondary">← Back</a>
        </div>
        <form id="recipe-form">
            <div class="form-group">
                <label>Usecase Key</label>
                <input id="rf-u" value="${esc(recipe.u)}" ${isEdit ? 'disabled' : ''} placeholder="e.g. expense, workout" required>
            </div>
            <div class="form-group">
                <label>Description</label>
                <input id="rf-d" value="${esc(recipe.d)}" placeholder="What this recipe captures" required>
            </div>

            <div class="form-group">
                <label>Default Status</label>
                <select id="rf-dst">
                    ${STATUS_LABELS.map((l, i) => `<option value="${i}" ${(recipe.default_st ?? 1) === i ? 'selected' : ''}>${l}</option>`).join('')}
                </select>
            </div>

            <div class="form-group">
                <label>Values (master_value bindings)</label>
                <div class="dynamic-list" id="rf-values"></div>
                <button type="button" class="add-row" onclick="addValueRow()">+ Add Value</button>
            </div>

            <div class="form-group">
                <label>Scopes</label>
                <div class="dynamic-list" id="rf-scopes"></div>
                <button type="button" class="add-row" onclick="addScopeRow()">+ Add Scope</button>
            </div>

            <div class="form-actions">
                <button type="submit" class="btn btn-primary">${isEdit ? 'Save Changes' : 'Create Recipe'}</button>
                ${isEdit ? `<button type="button" class="btn btn-danger" onclick="deleteRecipe('${esc(recipe.u)}')">Delete</button>` : ''}
            </div>
        </form>
    `;

    // Populate existing values/scopes
    (recipe.values || []).forEach(v => addValueRow(v.master_key, v.required));
    (recipe.scopes || []).forEach(s => addScopeRow(s.scope_id, s.required));

    document.getElementById('recipe-form').onsubmit = async (e) => {
        e.preventDefault();
        await saveRecipe(isEdit);
    };
}

function addValueRow(key, required) {
    const container = document.getElementById('rf-values');
    const row = document.createElement('div');
    row.className = 'dynamic-row';
    row.innerHTML = `
        <select class="rv-key">
            <option value="">-- select --</option>
            ${(_masterValues || []).map(v => `<option value="${esc(v.k)}" ${v.k === key ? 'selected' : ''}>${esc(v.k)} — ${esc(v.d)}</option>`).join('')}
        </select>
        <label><input type="checkbox" class="rv-req" ${required !== false ? 'checked' : ''}> Required</label>
        <button type="button" class="btn-remove" onclick="this.closest('.dynamic-row').remove()">×</button>
    `;
    container.appendChild(row);
}

function addScopeRow(scopeId, required) {
    const container = document.getElementById('rf-scopes');
    const row = document.createElement('div');
    row.className = 'dynamic-row';
    row.innerHTML = `
        <select class="rs-scope">
            <option value="">-- select --</option>
            ${(_scopeOptions || []).map(s => `<option value="${s.id}" ${s.id === scopeId ? 'selected' : ''}>${esc(s.name)}</option>`).join('')}
        </select>
        <label><input type="checkbox" class="rs-req" ${required !== false ? 'checked' : ''}> Required</label>
        <button type="button" class="btn-remove" onclick="this.closest('.dynamic-row').remove()">×</button>
    `;
    container.appendChild(row);
}

async function saveRecipe(isEdit) {
    const u = document.getElementById('rf-u').value.trim();
    const d = document.getElementById('rf-d').value.trim();
    const default_st = parseInt(document.getElementById('rf-dst').value);
    if (!u || !d) return alert('Usecase and description required.');

    const values = [...document.querySelectorAll('#rf-values .dynamic-row')].map(row => ({
        master_key: row.querySelector('.rv-key').value,
        required: row.querySelector('.rv-req').checked,
    })).filter(v => v.master_key);

    const scopes = [...document.querySelectorAll('#rf-scopes .dynamic-row')].map(row => ({
        scope_id: parseInt(row.querySelector('.rs-scope').value),
        required: row.querySelector('.rs-req').checked,
    })).filter(s => s.scope_id);

    const body = JSON.stringify({ u, d, default_st, values, scopes });

    try {
        if (isEdit) {
            await api('/api/recipes/' + encodeURIComponent(u), { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body });
        } else {
            await api('/api/recipes', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
        }
        location.hash = '#recipes';
    } catch (e) {
        alert('Error: ' + e.message);
    }
}

async function deleteRecipe(u) {
    if (!confirm('Delete recipe "' + u + '"? Records referencing it will lose their recipe link.')) return;
    try {
        await api('/api/recipes/' + encodeURIComponent(u), { method: 'DELETE' });
        location.hash = '#recipes';
    } catch (e) {
        alert('Error: ' + e.message);
    }
}

// --- Master Data ---

async function renderMaster(tab) {
    tab = tab || 'scopes';
    app.innerHTML = `
        <h2 style="margin-bottom:0.5rem">Master Data</h2>
        <p style="color:#888;font-size:0.85rem;margin-bottom:1rem">Reference tables used by recipes and records. <strong>Scopes</strong> for hierarchy and tag grouping, <strong>Tags</strong> for filtering (scoped tags are exclusive per record), <strong>Values</strong> for aggregation.</p>
        <div class="master-tabs">
            <a href="#master/scopes" class="tab-btn ${tab === 'scopes' ? 'active' : ''}">Scopes</a>
            <a href="#master/tags" class="tab-btn ${tab === 'tags' ? 'active' : ''}">Tags</a>
            <a href="#master/values" class="tab-btn ${tab === 'values' ? 'active' : ''}">Values</a>
        </div>
        <div id="master-content">Loading...</div>
    `;
    if (tab === 'values') renderMasterValues();
    else if (tab === 'tags') renderMasterTags();
    else if (tab === 'scopes') renderMasterScopes();
}

// --- Master Values tab ---

async function renderMasterValues() {
    const el = document.getElementById('master-content');
    el.innerHTML = 'Loading...';
    try {
        const values = await api('/api/master-values');
        el.innerHTML = `
            <p class="tab-desc">Values define numeric types attached to records (e.g. THB, calories, tokens). Used for <strong>aggregation</strong> — summing, averaging, and charting over time.</p>
            <div class="toolbar" style="margin-top:1rem">
                <span>${(values || []).length} value type(s)</span>
                <button class="btn btn-primary btn-sm" onclick="showMasterValueForm()">+ Add</button>
            </div>
            <div id="mv-form-slot"></div>
            <table>
                <thead><tr><th>Key</th><th>Description</th><th></th></tr></thead>
                <tbody>
                    ${(values || []).map(v => `
                        <tr>
                            <td><strong>${esc(v.k)}</strong></td>
                            <td>${esc(v.d)}</td>
                            <td style="text-align:right">
                                <button class="btn btn-secondary btn-sm" onclick="showMasterValueForm('${esc(v.k)}','${esc(v.d)}')">Edit</button>
                                <button class="btn btn-danger btn-sm" onclick="deleteMasterValue('${esc(v.k)}')">Delete</button>
                            </td>
                        </tr>
                    `).join('')}
                </tbody>
            </table>
        `;
    } catch (e) {
        el.innerHTML = `<p class="empty">Error: ${esc(e.message)}</p>`;
    }
}

function showMasterValueForm(key, desc) {
    const isEdit = key != null;
    document.getElementById('mv-form-slot').innerHTML = `
        <form class="inline-form" onsubmit="saveMasterValue(event, ${isEdit})">
            <input id="mv-k" value="${esc(key || '')}" placeholder="Key (e.g. THB)" ${isEdit ? 'disabled' : ''} required>
            <input id="mv-d" value="${esc(desc || '')}" placeholder="Description" required style="flex:2">
            <button type="submit" class="btn btn-primary btn-sm">${isEdit ? 'Save' : 'Add'}</button>
            <button type="button" class="btn btn-secondary btn-sm" onclick="this.closest('.inline-form').remove()">Cancel</button>
        </form>
    `;
    document.getElementById(isEdit ? 'mv-d' : 'mv-k').focus();
}

async function saveMasterValue(e, isEdit) {
    e.preventDefault();
    const k = document.getElementById('mv-k').value.trim();
    const d = document.getElementById('mv-d').value.trim();
    if (!k || !d) return;
    try {
        if (isEdit) {
            await api('/api/master-values/' + encodeURIComponent(k), { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ k, d }) });
        } else {
            await api('/api/master-values', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ k, d }) });
        }
        _masterValues = null; // invalidate cache
        renderMasterValues();
    } catch (e) { alert('Error: ' + e.message); }
}

async function deleteMasterValue(k) {
    if (!confirm('Delete value type "' + k + '"?')) return;
    try {
        await api('/api/master-values/' + encodeURIComponent(k), { method: 'DELETE' });
        _masterValues = null;
        renderMasterValues();
    } catch (e) { alert('Error: ' + e.message); }
}

// --- Tags tab ---

let _tagsCache = [];
let _scopesCache = [];

async function renderMasterTags() {
    const el = document.getElementById('master-content');
    el.innerHTML = 'Loading...';
    try {
        const [tags, scopes] = await Promise.all([
            api('/api/tags'),
            api('/api/scopes'),
        ]);
        _tagsCache = tags || [];
        _scopesCache = scopes || [];
        el.innerHTML = `
            <p class="tab-desc">Tags label records for <strong>filtering</strong>. A tag can optionally belong to a <strong>scope</strong> — tags sharing the same scope are <strong>exclusive</strong> (one per record per scope). Tags without a scope attach freely.</p>
            <div class="toolbar" style="margin-top:1rem">
                <span>${_tagsCache.length} tag(s)</span>
                <button class="btn btn-primary btn-sm" onclick="showTagForm()">+ Add</button>
            </div>
            <div id="tag-form-slot"></div>
            <table>
                <thead><tr><th>Scope</th><th>Tag Key</th><th>Description</th><th></th></tr></thead>
                <tbody>
                    ${_tagsCache.slice().sort((a, b) => (a.scope_name || '').localeCompare(b.scope_name || '') || a.t.localeCompare(b.t)).map(t => `
                        <tr>
                            <td>${t.scope_name ? esc(t.scope_name) : '<span style="color:#888">*</span>'}</td>
                            <td><strong>${esc(t.t)}</strong></td>
                            <td>${t.d ? esc(t.d) : ''}</td>
                            <td style="text-align:right">
                                <button class="btn btn-secondary btn-sm" onclick="showTagForm('${esc(t.t)}',${t.s ?? 'null'},'${esc(t.d)}')">Edit</button>
                                <button class="btn btn-danger btn-sm" onclick="deleteTagItem('${esc(t.t)}')">Delete</button>
                            </td>
                        </tr>
                    `).join('')}
                </tbody>
            </table>
        `;
    } catch (e) {
        el.innerHTML = `<p class="empty">Error: ${esc(e.message)}</p>`;
    }
}

function showTagForm(tag, scopeId, desc) {
    const isEdit = tag != null;
    const scopeOptions = _scopesCache
        .map(s => `<option value="${s.id}" ${s.id === scopeId ? 'selected' : ''}>${esc(s.name)}</option>`)
        .join('');
    document.getElementById('tag-form-slot').innerHTML = `
        <form class="inline-form" onsubmit="saveTag(event, ${isEdit})">
            <select id="tf-scope"><option value="">No scope (free tag)</option>${scopeOptions}</select>
            <input id="tf-t" value="${esc(tag || '')}" placeholder="Tag key" pattern="[a-zA-Z0-9\\-]+" title="Alphanumeric and dashes only" ${isEdit ? 'disabled' : ''} required>
            <input id="tf-d" value="${esc(desc || '')}" placeholder="Description (optional)" style="flex:2">
            <button type="submit" class="btn btn-primary btn-sm">${isEdit ? 'Save' : 'Add'}</button>
            <button type="button" class="btn btn-secondary btn-sm" onclick="this.closest('.inline-form').remove()">Cancel</button>
        </form>
    `;
    document.getElementById(isEdit ? 'tf-d' : 'tf-t').focus();
}

async function saveTag(e, isEdit) {
    e.preventDefault();
    const t = document.getElementById('tf-t').value.trim();
    const scopeVal = document.getElementById('tf-scope').value;
    const s = scopeVal ? parseInt(scopeVal) : null;
    const d = document.getElementById('tf-d').value.trim();
    if (!t) return;
    try {
        if (isEdit) {
            await api('/api/tags/' + encodeURIComponent(t), { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ t, s, d }) });
        } else {
            await api('/api/tags', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ t, s, d }) });
        }
        _tagsCache = [];
        renderMasterTags();
    } catch (e) { alert('Error: ' + e.message); }
}

async function deleteTagItem(t) {
    if (!confirm('Delete tag "' + t + '"?')) return;
    try {
        await api('/api/tags/' + encodeURIComponent(t), { method: 'DELETE' });
        _tagsCache = [];
        renderMasterTags();
    } catch (e) { alert('Error: ' + e.message); }
}

// --- Scopes tab (tree UI) ---

let _scopesData = [];

async function renderMasterScopes() {
    const el = document.getElementById('master-content');
    el.innerHTML = 'Loading...';
    try {
        _scopesData = await api('/api/scopes') || [];
        el.innerHTML = `
            <p class="tab-desc">Scopes define the organizational hierarchy and serve as tag grouping. Each record has exactly <strong>one</strong> scope. Tags linked to a scope are exclusive — one per scope per record. (e.g. Work|ProjectX, Personal|Health).</p>
            <div class="toolbar" style="margin-top:1rem">
                <span>${_scopesData.length} scope(s)</span>
                <button class="btn btn-primary btn-sm" onclick="showScopeForm(null, null)">+ Add Root</button>
            </div>
            <div id="scope-tree" class="scope-tree">${buildScopeTree(_scopesData, null, 0)}</div>
        `;
    } catch (e) {
        el.innerHTML = `<p class="empty">Error: ${esc(e.message)}</p>`;
    }
}

function buildScopeTree(scopes, parentId, depth) {
    const children = scopes.filter(s => (s.parent_id ?? null) === parentId);
    if (children.length === 0 && depth > 0) return '';
    return children.map(s => {
        const childHtml = buildScopeTree(scopes, s.id, depth + 1);
        const hasChildren = scopes.some(c => (c.parent_id ?? null) === s.id);
        return `
            <div class="tree-node" data-id="${s.id}">
                <div class="tree-row" style="padding-left:${depth * 1.5}rem">
                    <span class="tree-toggle">${hasChildren ? '▾' : '<span style="visibility:hidden">▾</span>'}</span>
                    <span class="tree-icon">${hasChildren ? '📁' : '📄'}</span>
                    <span class="tree-label">${esc(s.name)}</span>
                    <span class="tree-path">${buildScopePath(scopes, s)}</span>
                    <span class="tree-actions">
                        <button class="btn btn-secondary btn-sm" onclick="showScopeForm(${s.id}, ${s.parent_id ?? 'null'}, '${esc(s.name)}')">Edit</button>
                        <button class="btn btn-primary btn-sm" onclick="showScopeForm(null, ${s.id})">+ Child</button>
                        <button class="btn btn-danger btn-sm" onclick="deleteScopeItem(${s.id}, '${esc(s.name)}')">Delete</button>
                    </span>
                </div>
                <div class="tree-form-slot" id="scope-form-${s.id}"></div>
                <div class="tree-children">${childHtml}</div>
            </div>`;
    }).join('');
}

function buildScopePath(scopes, node) {
    const parts = [];
    let current = node;
    while (current) {
        parts.unshift(current.name);
        current = scopes.find(s => s.id === current.parent_id);
    }
    return parts.length > 1 ? `<span class="tree-path-text">${parts.map(esc).join(' | ')}</span>` : '';
}

function showScopeForm(editId, parentId, name) {
    // Clear any existing scope forms
    document.querySelectorAll('.tree-form-slot').forEach(s => s.innerHTML = '');

    const isEdit = editId != null;
    const slotId = isEdit ? `scope-form-${editId}` : (parentId != null ? `scope-form-${parentId}` : null);

    const formHtml = `
        <form class="inline-form tree-inline-form" onsubmit="saveScope(event, ${isEdit ? editId : 'null'}, ${parentId ?? 'null'})">
            <input id="sf-name" value="${esc(name || '')}" placeholder="${isEdit ? 'Rename scope' : 'New scope name'}" required>
            <button type="submit" class="btn btn-primary btn-sm">${isEdit ? 'Save' : 'Add'}</button>
            <button type="button" class="btn btn-secondary btn-sm" onclick="this.closest('.inline-form').remove()">Cancel</button>
        </form>
    `;

    if (slotId) {
        const slot = document.getElementById(slotId);
        if (slot) { slot.innerHTML = formHtml; document.getElementById('sf-name').focus(); return; }
    }
    // Root-level add — insert before tree
    const tree = document.getElementById('scope-tree');
    tree.insertAdjacentHTML('beforebegin', `<div id="scope-root-form">${formHtml}</div>`);
    document.getElementById('sf-name').focus();
}

async function saveScope(e, id, parentId) {
    e.preventDefault();
    const name = document.getElementById('sf-name').value.trim();
    if (!name) return;
    const parent_id = parentId;
    try {
        if (id != null) {
            await api('/api/scopes/' + id, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, parent_id: _scopesData.find(s => s.id === id)?.parent_id ?? null }) });
        } else {
            await api('/api/scopes', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, parent_id }) });
        }
        renderMasterScopes();
    } catch (e) { alert('Error: ' + e.message); }
}

async function deleteScopeItem(id, name) {
    if (!confirm('Delete scope "' + name + '" and all children?')) return;
    try {
        await api('/api/scopes/' + id, { method: 'DELETE' });
        renderMasterScopes();
    } catch (e) { alert('Error: ' + e.message); }
}

// --- Ingest Spotlight ---

function openSpotlight() {
    if (document.getElementById('spotlight-overlay')) return;
    const overlay = document.createElement('div');
    overlay.id = 'spotlight-overlay';
    overlay.className = 'spotlight-overlay';
    overlay.innerHTML = `
        <div class="spotlight-box">
            <input id="spotlight-input" type="text" placeholder="Log something... e.g. Lunch 200 THB promptpay" autocomplete="off">
            <div id="spotlight-hint" class="spotlight-hint">\u21B5 to send \u00b7 esc to close</div>
        </div>
    `;
    document.body.appendChild(overlay);

    const input = document.getElementById('spotlight-input');
    const hint = document.getElementById('spotlight-hint');
    input.focus();

    overlay.onclick = (e) => { if (e.target === overlay) closeSpotlight(); };

    input.onkeydown = async (e) => {
        if (e.key === 'Escape') { closeSpotlight(); return; }
        if (e.key === 'Enter') {
            const text = input.value.trim();
            if (!text) return;
            input.disabled = true;
            hint.textContent = 'Sending...';
            try {
                const resp = await fetch(API + '/api/ingest/text', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ text, source: 'web' }),
                });
                const data = await resp.json();
                if (resp.ok) {
                    closeSpotlight();
                    location.hash = '#draft/' + data.queue_id;
                } else {
                    hint.textContent = 'Error: ' + (data.error || resp.statusText);
                    hint.style.color = '#da1e28';
                    input.disabled = false;
                }
            } catch (err) {
                hint.textContent = 'Error: ' + err.message;
                hint.style.color = '#da1e28';
                input.disabled = false;
            }
        }
    };
}

function closeSpotlight() {
    const el = document.getElementById('spotlight-overlay');
    if (el) el.remove();
}

// Cmd+K / Ctrl+K global shortcut
document.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault();
        openSpotlight();
    }
});

// --- Draft ---

let draftPollTimer = null;

function renderDraft(queueId) {
    if (draftPollTimer) { clearInterval(draftPollTimer); draftPollTimer = null; }

    app.innerHTML = `
        <h2 style="margin-bottom:1rem">Draft #${queueId}</h2>
        <div id="draft-content"><p style="color:#888">Loading...</p></div>
    `;

    async function poll() {
        try {
            const resp = await fetch(API + '/api/ingest/text/' + queueId);
            if (!resp.ok) {
                document.getElementById('draft-content').innerHTML = `<p style="color:#dc2626">Queue item not found.</p>`;
                clearInterval(draftPollTimer);
                return;
            }
            const item = await resp.json();
            renderDraftContent(item, queueId);
        } catch (e) {
            document.getElementById('draft-content').innerHTML = `<p style="color:#dc2626">Error: ${e.message}</p>`;
        }
    }

    poll();
    draftPollTimer = setInterval(poll, 1500);
}

function renderDraftContent(item, queueId) {
    const el = document.getElementById('draft-content');
    if (!el) return;

    if (item.status === 'pending' || item.status === 'processing') {
        el.innerHTML = `
            <div class="draft-status">
                <p>Processing... <span class="badge">${item.status}</span></p>
                <p style="color:#888;font-size:0.85rem;margin-top:0.5rem">Input: ${escHtml(item.payload)}</p>
            </div>
        `;
        return;
    }

    if (item.status === 'failed') {
        clearInterval(draftPollTimer);
        el.innerHTML = `
            <div class="draft-status">
                <p style="color:#dc2626">Failed: ${escHtml(item.error || 'Unknown error')}</p>
                <p style="color:#888;font-size:0.85rem;margin-top:0.5rem">Input: ${escHtml(item.payload)}</p>
                <div style="margin-top:1rem"><a href="#dashboard" class="btn btn-secondary">Back</a> <button class="btn btn-primary" onclick="openSpotlight()">Try again</button></div>
            </div>
        `;
        return;
    }

    if (item.status === 'done') {
        clearInterval(draftPollTimer);
        let result = {};
        try { result = JSON.parse(item.result || '{}'); } catch {}
        el.innerHTML = `
            <div class="draft-status">
                <p style="color:#16a34a;font-weight:600">Record created!</p>
                <p style="margin-top:0.5rem"><strong>${escHtml(result.tl || '')}</strong></p>
                ${result.sc ? `<p style="color:#888;font-size:0.85rem">${escHtml(result.sc)}</p>` : ''}
                <div style="margin-top:1rem">
                    <a href="#records" class="btn btn-secondary">View Records</a>
                    <button class="btn btn-primary" style="margin-left:0.5rem" onclick="openSpotlight()">Log Another</button>
                </div>
            </div>
        `;
        return;
    }

    if (item.status === 'ambiguous') {
        clearInterval(draftPollTimer);
        let result = {};
        try { result = JSON.parse(item.result || '{}'); } catch {}
        const matches = result.matches || [];
        el.innerHTML = `
            <div class="draft-status">
                <p>Multiple recipes match. Pick one:</p>
                <div id="draft-choices" style="margin-top:0.5rem">
                    ${matches.map((r, i) => `<button class="btn btn-secondary" style="margin:0.25rem" data-recipe="${escHtml(r)}">${escHtml(r)}</button>`).join('')}
                </div>
                <p style="color:#888;font-size:0.85rem;margin-top:0.5rem">Input: ${escHtml(item.payload)}</p>
            </div>
        `;
        document.querySelectorAll('#draft-choices button').forEach(btn => {
            btn.onclick = async () => {
                const recipe = btn.dataset.recipe;
                const resp = await fetch(API + '/api/ingest/text', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ text: item.payload, source: 'web', recipe_u: recipe }),
                });
                const data = await resp.json();
                if (resp.ok) location.hash = '#draft/' + data.queue_id;
            };
        });
        return;
    }

    if (item.status === 'needs_input') {
        clearInterval(draftPollTimer);
        let result = {};
        try { result = JSON.parse(item.result || '{}'); } catch {}
        const missing = result.missing || [];
        const partial = result.partial || {};
        el.innerHTML = `
            <div class="draft-status">
                <p>Almost there! Fill in the missing fields:</p>
                <p style="color:#888;font-size:0.85rem;margin-top:0.25rem">Input: ${escHtml(item.payload)}</p>
                <div style="margin-top:1rem">
                    <div class="form-group">
                        <label>Title</label>
                        <input id="draft-tl" value="${escHtml(partial.tl || '')}">
                    </div>
                    <div class="form-group">
                        <label>Scope</label>
                        <div id="draft-sc-input"></div>
                    </div>
                    <div class="form-group">
                        <label>Tags</label>
                        <div id="draft-tags-input"></div>
                    </div>
                    <div class="form-group">
                        <label>Values</label>
                        <div id="draft-values"></div>
                        <button type="button" class="add-row" id="draft-add-value">+ Add value</button>
                    </div>
                    ${missing.length ? `<p style="color:#e67e22;font-size:0.85rem;margin-bottom:0.5rem">Missing: ${missing.join(', ')}</p>` : ''}
                    <div class="form-group">
                        <label>Additional info</label>
                        <textarea id="draft-extra" rows="2" placeholder="Provide missing details..."></textarea>
                    </div>
                    <div class="form-actions">
                        <button id="draft-resubmit" class="btn btn-secondary">Re-process with extra info</button>
                        <button id="draft-save" class="btn btn-primary">Save as-is</button>
                    </div>
                </div>
            </div>
        `;

        // Wire up autocomplete components after master data loads
        let tagInput, scopeInput;
        const valueRows = [];
        fetchMasterData().then(master => {
            const scopeSugs = master.scopes.map(s => ({ value: s.name, label: s.name }));
            const scopeInitial = (partial.sc || '').split('|').filter(Boolean);
            scopeInput = createTagInput(
                document.getElementById('draft-sc-input'), scopeSugs, scopeInitial,
                { allowNew: false, placeholder: 'Select scope...' }
            );

            const tagSugs = master.tags.map(t => ({
                value: t.t, label: t.t,
                hint: t.scope_name ? t.scope_name + (t.d ? ' \u00b7 ' + t.d : '') : (t.d || '')
            }));
            tagInput = createTagInput(
                document.getElementById('draft-tags-input'), tagSugs, partial.tags || [],
                { allowNew: true, placeholder: 'Add tags...' }
            );

            const valSugs = master.values.map(v => ({ value: v.k, label: v.k, hint: v.d }));
            const valContainer = document.getElementById('draft-values');

            function addValueRow(k, v) {
                const row = document.createElement('div');
                row.className = 'value-row';
                const keyBox = document.createElement('div');
                keyBox.style.flex = '1';
                const numInput = document.createElement('input');
                numInput.type = 'number';
                numInput.placeholder = '0';
                numInput.value = v || '';
                const removeBtn = document.createElement('button');
                removeBtn.type = 'button';
                removeBtn.className = 'btn-remove';
                removeBtn.textContent = '\u00d7';
                row.appendChild(keyBox);
                row.appendChild(numInput);
                row.appendChild(removeBtn);
                valContainer.appendChild(row);

                const keyCtrl = createTagInput(keyBox, valSugs, k ? [k] : [], {
                    single: true, placeholder: 'Value key...'
                });
                const entry = { keyCtrl, numInput, removed: false };
                valueRows.push(entry);
                removeBtn.onclick = () => { row.remove(); entry.removed = true; };
            }

            (partial.values || []).forEach(v => addValueRow(v.k, v.v));
            document.getElementById('draft-add-value').onclick = () => addValueRow('', '');
        });

        document.getElementById('draft-resubmit').onclick = async () => {
            const extra = document.getElementById('draft-extra').value.trim();
            if (!extra) return;
            const resp = await fetch(API + '/api/ingest/text', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ text: item.payload + '\n' + extra, source: 'web', recipe_u: item.recipe_u }),
            });
            const data = await resp.json();
            if (resp.ok) location.hash = '#draft/' + data.queue_id;
        };

        document.getElementById('draft-save').onclick = async () => {
            const tl = document.getElementById('draft-tl').value.trim();
            const sc = scopeInput ? scopeInput.getSelected().join('|') : '';
            const tags = tagInput ? tagInput.getSelected() : [];
            const values = [];
            valueRows.forEach(vr => {
                if (vr.removed) return;
                const k = vr.keyCtrl.getSelected()[0] || '';
                const v = parseFloat(vr.numInput.value);
                if (k && !isNaN(v)) values.push({ k, v });
            });

            if (!tl || !sc) { alert('Title and scope required'); return; }

            try {
                await api('/api/records', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ tl, sc, st: partial.st || 3, tags, values, r: item.recipe_u }),
                });
                clearInterval(draftPollTimer);
                el.innerHTML = `
                    <div class="draft-status">
                        <p style="color:#16a34a;font-weight:600">Record saved!</p>
                        <div style="margin-top:1rem">
                            <a href="#records" class="btn btn-secondary">View Records</a>
                            <button class="btn btn-primary" style="margin-left:0.5rem" onclick="openSpotlight()">Log Another</button>
                        </div>
                    </div>
                `;
            } catch (e) {
                alert('Error: ' + e.message);
            }
        };
        return;
    }
}

// --- Tag Input Component ---
// suggestions: [{value, label, hint?}], selected: [string]
// opts: { single, allowNew, onAdd(val), onRemove(val) }
function createTagInput(container, suggestions, selected, opts = {}) {
    const state = { selected: [...selected], activeIdx: -1 };
    const known = new Set(suggestions.map(s => s.value));

    function render() {
        container.innerHTML = '';
        container.classList.add('tag-input');
        state.selected.forEach(val => {
            const chip = document.createElement('span');
            chip.className = 'tag-chip' + (known.has(val) ? '' : ' is-new');
            const sug = suggestions.find(s => s.value === val);
            let label = sug ? sug.label : val;
            if (sug && sug.hint) label += ` <span class="tag-scope">${escHtml(sug.hint)}</span>`;
            chip.innerHTML = label + ' <span class="tag-remove">&times;</span>';
            chip.querySelector('.tag-remove').onclick = (e) => {
                e.stopPropagation();
                state.selected = state.selected.filter(v => v !== val);
                if (opts.onRemove) opts.onRemove(val);
                render();
            };
            container.appendChild(chip);
        });

        const input = document.createElement('input');
        input.placeholder = state.selected.length ? '' : (opts.placeholder || 'Type to search...');
        container.appendChild(input);

        let dropdown = null;

        function showDropdown(filter) {
            hideDropdown();
            const q = filter.toLowerCase();
            let items = suggestions.filter(s =>
                !state.selected.includes(s.value) &&
                (s.label.toLowerCase().includes(q) || s.value.toLowerCase().includes(q))
            );
            if (q && opts.allowNew && !items.find(s => s.value === q) && !state.selected.includes(q)) {
                items.push({ value: q, label: q, hint: 'new', isNew: true });
            }
            if (!items.length) return;

            dropdown = document.createElement('div');
            dropdown.className = 'tag-dropdown';
            state.activeIdx = -1;
            items.forEach((item, i) => {
                const div = document.createElement('div');
                div.className = 'tag-dropdown-item';
                div.innerHTML = escHtml(item.label) + (item.hint ? ` <span class="hint">${escHtml(item.hint)}</span>` : '');
                div.onmouseenter = () => { state.activeIdx = i; highlightActive(); };
                div.onclick = () => pick(item.value);
                dropdown.appendChild(div);
            });
            container.appendChild(dropdown);
        }

        function highlightActive() {
            if (!dropdown) return;
            dropdown.querySelectorAll('.tag-dropdown-item').forEach((el, i) => {
                el.classList.toggle('active', i === state.activeIdx);
            });
        }

        function hideDropdown() {
            if (dropdown) { dropdown.remove(); dropdown = null; state.activeIdx = -1; }
        }

        function pick(val) {
            if (opts.single) state.selected = [val];
            else if (!state.selected.includes(val)) state.selected.push(val);
            if (opts.onAdd) opts.onAdd(val);
            hideDropdown();
            render();
            // re-focus input after render
            const newInput = container.querySelector('input');
            if (newInput) newInput.focus();
        }

        input.oninput = () => showDropdown(input.value);
        input.onfocus = () => { if (input.value || !state.selected.length) showDropdown(input.value); };

        input.onkeydown = (e) => {
            if (e.key === 'Backspace' && !input.value && state.selected.length) {
                const removed = state.selected.pop();
                if (opts.onRemove) opts.onRemove(removed);
                render();
                const newInput = container.querySelector('input');
                if (newInput) newInput.focus();
                return;
            }
            if (!dropdown) return;
            const items = dropdown.querySelectorAll('.tag-dropdown-item');
            if (e.key === 'ArrowDown') { e.preventDefault(); state.activeIdx = Math.min(state.activeIdx + 1, items.length - 1); highlightActive(); }
            else if (e.key === 'ArrowUp') { e.preventDefault(); state.activeIdx = Math.max(state.activeIdx - 1, 0); highlightActive(); }
            else if (e.key === 'Enter') {
                e.preventDefault();
                if (state.activeIdx >= 0 && items[state.activeIdx]) {
                    items[state.activeIdx].click();
                } else if (input.value.trim() && opts.allowNew) {
                    pick(input.value.trim());
                }
            }
            else if (e.key === 'Escape') hideDropdown();
        };

        // close dropdown on outside click
        container._outsideClick = (e) => { if (!container.contains(e.target)) hideDropdown(); };
        document.removeEventListener('click', container._outsideClick);
        document.addEventListener('click', container._outsideClick);

        container.onclick = () => input.focus();
    }

    render();
    return {
        getSelected: () => [...state.selected],
        setSelected: (vals) => { state.selected = [...vals]; render(); },
    };
}

// Fetch master data for autocomplete (cached per page load)
let _masterCache = null;
async function fetchMasterData() {
    if (_masterCache) return _masterCache;
    const [tags, scopes, values] = await Promise.all([
        api('/api/tags').catch(() => []),
        api('/api/scopes').catch(() => []),
        api('/api/master-values').catch(() => []),
    ]);
    _masterCache = { tags: tags || [], scopes: scopes || [], values: values || [] };
    return _masterCache;
}

function escHtml(s) {
    const d = document.createElement('div');
    d.textContent = s;
    return d.innerHTML;
}

// --- Logs ---

function renderLogs() {
    if (logSource) { logSource.close(); logSource = null; }

    app.innerHTML = `
        <h2 style="margin-bottom:1rem">Bot Logs</h2>
        <p style="color:#888;font-size:0.85rem;margin-bottom:1rem">Live Discord message stream.</p>
        <div style="margin-bottom:0.5rem;display:flex;align-items:center;gap:1rem">
            <label><input type="checkbox" id="log-autoscroll" checked> Auto-scroll</label>
            <button id="log-clear" class="btn btn-sm">Clear</button>
        </div>
        <div id="log-container" class="log-container"></div>
    `;

    const container = document.getElementById('log-container');
    document.getElementById('log-clear').onclick = () => { container.innerHTML = ''; };
    logSource = new EventSource(API + '/api/logs/bot');

    logSource.onmessage = (e) => {
        const line = document.createElement('div');
        line.className = 'log-line';
        line.textContent = e.data;
        container.appendChild(line);

        while (container.children.length > 1000) {
            container.removeChild(container.firstChild);
        }

        if (document.getElementById('log-autoscroll')?.checked) {
            container.scrollTop = container.scrollHeight;
        }
    };

    logSource.onerror = () => {
        const line = document.createElement('div');
        line.className = 'log-line log-error';
        line.textContent = '[connection lost, retrying...]';
        container.appendChild(line);
    };
}

// --- WebSocket ---

function connectWS() {
    const wsBase = API || location.origin;
    const proto = wsBase.startsWith('https') ? 'wss:' : 'ws:';
    const host = wsBase.replace(/^https?:\/\//, '');
    const ws = new WebSocket(proto + '//' + host + '/ws');

    ws.onmessage = () => {
        const hash = location.hash || '#dashboard';
        if (hash === '#records') renderRecords();
        if (hash === '#dashboard') renderDashboard();
    };
    ws.onclose = () => setTimeout(connectWS, 2000);
}
connectWS();

// --- Status Dots ---

async function updateStatusDots() {
    const checks = [
        { id: 'dot-server', url: API + '/api/health' },
        { id: 'dot-bot', url: BOT_URL + '/health' },
        { id: 'dot-web', url: '/health' },
        { id: 'dot-mcp', url: API + '/api/mcp/probe' },
    ];
    await Promise.all(checks.map(async ({ id, url }) => {
        const dot = document.getElementById(id);
        if (!dot) return;
        const result = await healthCheck(url);
        dot.className = 'status-dot ' + (result.status && result.status !== 'down' ? 'ok' : 'down');
    }));
}

updateStatusDots();
setInterval(updateStatusDots, 30000);

// --- Util ---

function esc(s) {
    if (s == null) return '';
    const d = document.createElement('div');
    d.textContent = String(s);
    return d.innerHTML;
}
