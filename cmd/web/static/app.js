const API = window.PASCAL_API_URL || '';
const BOT_URL = window.PASCAL_BOT_URL || '';
const app = document.getElementById('app');
let logSource = null;

const STATUS_LABELS = ['Paused', 'Todo', 'Doing', 'Done'];
function statusLabel(st) { return `<span class="badge badge-st-${st}">${STATUS_LABELS[st] || st}</span>`; }
function b64ToHex(b64) { return [...atob(b64)].map(c => c.charCodeAt(0).toString(16).padStart(2, '0')).join(''); }

// --- Mobile nav ---
{
    const menuBtn = document.getElementById('nav-menu-btn');
    const mobileNav = document.getElementById('mobile-nav');
    if (menuBtn && mobileNav) {
        menuBtn.onclick = () => mobileNav.classList.toggle('open');
        mobileNav.querySelectorAll('a').forEach(a => {
            a.addEventListener('click', () => mobileNav.classList.remove('open'));
        });
    }
}

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
        <h2 style="margin-bottom:var(--s-5)">Dashboard</h2>
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

const STATUS_ICONS = ['⏸', '☐', '⚡', '✓'];
const STATUS_ICON_CLASS = ['st-icon-paused', 'st-icon-todo', 'st-icon-doing', 'st-icon-done'];

function statusIcon(st) {
    return `<span class="st-icon ${STATUS_ICON_CLASS[st]}" title="${STATUS_LABELS[st]}">${STATUS_ICONS[st]}</span>`;
}

function recordLine(r, primaryScopeName) {
    const tagInfo = (r.tag_info || []);
    const tagTooltip = tagInfo.length ? esc(tagInfo.map(ti => ti.sp ? ti.sp.replaceAll('|', '.') + ': ' + ti.t : ti.t).join('\n')) : '';
    const values = (r.values || []);
    const date = r.ct ? r.ct.slice(0, 10) : '';

    // If primary scope set, show tag from that scope; otherwise show recipe name
    let firstCol = r.r ? '/' + esc(r.r) : '';
    if (primaryScopeName) {
        const psTag = tagInfo.find(ti => ti.sp && ti.sp.split('|').includes(primaryScopeName));
        firstCol = psTag ? esc(psTag.t) : '<span style="color:var(--ink-4)">—</span>';
    }

    return `<div class="rec-line" data-record='${esc(JSON.stringify(r))}'>
        <span class="rec-recipe">${firstCol}</span>
        <span class="rec-st" data-st="${r.st}">${statusIcon(r.st)}</span>
        <span class="rec-title">${esc(r.tl)}</span>
        ${tagInfo.length ? `<span class="rec-tags" title="${tagTooltip}"><span class="rec-tag-dots">${tagInfo.map(ti => `<span class="rec-dot${ti.sp ? ' rec-dot-scoped' : ''}"></span>`).join('')}</span></span>` : ''}
        <span class="rec-spacer"></span>
        ${values.map(v => `<span class="rec-val"><span class="num">${v.v}</span> <span class="unit">${esc(v.k)}</span></span>`).join('')}
        ${date ? `<span class="rec-date num">${date}</span>` : ''}
        <span class="rec-del" title="Delete">×</span>
    </div>`;
}

function buildDailyChart(records, valueKey) {
    const byDay = {};
    records.forEach(r => {
        const day = (r.ct || '').slice(0, 10);
        if (!day) return;
        (r.values || []).forEach(v => {
            if (v.k === valueKey) {
                byDay[day] = (byDay[day] || 0) + v.v;
            }
        });
    });
    const days = Object.keys(byDay).sort();
    if (days.length < 2) return '';
    const vals = days.map(d => byDay[d]);
    const max = Math.max(...vals);
    const min = Math.min(...vals, 0);
    const range = max - min || 1;
    const w = 280, h = 80, pad = 2;
    const step = (w - pad * 2) / (days.length - 1);
    const points = vals.map((v, i) => `${pad + i * step},${h - pad - ((v - min) / range) * (h - pad * 2)}`).join(' ');
    return `<svg class="rec-chart" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none">
        <polyline points="${points}" fill="none" stroke="var(--mod-stat)" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>
    </svg>`;
}

