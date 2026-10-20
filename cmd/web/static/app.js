const API = window.PASCAL_API_URL || '';
const BOT_URL = window.PASCAL_BOT_URL || '';
const app = document.getElementById('app');

// --- Router ---

function route() {
    const hash = location.hash || '#dashboard';
    document.querySelectorAll('.nav-link').forEach(a => {
        a.classList.toggle('active', hash.startsWith(a.getAttribute('href')));
    });

    if (hash === '#dashboard') return renderDashboard();
    if (hash === '#records') return renderRecords();
    if (hash === '#recipes') return renderRecipes();
    if (hash === '#recipes/new') return renderRecipeForm(null);
    if (hash.startsWith('#recipes/edit/')) return renderRecipeForm(decodeURIComponent(hash.slice('#recipes/edit/'.length)));

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
        </div>
        <div class="stats-row" id="dash-stats"></div>
    `;

    const [server, bot, web] = await Promise.all([
        healthCheck(API + '/api/health'),
        healthCheck(BOT_URL + '/health'),
        healthCheck('/health'),
    ]);

    renderHealthCard('h-server', server);
    renderHealthCard('h-bot', bot);
    renderHealthCard('h-web', web);

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
    const ok = data.status && data.status !== 'down';
    el.innerHTML = `
        <h3>${el.querySelector('h3')?.textContent || ''}</h3>
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
                <span class="category">${esc(r.cg)}</span>
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
                <thead><tr><th>Usecase</th><th>Description</th><th>Values</th><th>Tags</th></tr></thead>
                <tbody>
                    ${recipes.map(r => `
                        <tr class="clickable" onclick="location.hash='#recipes/edit/${encodeURIComponent(r.u)}'">
                            <td><strong>${esc(r.u)}</strong></td>
                            <td>${esc(r.d)}</td>
                            <td><span class="badge">${(r.values || []).length}</span></td>
                            <td><span class="badge">${(r.tags || []).length}</span></td>
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
let _tags = null;

async function loadOptions() {
    if (!_masterValues) {
        _masterValues = await api('/api/master-values').catch(() => []);
    }
    if (!_tags) {
        _tags = await api('/api/tags').catch(() => []);
    }
}

async function renderRecipeForm(usecase) {
    app.innerHTML = '<p>Loading...</p>';
    await loadOptions();

    let recipe = { u: '', d: '', values: [], tags: [] };
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
                <label>Values (master_value bindings)</label>
                <div class="dynamic-list" id="rf-values"></div>
                <button type="button" class="add-row" onclick="addValueRow()">+ Add Value</button>
            </div>

            <div class="form-group">
                <label>Tags</label>
                <div class="dynamic-list" id="rf-tags"></div>
                <button type="button" class="add-row" onclick="addTagRow()">+ Add Tag</button>
            </div>

            <div class="form-actions">
                <button type="submit" class="btn btn-primary">${isEdit ? 'Save Changes' : 'Create Recipe'}</button>
                ${isEdit ? `<button type="button" class="btn btn-danger" onclick="deleteRecipe('${esc(recipe.u)}')">Delete</button>` : ''}
            </div>
        </form>
    `;

    // Populate existing values/tags
    (recipe.values || []).forEach(v => addValueRow(v.master_key, v.required));
    (recipe.tags || []).forEach(t => addTagRow(t.tag, t.required));

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

function addTagRow(tag, required) {
    const container = document.getElementById('rf-tags');
    const row = document.createElement('div');
    row.className = 'dynamic-row';
    row.innerHTML = `
        <select class="rt-tag">
            <option value="">-- select --</option>
            ${(_tags || []).map(t => `<option value="${esc(t.t)}" ${t.t === tag ? 'selected' : ''}>${esc(t.t)}${t.d ? ' — ' + esc(t.d) : ''}</option>`).join('')}
        </select>
        <label><input type="checkbox" class="rt-req" ${required !== false ? 'checked' : ''}> Required</label>
        <button type="button" class="btn-remove" onclick="this.closest('.dynamic-row').remove()">×</button>
    `;
    container.appendChild(row);
}

async function saveRecipe(isEdit) {
    const u = document.getElementById('rf-u').value.trim();
    const d = document.getElementById('rf-d').value.trim();
    if (!u || !d) return alert('Usecase and description required.');

    const values = [...document.querySelectorAll('#rf-values .dynamic-row')].map(row => ({
        master_key: row.querySelector('.rv-key').value,
        required: row.querySelector('.rv-req').checked,
    })).filter(v => v.master_key);

    const tags = [...document.querySelectorAll('#rf-tags .dynamic-row')].map(row => ({
        tag: row.querySelector('.rt-tag').value,
        required: row.querySelector('.rt-req').checked,
    })).filter(t => t.tag);

    const body = JSON.stringify({ u, d, values, tags });

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

// --- Util ---

function esc(s) {
    if (s == null) return '';
    const d = document.createElement('div');
    d.textContent = String(s);
    return d.innerHTML;
}