function buildCarousel(groups) {
    const slides = [];
    for (const [recipe, records] of Object.entries(groups)) {
        const valueKeys = new Set();
        records.forEach(r => (r.values || []).forEach(v => valueKeys.add(v.k)));
        if (valueKeys.size === 0) continue;
        for (const k of valueKeys) {
            const chart = buildDailyChart(records, k);
            if (!chart) continue;
            const total = records.reduce((s, r) => s + (r.values || []).reduce((a, v) => v.k === k ? a + v.v : a, 0), 0);
            slides.push(`<div class="carousel-slide">
                <div class="carousel-header">
                    <span class="rec-recipe">/${esc(recipe || '—')}</span>
                    <span class="num">${total}</span> <span class="unit">${esc(k)}</span>
                </div>
                ${chart}
            </div>`);
        }
    }
    if (slides.length === 0) return '';
    return `<div class="carousel" id="rec-carousel">
        <button class="carousel-prev" onclick="carouselNav(-1)">‹</button>
        <div class="carousel-track">${slides.join('')}</div>
        <button class="carousel-next" onclick="carouselNav(1)">›</button>
    </div>`;
}

window.carouselNav = function(dir) {
    const track = document.querySelector('.carousel-track');
    if (!track) return;
    const slide = track.querySelector('.carousel-slide');
    if (!slide) return;
    const slideW = slide.offsetWidth + 13; // gap
    track.scrollBy({ left: dir * slideW, behavior: 'smooth' });
};

async function renderRecords() {
    app.innerHTML = '<h2 style="margin-bottom:var(--s-5)">Records</h2><div id="records-list">Loading...</div>';
    try {
        const [records, recipes] = await Promise.all([api('/api/records'), api('/api/recipes').catch(() => [])]);
        const el = document.getElementById('records-list');
        if (!records || records.length === 0) {
            el.innerHTML = '<p class="empty">No records yet.</p>';
            return;
        }

        // Build primary scope lookup: recipe usecase → scope name
        const primaryScope = {};
        (recipes || []).forEach(r => { if (r.ps_name) primaryScope[r.u] = r.ps_name; });

        // Group by recipe
        const groups = {};
        const noRecipe = [];
        records.forEach(r => {
            if (r.r) {
                (groups[r.r] = groups[r.r] || []).push(r);
            } else {
                noRecipe.push(r);
            }
        });

        // Build carousel for all page
        const carousel = buildCarousel(groups);

        // Build grouped list
        let html = carousel;
        for (const [recipe, recs] of Object.entries(groups)) {
            const ps = primaryScope[recipe];
            html += `<div class="rec-group">
                <div class="rec-group-header">
                    <span class="rec-recipe">/${esc(recipe)}</span>
                    <span class="rec-group-count num">${recs.length}</span>
                </div>
                ${recs.map(r => recordLine(r, ps)).join('')}
            </div>`;
        }
        if (noRecipe.length) {
            html += `<div class="rec-group">
                <div class="rec-group-header">
                    <span style="color:var(--ink-4)">Uncategorised</span>
                    <span class="rec-group-count num">${noRecipe.length}</span>
                </div>
                ${noRecipe.map(r => recordLine(r)).join('')}
            </div>`;
        }

        el.innerHTML = html;

        // Bind events
        el.querySelectorAll('.rec-line').forEach(div => {
            const r = JSON.parse(div.dataset.record);
            div.querySelector('.rec-del').onclick = (e) => { e.stopPropagation(); deleteRecord(r); };
            div.querySelector('.rec-st').onclick = (e) => { e.stopPropagation(); toggleStatus(r); };
            div.onclick = () => showRecordDetail(r);
        });
    } catch (e) {
        document.getElementById('records-list').innerHTML = `<p class="empty">Error: ${esc(e.message)}</p>`;
    }
}

async function toggleStatus(r) {
    const next = r.st === 1 ? 3 : r.st === 3 ? 1 : (r.st + 1) % 4;
    if (r.r) {
        const recipe = await getRecipe(r.r);
        const missing = checkRequiredValues(recipe, next, r.values);
        if (missing.length > 0 && !confirm(`Missing values required for "${STATUS_LABELS[next]}":\n\n${missing.join(', ')}\n\nContinue anyway?`)) return;
    }
    try {
        await api('/api/records/' + b64ToHex(r.id), {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ st: next })
        });
        renderRecords();
    } catch (e) { alert('Error: ' + e.message); }
}

function showRecordDetail(r) {
    if (document.getElementById('record-detail-overlay')) return;
    const overlay = document.createElement('div');
    overlay.id = 'record-detail-overlay';
    overlay.className = 'spotlight-overlay';
    overlay.innerHTML = `
        <div class="record-detail-box">
            <div class="record-detail-meta" style="margin-bottom:var(--s-5)">
                <span style="color:var(--ink-3);font-size:var(--fs-0)">${esc(r.ct)}</span>
                ${r.r ? `<span class="badge" style="background:var(--mod-act-lt);color:var(--mod-act-dk)">/${esc(r.r)}</span>` : ''}
            </div>
            <div class="form-group">
                <label>Title</label>
                <input id="rd-tl" value="${esc(r.tl)}">
            </div>
            <div class="form-group">
                <label>Detail</label>
                <textarea id="rd-dt" rows="2">${esc(r.dt || '')}</textarea>
            </div>
            <div class="form-group">
                <label>Status</label>
                <select id="rd-st">
                    ${STATUS_LABELS.map((l, i) => `<option value="${i}" ${i === r.st ? 'selected' : ''}>${l}</option>`).join('')}
                </select>
            </div>
            <div class="form-group">
                <label>Tags</label>
                <div id="rd-tags"></div>
            </div>
            <div class="form-group">
                <label>Values</label>
                <div id="rd-values"></div>
                <button type="button" class="add-row" id="rd-add-value">+ Add value</button>
            </div>
            <div style="margin-top:var(--s-5);display:flex;justify-content:space-between">
                <button class="btn btn-danger btn-sm" id="record-detail-delete">Delete</button>
                <div style="display:flex;gap:var(--s-4)">
                    <button class="btn btn-secondary btn-sm" onclick="closeRecordDetail()">Cancel</button>
                    <button class="btn btn-primary btn-sm" id="record-detail-save">Save</button>
                </div>
            </div>
        </div>
    `;
    overlay.addEventListener('click', (e) => {
        if (e.target === overlay) closeRecordDetail();
    });
    document.body.appendChild(overlay);

    // Wire up tag + value inputs
    let tagInput;
    const valueRows = [];
    fetchMasterData().then(master => {
        const tagSugs = master.tags.map(t => ({
            value: t.t, label: t.t,
            hint: t.scope_name ? t.scope_name + (t.d ? ' \u00b7 ' + t.d : '') : (t.d || '')
        }));
        tagInput = createTagInput(
            document.getElementById('rd-tags'), tagSugs, r.tags || [],
            { allowNew: true, placeholder: 'Add tags...' }
        );

        const valSugs = master.values.map(v => ({ value: v.k, label: v.k, hint: v.d }));
        const valContainer = document.getElementById('rd-values');

        function addValueRow(k, v) {
            const row = document.createElement('div');
            row.className = 'value-row';
            const keyBox = document.createElement('div');
            keyBox.style.flex = '1';
            const numInput = document.createElement('input');
            numInput.type = 'number';
            numInput.placeholder = '0';
            numInput.value = v ?? '';
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

        (r.values || []).forEach(v => addValueRow(v.k, v.v));
        document.getElementById('rd-add-value').onclick = () => addValueRow('', '');
    });

    document.getElementById('record-detail-delete').onclick = () => deleteRecord(r);

    document.getElementById('record-detail-save').onclick = async () => {
        const tl = document.getElementById('rd-tl').value.trim();
        const dt = document.getElementById('rd-dt').value.trim();
        const st = parseInt(document.getElementById('rd-st').value);
        const tags = tagInput ? tagInput.getSelected() : [];
        const values = [];
        valueRows.forEach(vr => {
            if (vr.removed) return;
            const k = vr.keyCtrl.getSelected()[0] || '';
            const v = parseFloat(vr.numInput.value);
            if (k && !isNaN(v)) values.push({ k, v });
        });

        if (!tl) { alert('Title required'); return; }

        try {
            if (r.r) {
                const recipe = await getRecipe(r.r);
                const missing = checkRequiredValues(recipe, st, values.map(v => ({ k: v.k })));
                if (missing.length > 0 && !confirm(`Missing values required for "${STATUS_LABELS[st]}":\n\n${missing.join(', ')}\n\nSave anyway?`)) return;
            }
            const body = { full: true, tl, st, tags, values };
            if (dt) body.dt = dt;
            if (r.r) body.r = r.r;
            await api('/api/records/' + b64ToHex(r.id), {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
            });
            closeRecordDetail();
            renderRecords();
        } catch (e) {
            alert('Error: ' + e.message);
        }
    };

    document.addEventListener('keydown', recordDetailEsc);
}

function recordDetailEsc(e) {
    if (e.key === 'Escape') closeRecordDetail();
}

function closeRecordDetail() {
    const el = document.getElementById('record-detail-overlay');
    if (el) el.remove();
    document.removeEventListener('keydown', recordDetailEsc);
}

async function deleteRecord(r) {
    if (!confirm(`Delete "${r.tl}"?`)) return;
    try {
        await api('/api/records/' + b64ToHex(r.id), { method: 'DELETE' });
        closeRecordDetail();
        renderRecords();
    } catch (e) { alert('Error: ' + e.message); }
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
                <thead><tr><th>Usecase</th><th>Description</th><th>Example</th><th>Default Status</th><th>Primary Scope</th><th>Scopes</th><th>Values</th></tr></thead>
                <tbody>
                    ${recipes.map(r => `
                        <tr class="clickable" onclick="location.hash='#recipes/edit/${encodeURIComponent(r.u)}'">
                            <td><strong>${esc(r.u)}</strong></td>
                            <td>${esc(r.d)}</td>
                            <td style="color:var(--ink-3);font-size:var(--fs-0)">${esc(r.ex || '')}</td>
                            <td>${statusLabel(r.default_st)}</td>
                            <td style="color:var(--ink-3)">${r.ps_name ? esc(r.ps_name) : '—'}</td>
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

// --- Recipe requirement check ---

let _recipeCache = {};

async function getRecipe(usecase) {
    if (!usecase) return null;
    if (_recipeCache[usecase]) return _recipeCache[usecase];
    try {
        const r = await api('/api/recipes/' + encodeURIComponent(usecase));
        _recipeCache[usecase] = r;
        return r;
    } catch { return null; }
}

function checkRequiredValues(recipe, targetSt, recordValues) {
    if (!recipe || !recipe.values) return [];
    const haveKeys = new Set((recordValues || []).map(v => v.k));
    return recipe.values
        .filter(v => (v.required_at || []).includes(targetSt) && !haveKeys.has(v.master_key))
        .map(v => v.master_key);
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
                <label>Example Text</label>
                <input id="rf-ex" value="${esc(recipe.ex || '')}" placeholder="e.g. bought coffee 90 baht with prime card">
                <small style="color:var(--ink-4)">Sample input text to help classify incoming messages</small>
            </div>

            <div class="form-group">
                <label>Default Status</label>
                <select id="rf-dst">
                    ${STATUS_LABELS.map((l, i) => `<option value="${i}" ${(recipe.default_st ?? 1) === i ? 'selected' : ''}>${l}</option>`).join('')}
                </select>
            </div>

            <div class="form-group">
                <label>Values (master_value bindings)</label>
                <table id="rf-values">
                    <thead><tr><th>Key</th>${STATUS_LABELS.map((l, i) => `<th style="text-align:center">${statusIcon(i)}</th>`).join('')}<th></th></tr></thead>
                    <tbody></tbody>
                </table>
                <button type="button" class="add-row" onclick="addValueRow()">+ Add Value</button>
            </div>

            <div class="form-group">
                <label>Scopes</label>
                <small style="color:var(--ink-4)">Mark one as primary to show its tag in record listing instead of recipe name</small>
                <table id="rf-scopes">
                    <thead><tr><th>Scope</th><th style="text-align:center;color:var(--neg)" title="Required">✱</th><th style="text-align:center" title="Primary">🔑</th><th></th></tr></thead>
                    <tbody></tbody>
                </table>
                <button type="button" class="add-row" onclick="addScopeRow()">+ Add Scope</button>
            </div>

            <div class="form-actions">
                <button type="submit" class="btn btn-primary">${isEdit ? 'Save Changes' : 'Create Recipe'}</button>
                ${isEdit ? `<button type="button" class="btn btn-danger" onclick="deleteRecipe('${esc(recipe.u)}')">Delete</button>` : ''}
            </div>
        </form>
    `;

    // Populate existing values/scopes
    (recipe.values || []).forEach(v => addValueRow(v.master_key, v.required_at));
    (recipe.scopes || []).forEach(s => addScopeRow(s.scope_id, s.required, s.scope_id === recipe.ps));

    // Only one primary scope allowed; clicking unchecks others
    document.getElementById('rf-scopes').addEventListener('change', (e) => {
        if (e.target.classList.contains('rs-primary') && e.target.checked) {
            document.querySelectorAll('#rf-scopes .rs-primary').forEach(cb => {
                if (cb !== e.target) cb.checked = false;
            });
        }
    });

    document.getElementById('recipe-form').onsubmit = async (e) => {
        e.preventDefault();
        await saveRecipe(isEdit);
    };
}

function addValueRow(key, requiredAt) {
    const ra = Array.isArray(requiredAt) ? requiredAt : [];
    const tbody = document.querySelector('#rf-values tbody');
    const row = document.createElement('tr');
    row.innerHTML = `
        <td>
            <select class="rv-key">
                <option value="">-- select --</option>
                ${(_masterValues || []).map(v => `<option value="${esc(v.k)}" ${v.k === key ? 'selected' : ''}>${esc(v.k)} — ${esc(v.d)}</option>`).join('')}
            </select>
        </td>
        ${STATUS_LABELS.map((l, i) => `<td style="text-align:center"><input type="checkbox" class="rv-req-st" data-st="${i}" ${ra.includes(i) ? 'checked' : ''}></td>`).join('')}
        <td><button type="button" class="btn-remove" onclick="this.closest('tr').remove()">×</button></td>
    `;
    tbody.appendChild(row);
}

function addScopeRow(scopeId, required, primary) {
    const tbody = document.querySelector('#rf-scopes tbody');
    const row = document.createElement('tr');
    row.innerHTML = `
        <td>
            <select class="rs-scope">
                <option value="">-- select --</option>
                ${(_scopeOptions || []).map(s => `<option value="${s.id}" ${s.id === scopeId ? 'selected' : ''}>${esc(s.name)}</option>`).join('')}
            </select>
        </td>
        <td style="text-align:center"><input type="checkbox" class="rs-req" ${required !== false ? 'checked' : ''}></td>
        <td style="text-align:center"><input type="checkbox" class="rs-primary" ${primary ? 'checked' : ''}></td>
        <td><button type="button" class="btn-remove" onclick="this.closest('tr').remove()">×</button></td>
    `;
    tbody.appendChild(row);
}

async function saveRecipe(isEdit) {
    const u = document.getElementById('rf-u').value.trim();
    const d = document.getElementById('rf-d').value.trim();
    const ex = document.getElementById('rf-ex').value.trim();
    const default_st = parseInt(document.getElementById('rf-dst').value);
    if (!u || !d) return alert('Usecase and description required.');

    const values = [...document.querySelectorAll('#rf-values tbody tr')].map(row => ({
        master_key: row.querySelector('.rv-key').value,
        required_at: [...row.querySelectorAll('.rv-req-st')].filter(cb => cb.checked).map(cb => parseInt(cb.dataset.st)),
    })).filter(v => v.master_key);

    let ps = null;
    const scopes = [...document.querySelectorAll('#rf-scopes tbody tr')].map(row => {
        const scope_id = parseInt(row.querySelector('.rs-scope').value);
        if (row.querySelector('.rs-primary').checked && scope_id) ps = scope_id;
        return { scope_id, required: row.querySelector('.rs-req').checked };
    }).filter(s => s.scope_id);

    const body = JSON.stringify({ u, d, ex, default_st, ps, values, scopes });

    try {
        if (isEdit) {
            await api('/api/recipes/' + encodeURIComponent(u), { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body });
        } else {
            await api('/api/recipes', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
        }
        delete _recipeCache[u];
        location.hash = '#recipes';
    } catch (e) {
        alert('Error: ' + e.message);
    }
}

async function deleteRecipe(u) {
    if (!confirm('Delete recipe "' + u + '"? Records referencing it will lose their recipe link.')) return;
    try {
        await api('/api/recipes/' + encodeURIComponent(u), { method: 'DELETE' });
        delete _recipeCache[u];
        location.hash = '#recipes';
    } catch (e) {
        alert('Error: ' + e.message);
    }
}

// --- Master Data ---

async function renderMaster(tab) {
    tab = tab || 'scopes';
    app.innerHTML = `
        <h2 style="margin-bottom:var(--s-4)">Master Data</h2>
        <p style="color:var(--ink-4);font-size:var(--fs-0);margin-bottom:var(--s-5)">Reference tables used by recipes and records. <strong>Scopes</strong> for hierarchy and tag grouping, <strong>Tags</strong> for filtering (scoped tags are exclusive per record), <strong>Values</strong> for aggregation.</p>
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
            <div class="toolbar" style="margin-top:var(--s-5)">
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
            <div class="toolbar" style="margin-top:var(--s-5)">
                <span>${_tagsCache.length} tag(s)</span>
                <button class="btn btn-primary btn-sm" onclick="showTagForm()">+ Add</button>
            </div>
            <div id="tag-form-slot"></div>
            <table>
                <thead><tr><th>Scope</th><th>Tag Key</th><th>Description</th><th></th></tr></thead>
                <tbody>
                    ${_tagsCache.slice().sort((a, b) => (a.scope_name || '').localeCompare(b.scope_name || '') || a.t.localeCompare(b.t)).map(t => `
                        <tr>
                            <td>${t.scope_name ? esc(t.scope_name) : '<span style="color:var(--ink-4)">*</span>'}</td>
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
            <div class="toolbar" style="margin-top:var(--s-5)">
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
            <input id="spotlight-input" type="text" placeholder="Log something... /expense Lunch 200 THB" autocomplete="off">
            <div id="spotlight-hint" class="spotlight-hint">\u21B5 to send \u00b7 esc to close</div>
            <div id="spotlight-recipes" class="spotlight-hint" style="display:none"></div>
        </div>
    `;
    document.body.appendChild(overlay);

    const input = document.getElementById('spotlight-input');
    const hint = document.getElementById('spotlight-hint');
    const recipesHint = document.getElementById('spotlight-recipes');
    input.focus();

    // Cache recipes for slash hint
    let _cachedRecipes = null;
    async function getRecipes() {
        if (!_cachedRecipes) _cachedRecipes = await api('/api/recipes').catch(() => []);
        return _cachedRecipes;
    }

    let slashMatches = [];
    let slashIdx = -1; // focused index in slashMatches

    overlay.onclick = (e) => { if (e.target === overlay) closeSpotlight(); };

    function renderRecipeHints() {
        if (slashMatches.length === 0) {
            recipesHint.innerHTML = '<span style="color:var(--ink-4)">no matching recipes</span>';
            return;
        }
        recipesHint.innerHTML = slashMatches.map((r, i) =>
            `<span class="badge badge-st-${r.default_st}" style="margin:var(--s-1);cursor:pointer;${i === slashIdx ? 'outline:var(--focus);outline-offset:1px' : ''}" data-ri="${i}">${r.u}</span>`
        ).join(' ');
        recipesHint.querySelectorAll('[data-ri]').forEach(el => {
            el.onclick = () => confirmRecipeChoice(slashMatches[parseInt(el.dataset.ri)].u);
        });
    }

    function confirmRecipeChoice(u) {
        input.value = '/' + u + ' ';
        input.focus();
        slashMatches = [];
        slashIdx = -1;
        recipesHint.style.display = 'none';
    }

    input.oninput = async () => {
        const val = input.value;
        if (val.startsWith('/') && !val.includes(' ')) {
            const recipes = await getRecipes();
            const typed = val.slice(1).toLowerCase();
            slashMatches = recipes.filter(r => r.u.toLowerCase().startsWith(typed));
            slashIdx = -1;
            recipesHint.style.display = 'block';
            renderRecipeHints();
        } else {
            slashMatches = [];
            slashIdx = -1;
            recipesHint.style.display = val.startsWith('/') ? 'none' : 'none';
        }
    };

    input.onkeydown = async (e) => {
        if (e.key === 'Escape') { closeSpotlight(); return; }

        // Tab cycles recipe choices when in slash mode
        if (e.key === 'Tab' && slashMatches.length > 0) {
            e.preventDefault();
            if (slashMatches.length === 1) {
                confirmRecipeChoice(slashMatches[0].u);
                return;
            }
            slashIdx = (slashIdx + 1) % slashMatches.length;
            renderRecipeHints();
            return;
        }

        // Enter in slash mode: confirm focused choice or single match
        if (e.key === 'Enter' && slashMatches.length > 0) {
            e.preventDefault();
            if (slashMatches.length === 1) {
                confirmRecipeChoice(slashMatches[0].u);
            } else if (slashIdx >= 0) {
                confirmRecipeChoice(slashMatches[slashIdx].u);
            }
            // If multiple and none focused, do nothing (need Tab first)
            return;
        }

        if (e.key === 'Enter') {
            const raw = input.value.trim();
            if (!raw) return;

            // Block bare /recipe with no text
            const slashMatch = raw.match(/^\/(\S+)\s+([\s\S]+)/);
            if (raw.startsWith('/') && !slashMatch) return;

            let payload = { text: raw, source: 'web' };
            if (slashMatch) {
                payload = { text: slashMatch[2], source: 'web', recipe_u: slashMatch[1] };
            }

            input.disabled = true;
            hint.textContent = slashMatch ? `Sending with /${slashMatch[1]}...` : 'Sending...';
            recipesHint.style.display = 'none';
            try {
                const resp = await fetch(API + '/api/ingest/text', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(payload),
                });
                const data = await resp.json();
                if (resp.ok) {
                    closeSpotlight();
                    location.hash = '#draft/' + data.queue_id;
                } else {
                    hint.textContent = 'Error: ' + (data.error || resp.statusText);
                    hint.style.color = 'var(--neg)';
                    input.disabled = false;
                }
            } catch (err) {
                hint.textContent = 'Error: ' + err.message;
                hint.style.color = 'var(--neg)';
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
        <h2 style="margin-bottom:var(--s-5)">Draft #${queueId}</h2>
        <div id="draft-content"><p style="color:var(--ink-4)">Loading...</p></div>
    `;

    async function poll() {
        try {
            const resp = await fetch(API + '/api/ingest/text/' + queueId);
            if (!resp.ok) {
                document.getElementById('draft-content').innerHTML = `<p style="color:var(--neg)">Queue item not found.</p>`;
                clearInterval(draftPollTimer);
                return;
            }
            const item = await resp.json();
            renderDraftContent(item, queueId);
        } catch (e) {
            document.getElementById('draft-content').innerHTML = `<p style="color:var(--neg)">Error: ${e.message}</p>`;
        }
    }

    poll();
    draftPollTimer = setInterval(poll, 1500);
}

async function dismissDraft(id) {
    await fetch(API + '/api/ingest/text/' + id, { method: 'DELETE' });
    location.hash = '#ingestion';
}

function renderDraftContent(item, queueId) {
    const el = document.getElementById('draft-content');
    if (!el) return;

    if (item.status === 'pending' || item.status === 'processing') {
        el.innerHTML = `
            <div class="draft-status">
                <p>Processing... <span class="badge">${item.status}</span></p>
                <p style="color:var(--ink-4);font-size:var(--fs-0);margin-top:var(--s-4)">Input: ${escHtml(item.payload)}</p>
            </div>
        `;
        return;
    }

    if (item.status === 'failed') {
        clearInterval(draftPollTimer);
        el.innerHTML = `
            <div class="draft-status">
                <p style="color:var(--neg)">Failed: ${escHtml(item.error || 'Unknown error')}</p>
                <p style="color:var(--ink-4);font-size:var(--fs-0);margin-top:var(--s-4)">Input: ${escHtml(item.payload)}</p>
                <div style="margin-top:var(--s-5)"><button class="btn btn-danger" onclick="dismissDraft(${item.id})">Dismiss</button> <button class="btn btn-primary" onclick="openSpotlight()">Try again</button></div>
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
                <p style="color:var(--pos);font-weight:600;margin-bottom:var(--s-5)">Ready to save</p>
                <p style="color:var(--ink-4);font-size:var(--fs-0);margin-bottom:var(--s-5)">Input: ${escHtml(item.payload)}</p>
                <div class="form-group">
                    <label>Title</label>
                    <input id="draft-done-tl" value="${escHtml(result.tl || '')}">
                </div>
                <div class="form-group">
                    <label>Detail</label>
                    <textarea id="draft-done-dt" rows="2">${escHtml(result.dt || '')}</textarea>
                </div>
                <div class="form-group">
                    <label>Status</label>
                    <select id="draft-done-st">
                        ${STATUS_LABELS.map((l, i) => `<option value="${i}" ${i === (result.st ?? 1) ? 'selected' : ''}>${l}</option>`).join('')}
                    </select>
                </div>
                <div class="form-group">
                    <label>Tags</label>
                    <div id="draft-done-tags"></div>
                </div>
                <div class="form-group">
                    <label>Values</label>
                    <div id="draft-done-values"></div>
                    <button type="button" class="add-row" id="draft-done-add-value">+ Add value</button>
                </div>
                <div class="form-actions">
                    <button class="btn btn-danger" onclick="dismissDraft(${item.id})">Dismiss</button>
                    <button id="draft-done-save" class="btn btn-primary">Save</button>
                </div>
            </div>
        `;

        let tagInput;
        const valueRows = [];
        fetchMasterData().then(master => {
            const tagSugs = master.tags.map(t => ({
                value: t.t, label: t.t,
                hint: t.scope_name ? t.scope_name + (t.d ? ' \u00b7 ' + t.d : '') : (t.d || '')
            }));
            tagInput = createTagInput(
                document.getElementById('draft-done-tags'), tagSugs, result.tags || [],
                { allowNew: true, placeholder: 'Add tags...' }
            );

            const valSugs = master.values.map(v => ({ value: v.k, label: v.k, hint: v.d }));
            const valContainer = document.getElementById('draft-done-values');

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

            (result.values || []).forEach(v => addValueRow(v.k, v.v));
            document.getElementById('draft-done-add-value').onclick = () => addValueRow('', '');
        });

        document.getElementById('draft-done-save').onclick = async () => {
            const tl = document.getElementById('draft-done-tl').value.trim();
            const dt = document.getElementById('draft-done-dt').value.trim();
            const st = parseInt(document.getElementById('draft-done-st').value);
            const tags = tagInput ? tagInput.getSelected() : [];
            const values = [];
            valueRows.forEach(vr => {
                if (vr.removed) return;
                const k = vr.keyCtrl.getSelected()[0] || '';
                const v = parseFloat(vr.numInput.value);
                if (k && !isNaN(v)) values.push({ k, v });
            });

            if (!tl) { alert('Title required'); return; }

            try {
                const body = { full: true, tl, st, tags, values, r: item.recipe_u };
                if (dt) body.dt = dt;
                if (result.record_id) {
                    // Record already created by worker — update it
                    await api('/api/records/' + result.record_id, {
                        method: 'PATCH',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify(body),
                    });
                } else {
                    // Fallback: create new (shouldn't happen for done status)
                    await api('/api/records', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify(body),
                    });
                }
                el.innerHTML = `
                    <div class="draft-status">
                        <p style="color:var(--pos);font-weight:600">Record saved!</p>
                        <div style="margin-top:var(--s-5)">
                            <a href="#records" class="btn btn-secondary">View Records</a>
                            <button class="btn btn-primary" style="margin-left:var(--s-4)" onclick="openSpotlight()">Log Another</button>
                        </div>
                    </div>
                `;
            } catch (e) {
                alert('Error: ' + e.message);
            }
        };
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
                <div id="draft-choices" style="margin-top:var(--s-4)">
                    ${matches.map((r, i) => `<button class="btn btn-secondary" style="margin:var(--s-2)" data-recipe="${escHtml(r)}">${escHtml(r)}</button>`).join('')}
                </div>
                <p style="color:var(--ink-4);font-size:var(--fs-0);margin-top:var(--s-4)">Input: ${escHtml(item.payload)}</p>
                <div style="margin-top:var(--s-4)"><button class="btn btn-danger" onclick="dismissDraft(${item.id})">Dismiss</button></div>
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
                <p style="color:var(--ink-4);font-size:var(--fs-0);margin-top:var(--s-3)">Input: ${escHtml(item.payload)}</p>
                <div style="margin-top:var(--s-5)">
                    <div class="form-group">
                        <label>Title</label>
                        <input id="draft-tl" value="${escHtml(partial.tl || '')}">
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
                    ${missing.length ? `<p style="color:var(--warn);font-size:var(--fs-0);margin-bottom:var(--s-4)">Missing: ${missing.join(', ')}</p>` : ''}
                    <div class="form-group">
                        <label>Additional info</label>
                        <textarea id="draft-extra" rows="2" placeholder="Provide missing details..."></textarea>
                    </div>
                    <div class="form-actions">
                        <button class="btn btn-danger" onclick="dismissDraft(${item.id})">Dismiss</button>
                        <button id="draft-resubmit" class="btn btn-secondary">Re-process with extra info</button>
                        <button id="draft-save" class="btn btn-primary">Save as-is</button>
                    </div>
                </div>
            </div>
        `;

        // Wire up autocomplete components after master data loads
        let tagInput;
        const valueRows = [];
        fetchMasterData().then(master => {
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
            const tags = tagInput ? tagInput.getSelected() : [];
            const values = [];
            valueRows.forEach(vr => {
                if (vr.removed) return;
                const k = vr.keyCtrl.getSelected()[0] || '';
                const v = parseFloat(vr.numInput.value);
                if (k && !isNaN(v)) values.push({ k, v });
            });

            if (!tl) { alert('Title required'); return; }

            try {
                await api('/api/records', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ tl, st: partial.st || 3, tags, values, r: item.recipe_u }),
                });
                clearInterval(draftPollTimer);
                el.innerHTML = `
                    <div class="draft-status">
                        <p style="color:var(--pos);font-weight:600">Record saved!</p>
                        <div style="margin-top:var(--s-5)">
                            <a href="#records" class="btn btn-secondary">View Records</a>
                            <button class="btn btn-primary" style="margin-left:var(--s-4)" onclick="openSpotlight()">Log Another</button>
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
        <h2 style="margin-bottom:var(--s-5)">Bot Logs</h2>
        <p style="color:var(--ink-4);font-size:var(--fs-0);margin-bottom:var(--s-5)">Live Discord message stream.</p>
        <div style="margin-bottom:var(--s-4);display:flex;align-items:center;gap:var(--s-5)">
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
    return d.innerHTML.replaceAll("'", '&#39;');
}
