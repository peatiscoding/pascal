const app = document.getElementById('app');
let logSource = null;

function autoResize(el) {
    el.style.height = 'auto';
    el.style.height = el.scrollHeight + 'px';
}

function bareTag(t) { const i = t.lastIndexOf(':'); return i >= 0 ? t.slice(i + 1) : t; }

const STATUS_LABELS = ['Paused', 'Todo', 'Doing', 'Done'];
function statusLabel(st) { return `<span class="badge badge-st-${st}">${STATUS_LABELS[st] || st}</span>`; }
function b64ToHex(b64) { return [...atob(b64)].map(c => c.charCodeAt(0).toString(16).padStart(2, '0')).join(''); }

// --- Router ---

function route() {
    if (logSource) { logSource.close(); logSource = null; }
    const hash = location.hash || '#dashboard';
    // Desktop header nav
    document.querySelectorAll('cds-header-nav-item.nav-link').forEach(a => {
        const isActive = hash.startsWith(a.getAttribute('href'));
        a.toggleAttribute('active', isActive);
    });
    // Mobile bottom nav
    document.querySelectorAll('.mobile-nav-link[href]').forEach(a => {
        a.classList.toggle('active', hash.startsWith(a.getAttribute('href')));
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

// --- API (see client.js) ---

// --- Dashboard ---

async function renderDashboard() {
    app.innerHTML = `
        <h2 style="margin-bottom:var(--s-5)">Dashboard</h2>
        <div class="health-grid">
            <div class="health-card" id="h-server"><h3>API Server</h3><span class="health-status loading">checking...</span></div>
            <div class="health-card" id="h-bot"><h3>Discord Bot</h3><span class="health-status loading">checking...</span></div>
            <div class="health-card" id="h-mcp"><h3>MCP Server</h3><span class="health-status loading">checking...</span></div>
        </div>
        <div class="stats-row" id="dash-stats"></div>
    `;

    const [server, bot, mcp] = await Promise.all([
        Client.checkServer(),
        Client.checkBot(),
        Client.checkMcp(),
    ]);

    renderHealthCard('h-server', server);
    renderHealthCard('h-bot', bot);
    renderHealthCard('h-mcp', mcp);

    // Stats from server health
    if (server.status !== 'down') {
        const drafts = await Client.listDrafts();
        const draftCount = drafts.length;
        document.getElementById('dash-stats').innerHTML = `
            <div class="stat-box"><div class="val">${server.record_count ?? '—'}</div><div class="label">Records</div></div>
            <div class="stat-box"><div class="val">${draftCount}</div><div class="label">Drafts</div></div>
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

function relativeDate(isoStr) {
    if (!isoStr) return '';
    const d = new Date(isoStr.replace(' ', 'T') + 'Z');
    const now = Date.now();
    const sec = Math.floor((now - d.getTime()) / 1000);
    if (sec < 60) return 'now';
    if (sec < 3600) return Math.floor(sec / 60) + 'm';
    if (sec < 86400) return Math.floor(sec / 3600) + 'h';
    if (sec < 604800) return Math.floor(sec / 86400) + 'd';
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
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
    const date = relativeDate(r.ct);

    // If primary scope set, show tag from that scope; otherwise show recipe name
    let firstCol = r.r ? '/' + esc(r.r) : '';
    if (primaryScopeName) {
        const psTag = tagInfo.find(ti => ti.sp && ti.sp.split('|').includes(primaryScopeName));
        firstCol = psTag ? esc(psTag.t) : '<span style="color:var(--ink-4)">—</span>';
    }

    return `<div class="rec-line" data-record='${esc(JSON.stringify(r))}'>
        <span class="rec-st" data-st="${r.st}">${statusIcon(r.st)}</span>
        <span class="rec-recipe">${firstCol}</span>
        <span class="rec-title">${esc(r.tl)}</span>
        ${tagInfo.length ? `<span class="rec-tags" title="${tagTooltip}"><span class="rec-tag-dots">${tagInfo.map(ti => `<span class="rec-dot${ti.sp ? ' rec-dot-scoped' : ''}"></span>`).join('')}</span></span>` : ''}
        ${values.map(v => `<span class="rec-val"><span class="num">${v.dp ? v.v.toFixed(v.dp) : v.v}</span> <span class="unit">${esc(v.k)}</span></span>`).join('')}
        ${date ? `<span class="rec-date num">${date}</span>` : ''}
        <span class="rec-del" title="Delete">×</span>
    </div>`;
}

function buildDailyChart(records, valueKey) {
    const now = new Date();
    const days = [];
    for (let i = 6; i >= 0; i--) {
        const d = new Date(now);
        d.setDate(d.getDate() - i);
        days.push(d.toISOString().slice(0, 10));
    }

    const byDay = {};
    days.forEach(d => { byDay[d] = 0; });
    records.forEach(r => {
        const day = (r.ct || '').slice(0, 10);
        if (byDay[day] === undefined) return;
        (r.values || []).forEach(v => {
            if (v.k === valueKey) byDay[day] += v.v;
        });
    });

    const vals = days.map(d => byDay[d]);
    const max = Math.max(...vals, 1);
    const w = 280, h = 80, barW = (w - 8) / 7;

    const bars = days.map((d, i) => {
        const x = 4 + i * barW;
        const barH = (byDay[d] / max) * (h - 16);
        if (byDay[d] === 0) return '';
        return `<rect x="${x + 2}" y="${h - 12 - barH}" width="${barW - 4}" height="${barH}" fill="var(--mod-stat)"/>`;
    }).join('');

    const dayLabels = days.map((d, i) => {
        const x = 4 + i * barW + barW / 2;
        const dow = new Date(d + 'T00:00:00').getDay();
        const label = ['S','M','T','W','T','F','S'][dow];
        const color = dow === 0 ? 'var(--neg)' : 'var(--ink-4)';
        return `<text x="${x}" y="${h - 1}" text-anchor="middle" fill="${color}" font-size="8" font-family="var(--font-mono)">${label}</text>`;
    }).join('');

    return `<svg class="rec-chart" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none">
        ${bars}${dayLabels}
    </svg>`;
}

function buildTodoChart(records) {
    // Last 7 days: bars showing added (positive) vs completed (negative)
    const now = new Date();
    const days = [];
    for (let i = 6; i >= 0; i--) {
        const d = new Date(now);
        d.setDate(d.getDate() - i);
        days.push(d.toISOString().slice(0, 10));
    }

    const added = {}, done = {};
    days.forEach(d => { added[d] = 0; done[d] = 0; });

    records.forEach(r => {
        const day = (r.ct || '').slice(0, 10);
        if (added[day] !== undefined) added[day]++;
        if (r.st === 3 && done[day] !== undefined) done[day]++;
    });

    const addedVals = days.map(d => added[d]);
    const doneVals = days.map(d => done[d]);
    const maxUp = Math.max(...addedVals, 1);
    const maxDown = Math.max(...doneVals, 1);

    const w = 280, h = 80, barW = (w - 8) / 7, mid = h * (maxUp / (maxUp + maxDown));

    const bars = days.map((d, i) => {
        const x = 4 + i * barW;
        const upH = (added[d] / maxUp) * (mid - 2);
        const dnH = (done[d] / maxDown) * (h - mid - 2);
        let svg = '';
        if (added[d] > 0) svg += `<rect x="${x + 2}" y="${mid - upH}" width="${barW - 4}" height="${upH}" fill="var(--mod-act)"/>`;
        if (done[d] > 0) svg += `<rect x="${x + 2}" y="${mid}" width="${barW - 4}" height="${dnH}" fill="var(--pos)"/>`;
        return svg;
    }).join('');

    const dayLabels = days.map((d, i) => {
        const x = 4 + i * barW + barW / 2;
        const dow = new Date(d + 'T00:00:00').getDay();
        const label = ['S','M','T','W','T','F','S'][dow];
        const color = dow === 0 ? 'var(--neg)' : 'var(--ink-4)';
        return `<text x="${x}" y="${h - 1}" text-anchor="middle" fill="${color}" font-size="8" font-family="var(--font-mono)">${label}</text>`;
    }).join('');

    // Midline
    const midline = `<line x1="4" y1="${mid}" x2="${w - 4}" y2="${mid}" stroke="var(--rule)" stroke-width="1"/>`;

    const totalAdded = addedVals.reduce((a, b) => a + b, 0);
    const totalDone = doneVals.reduce((a, b) => a + b, 0);

    return `<div class="carousel-slide">
        <div class="carousel-header">
            <span style="color:var(--mod-act)">+${totalAdded} added</span>
            <span style="color:var(--pos)">−${totalDone} done</span>
        </div>
        <svg class="rec-chart" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none">
            ${midline}${bars}${dayLabels}
        </svg>
    </div>`;
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
            const dp = records.flatMap(r => r.values || []).find(v => v.k === k)?.dp || 0;
            slides.push(`<div class="carousel-slide">
                <div class="carousel-header">
                    <span class="rec-recipe">/${esc(recipe || '—')}</span>
                    <span class="num">${dp ? total.toFixed(dp) : total}</span> <span class="unit">${esc(k)}</span>
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

let _activeRecordTab = null;

async function renderRecords() {
    app.innerHTML = '<div id="records-tabs" class="rec-tabs"></div><div id="records-list">Loading...</div>';
    try {
        const [records, recipes, drafts] = await Promise.all([
            Client.listRecords(),
            Client.listRecipes().catch(() => []),
            Client.listDrafts(),
        ]);

        // Build primary scope lookup
        const primaryScope = {};
        (recipes || []).forEach(r => { if (r.ps_name) primaryScope[r.u] = r.ps_name; });

        // Group by recipe
        const groups = {};
        const noRecipe = [];
        (records || []).forEach(r => {
            if (r.r) {
                (groups[r.r] = groups[r.r] || []).push(r);
            } else {
                noRecipe.push(r);
            }
        });

        // Build tabs: recipe tabs + other + draft
        const tabKeys = [...Object.keys(groups)];
        if (noRecipe.length) tabKeys.push('_none');
        tabKeys.push('_draft');

        // Default to first recipe tab
        if (!_activeRecordTab || !tabKeys.includes(_activeRecordTab)) _activeRecordTab = tabKeys[0] || '_draft';

        const tabsEl = document.getElementById('records-tabs');
        tabsEl.innerHTML = tabKeys.map(k => {
            const label = k === '_none' ? 'Other' : k === '_draft' ? 'Draft' : '/' + esc(k);
            const count = k === '_none' ? noRecipe.length : k === '_draft' ? (drafts || []).length : (groups[k] || []).length;
            const cls = k === '_draft' && count > 0 ? ' rec-tab-draft' : '';
            return `<button class="rec-tab${cls}${_activeRecordTab === k ? ' active' : ''}" data-tab="${esc(k)}">${label} <span class="num">${count}</span></button>`;
        }).join('');

        // Build recipe default status lookup
        const recipeDefSt = {};
        (recipes || []).forEach(r => { recipeDefSt[r.u] = r.default_st; });

        const ctx = { groups, noRecipe, primaryScope, drafts: drafts || [], recipeDefSt };

        tabsEl.querySelectorAll('.rec-tab').forEach(btn => {
            btn.onclick = () => {
                _activeRecordTab = btn.dataset.tab;
                renderRecordsList(ctx);
                tabsEl.querySelectorAll('.rec-tab').forEach(b => b.classList.toggle('active', b.dataset.tab === _activeRecordTab));
            };
        });

        renderRecordsList(ctx);
    } catch (e) {
        document.getElementById('records-list').innerHTML = `<p class="empty">Error: ${esc(e.message)}</p>`;
    }
}

function renderRecordsList(ctx) {
    const el = document.getElementById('records-list');
    const tab = _activeRecordTab;

    let html = '';
    if (tab === '_draft') {
        if (ctx.drafts.length === 0) {
            html = '<p class="empty" style="padding:var(--s-6)">No drafts.</p>';
        } else {
            html = ctx.drafts.map(d => {
                const status = d.status === 'needs_input' ? 'needs input' : d.status;
                return `<div class="rec-line draft-line" onclick="location.hash='#draft/${d.id}'">
                    <span class="badge badge-st-2" style="flex-shrink:0">${esc(status)}</span>
                    <span class="rec-title">${esc(d.payload)}</span>
                    <span class="rec-date num">${relativeDate(d.created_at)}</span>
                </div>`;
            }).join('');
        }
    } else if (tab === '_none') {
        html += ctx.noRecipe.map(r => recordLine(r)).join('');
    } else {
        const recs = ctx.groups[tab] || [];
        const ps = ctx.primaryScope[tab];
        // Todo-type recipes (default_st=1) get added/done bar chart
        if (ctx.recipeDefSt[tab] === 1) {
            html += `<div class="carousel">${buildTodoChart(recs)}</div>`;
        } else {
            html += buildCarousel({ [tab]: recs });
        }
        html += recs.map(r => recordLine(r, ps)).join('');
    }

    if (!html) html = '<p class="empty">No records.</p>';
    el.innerHTML = html;

    el.querySelectorAll('.rec-line:not(.draft-line)').forEach(div => {
        const r = JSON.parse(div.dataset.record);
        div.querySelector('.rec-del').onclick = (e) => { e.stopPropagation(); deleteRecord(r); };
        div.querySelector('.rec-st').onclick = (e) => { e.stopPropagation(); toggleStatus(r); };
        div.onclick = () => showRecordDetail(r);
    });
}

async function toggleStatus(r) {
    const next = r.st === 1 ? 3 : r.st === 3 ? 1 : (r.st + 1) % 4;
    if (r.r) {
        const recipe = await getRecipe(r.r);
        const missing = checkRequiredValues(recipe, next, r.values);
        if (missing.length > 0 && !confirm(`Missing values required for "${STATUS_LABELS[next]}":\n\n${missing.join(', ')}\n\nContinue anyway?`)) return;
    }
    try {
        await Client.updateRecord(b64ToHex(r.id), { st: next });
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
                <span style="color:var(--ink-3);font-size:var(--fs-0)" title="${esc(r.ct)}">${relativeDate(r.ct)}</span>
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
                <div class="st-bar" id="rd-st" data-value="${r.st}">
                    ${STATUS_LABELS.map((l, i) => `<button type="button" class="st-bar-btn st-bar-btn-${i}${i === r.st ? ' active' : ''}" data-st="${i}">${STATUS_ICONS[i]} ${l}</button>`).join('')}
                </div>
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

    // Auto-resize textareas
    overlay.querySelectorAll('textarea').forEach(ta => {
        ta.addEventListener('input', () => autoResize(ta));
        autoResize(ta);
    });

    // Wire up status button bar
    document.getElementById('rd-st').addEventListener('click', (e) => {
        const btn = e.target.closest('.st-bar-btn');
        if (!btn) return;
        const bar = document.getElementById('rd-st');
        bar.querySelectorAll('.st-bar-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        bar.dataset.value = btn.dataset.st;
    });

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

        (r.values || []).forEach(v => addValueRow(valContainer, valSugs, valueRows, v.k, v.v));
        document.getElementById('rd-add-value').onclick = () => addValueRow(valContainer, valSugs, valueRows, '', '');
    });

    document.getElementById('record-detail-delete').onclick = () => deleteRecord(r);

    document.getElementById('record-detail-save').onclick = async () => {
        const tl = document.getElementById('rd-tl').value.trim();
        const dt = document.getElementById('rd-dt').value.trim();
        const st = parseInt(document.getElementById('rd-st').dataset.value);
        const tags = tagInput ? tagInput.getSelected() : [];
        const values = collectValues(valueRows);

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
            await Client.updateRecord(b64ToHex(r.id), body);
            invalidateMasterCache();
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
        await Client.deleteRecord(b64ToHex(r.id));
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
        const recipes = await Client.listRecipes();
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
        const r = await Client.getRecipe(usecase);
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
        _masterValues = await Client.listValues().catch(() => []);
    }
    if (!_scopeOptions) {
        _scopeOptions = await Client.listScopes().catch(() => []);
    }
}

async function renderRecipeForm(usecase) {
    app.innerHTML = '<p>Loading...</p>';
    await loadOptions();

    let recipe = { u: '', d: '', values: [], scopes: [] };
    const isEdit = usecase != null;

    if (isEdit) {
        try {
            recipe = await Client.getRecipe(usecase);
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

    const body = { u, d, ex, default_st, ps, values, scopes };

    try {
        if (isEdit) {
            await Client.updateRecipe(u, body);
        } else {
            await Client.createRecipe(body);
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
        await Client.deleteRecipe(u);
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
        const values = await Client.listValues();
        el.innerHTML = `
            <p class="tab-desc">Values define numeric types attached to records (e.g. THB, calories, tokens). Used for <strong>aggregation</strong> — summing, averaging, and charting over time.</p>
            <div class="toolbar" style="margin-top:var(--s-5)">
                <span>${(values || []).length} value type(s)</span>
                <button class="btn btn-primary btn-sm" onclick="showMasterValueForm()">+ Add</button>
            </div>
            <div id="mv-form-slot"></div>
            <table>
                <thead><tr><th>Key</th><th>Description</th><th>Decimals</th><th></th></tr></thead>
                <tbody>
                    ${(values || []).map(v => `
                        <tr>
                            <td><strong>${esc(v.k)}</strong></td>
                            <td>${esc(v.d)}</td>
                            <td class="num">${v.dp}</td>
                            <td style="text-align:right">
                                <button class="btn btn-secondary btn-sm" onclick="showMasterValueForm('${esc(v.k)}','${esc(v.d)}',${v.dp})">Edit</button>
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

function showMasterValueForm(key, desc, dp) {
    const isEdit = key != null;
    document.getElementById('mv-form-slot').innerHTML = `
        <form class="inline-form" onsubmit="saveMasterValue(event, ${isEdit})">
            <input id="mv-k" value="${esc(key || '')}" placeholder="Key (e.g. THB)" ${isEdit ? 'disabled' : ''} required>
            <input id="mv-d" value="${esc(desc || '')}" placeholder="Description" required style="flex:2">
            <input id="mv-dp" type="number" min="0" max="6" value="${dp ?? 0}" placeholder="Decimals" style="width:5em" title="Decimal places (0=integer, 1=hours, 2=currency)">
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
    const dp = parseInt(document.getElementById('mv-dp').value) || 0;
    if (!k || !d) return;
    try {
        if (isEdit) {
            await Client.updateValue(k, { k, d, dp });
        } else {
            await Client.createValue({ k, d, dp });
        }
        _masterValues = null; // invalidate cache
        renderMasterValues();
    } catch (e) { alert('Error: ' + e.message); }
}

async function deleteMasterValue(k) {
    if (!confirm('Delete value type "' + k + '"?')) return;
    try {
        await Client.deleteValue(k);
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
            Client.listTags(),
            Client.listScopes(),
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
            await Client.updateTag(t, { t, s, d });
        } else {
            await Client.createTag({ t, s, d });
        }
        _tagsCache = [];
        renderMasterTags();
    } catch (e) { alert('Error: ' + e.message); }
}

async function deleteTagItem(t) {
    if (!confirm('Delete tag "' + t + '"?')) return;
    try {
        await Client.deleteTag(t);
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
        _scopesData = await Client.listScopes() || [];
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
            await Client.updateScope(id, { name, parent_id: _scopesData.find(s => s.id === id)?.parent_id ?? null });
        } else {
            await Client.createScope({ name, parent_id });
        }
        renderMasterScopes();
    } catch (e) { alert('Error: ' + e.message); }
}

async function deleteScopeItem(id, name) {
    if (!confirm('Delete scope "' + name + '" and all children?')) return;
    try {
        await Client.deleteScope(id);
        renderMasterScopes();
    } catch (e) { alert('Error: ' + e.message); }
}

// --- Ingest Spotlight ---

async function openRecipePicker() {
    // Toggle off if already open
    const existing = document.getElementById('fab-menu');
    if (existing) { closeFabMenu(); return; }
    if (document.getElementById('spotlight-overlay')) return;

    const fab = document.querySelector('.mobile-fab');
    const recipes = await Client.listRecipes().catch(() => []);

    const menu = document.createElement('div');
    menu.id = 'fab-menu';
    menu.className = 'fab-menu';
    menu.innerHTML = recipes.map(r =>
        `<button class="fab-menu-item badge badge-st-${r.default_st}" data-u="${r.u}">/${r.u}</button>`
    ).join('') + `<button class="fab-menu-item fab-menu-free" data-u="">ƒ free</button>`;
    document.body.appendChild(menu);

    // Scrim to catch outside taps
    const scrim = document.createElement('div');
    scrim.id = 'fab-scrim';
    scrim.className = 'fab-scrim';
    document.body.appendChild(scrim);
    scrim.onclick = closeFabMenu;

    if (fab) fab.classList.add('fab-active');

    // Animate in
    requestAnimationFrame(() => menu.classList.add('fab-menu-open'));

    menu.querySelectorAll('.fab-menu-item').forEach(btn => {
        btn.onclick = () => {
            const u = btn.dataset.u;
            closeFabMenu();
            if (u) {
                openSpotlight('/' + u + ' ');
            } else {
                openSpotlight();
            }
        };
    });
}

function closeFabMenu() {
    const menu = document.getElementById('fab-menu');
    const scrim = document.getElementById('fab-scrim');
    const fab = document.querySelector('.mobile-fab');
    if (menu) menu.remove();
    if (scrim) scrim.remove();
    if (fab) fab.classList.remove('fab-active');
}

function openSpotlight(initialText) {
    if (document.getElementById('spotlight-overlay')) return;
    const overlay = document.createElement('div');
    overlay.id = 'spotlight-overlay';
    overlay.className = 'spotlight-overlay';
    overlay.innerHTML = `
        <div class="spotlight-box">
            <div id="spotlight-input" class="spotlight-editable" contenteditable="true" role="textbox" enterkeyhint="send" autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false" data-placeholder="Log something... /expense Lunch 200 THB"></div>
            <div id="spotlight-shortcuts" class="spotlight-shortcuts">
                <span class="spotlight-key" data-key="Escape">esc</span>
                <span style="flex:1"></span>
                <span class="spotlight-key" data-insert="/">/</span>
                <span class="spotlight-key" data-insert="#">#</span>
                <span class="spotlight-key" data-insert="@">@</span>
                <span class="spotlight-key" data-key="Enter">\u21B5</span>
            </div>
            <div id="spotlight-hint" class="spotlight-hint">/recipe \u00b7 #tag \u00b7 @value(n) \u00b7 \u21B5 send \u00b7 esc close</div>
            <div id="spotlight-recipes" class="spotlight-hint" style="display:none"></div>
            <div id="spotlight-tags" class="spotlight-hint" style="display:none"></div>
            <div id="spotlight-values" class="spotlight-hint" style="display:none"></div>
        </div>
    `;
    document.body.appendChild(overlay);

    // Hide mobile nav + FAB while spotlight is open
    const mobileNav = document.getElementById('mobile-nav');
    const mobileFab = document.querySelector('.mobile-fab');
    if (mobileNav) mobileNav.style.display = 'none';
    if (mobileFab) mobileFab.style.display = 'none';

    const input = document.getElementById('spotlight-input');
    const hint = document.getElementById('spotlight-hint');
    const recipesHint = document.getElementById('spotlight-recipes');
    const tagHintEl = document.getElementById('spotlight-tags');
    const shortcuts = document.getElementById('spotlight-shortcuts');

    // Dock spotlight box above Safari virtual keyboard using visualViewport
    const spotlightBox = overlay.querySelector('.spotlight-box');
    if (window.visualViewport) {
        const vv = window.visualViewport;
        function dockToKeyboard() {
            spotlightBox.style.height = vv.height + 'px';
            overlay.style.height = vv.height + 'px';
            overlay.style.top = vv.offsetTop + 'px';
        }
        vv.addEventListener('resize', dockToKeyboard);
        vv.addEventListener('scroll', dockToKeyboard);
        overlay._vvCleanup = () => {
            vv.removeEventListener('resize', dockToKeyboard);
            vv.removeEventListener('scroll', dockToKeyboard);
        };
        dockToKeyboard();
    }

    input.focus();

    // Contenteditable helpers
    function getText() { return input.textContent || ''; }
    function getCursorOffset() {
        const sel = window.getSelection();
        if (!sel.rangeCount) return 0;
        const range = sel.getRangeAt(0).cloneRange();
        range.selectNodeContents(input);
        range.setEnd(sel.focusNode, sel.focusOffset);
        return range.toString().length;
    }
    function setCursorOffset(offset) {
        const sel = window.getSelection();
        const range = document.createRange();
        let pos = 0;
        const walker = document.createTreeWalker(input, NodeFilter.SHOW_TEXT);
        while (walker.nextNode()) {
            const node = walker.currentNode;
            if (pos + node.length >= offset) {
                range.setStart(node, offset - pos);
                range.collapse(true);
                sel.removeAllRanges();
                sel.addRange(range);
                return;
            }
            pos += node.length;
        }
        // Fallback: end
        range.selectNodeContents(input);
        range.collapse(false);
        sel.removeAllRanges();
        sel.addRange(range);
    }

    function highlightInput() {
        const text = getText();
        const offset = getCursorOffset();
        const html = esc(text)
            .replace(/(^\/\S+)/g, '<span class="spotlight-recipe">$1</span>')
            .replace(/#([a-zA-Z0-9_:-]+)/g, '<span class="spotlight-tag">#$1</span>')
            .replace(/@([a-zA-Z0-9_-]+(?:\([^)]*\))?)/g, '<span class="spotlight-value">@$1</span>');
        if (input.innerHTML !== html) {
            input.innerHTML = html;
            setCursorOffset(offset);
        }
    }

    // Shortcut key buttons
    document.querySelectorAll('.spotlight-key').forEach(btn => {
        btn.onmousedown = (e) => e.preventDefault(); // keep focus on input
        btn.onclick = () => {
            const insert = btn.dataset.insert;
            if (insert) {
                const pos = getCursorOffset();
                const text = getText();
                input.textContent = text.slice(0, pos) + insert + text.slice(pos);
                highlightInput();
                setCursorOffset(pos + 1);
                input.dispatchEvent(new Event('input'));
            } else if (btn.dataset.key) {
                input.dispatchEvent(new KeyboardEvent('keydown', { key: btn.dataset.key, bubbles: true }));
            }
        };
    });

    // Paste as plain text only
    input.addEventListener('paste', (e) => {
        e.preventDefault();
        const text = (e.clipboardData || window.clipboardData).getData('text/plain');
        document.execCommand('insertText', false, text);
    });

    // Cache recipes for slash hint
    let _cachedRecipes = null;
    async function getRecipes() {
        if (!_cachedRecipes) _cachedRecipes = await Client.listRecipes().catch(() => []);
        return _cachedRecipes;
    }

    // Cache tags
    let _cachedTags = null;
    async function getTags() {
        if (!_cachedTags) _cachedTags = await Client.listTags().catch(() => []);
        return _cachedTags;
    }

    let slashMatches = [];
    let slashIdx = -1;

    // Tag state
    let hasRecipe = false;
    let recipeScopes = [];
    let tagMatches = [];
    let tagIdx = -1;
    let tagAnchor = -1;

    // Value autocomplete state
    let valueMatches = [];
    let valueIdx = -1;
    let valueAnchor = -1;
    const valueHintEl = document.getElementById('spotlight-values');

    // Cache master values
    let _cachedValues = null;
    async function getValues() {
        if (!_cachedValues) _cachedValues = await Client.listValues().catch(() => []);
        return _cachedValues;
    }

    // Parse #scope:tag and #tag tokens from text
    function parseInlineTags(text) {
        const matches = text.match(/#[a-zA-Z0-9_:-]+/g) || [];
        return matches.map(m => m.slice(1)); // remove # only, keep scope:tag format
    }

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

    const slashBtn = document.querySelector('.spotlight-key[data-insert="/"]');

    async function confirmRecipeChoice(u) {
        const text = '/' + u + ' ';
        input.textContent = text;
        highlightInput();
        input.focus();
        setCursorOffset(text.length);
        slashMatches = [];
        slashIdx = -1;
        recipesHint.style.display = 'none';
        hasRecipe = true;
        slashBtn.style.display = 'none';
        // Cache recipe scopes for tag prioritization
        const recipes = await getRecipes();
        const recipe = recipes.find(r => r.u === u);
        recipeScopes = (recipe && recipe.scopes) ? recipe.scopes.map(s => s.scope_name) : [];
    }

    // Pre-fill with initial text (e.g. from recipe picker)
    if (initialText) {
        const recipeMatch = initialText.match(/^\/(\S+)\s/);
        if (recipeMatch) {
            confirmRecipeChoice(recipeMatch[1]);
        } else {
            input.textContent = initialText;
            highlightInput();
            setCursorOffset(initialText.length);
        }
    }

    function renderTagHints() {
        if (tagMatches.length === 0) {
            tagHintEl.style.display = 'none';
            return;
        }
        tagHintEl.style.display = 'block';
        tagHintEl.innerHTML = tagMatches.slice(0, 8).map((t, i) => {
            const isNew = t._isNew;
            const bg = isNew ? 'background:var(--warn-lt);color:var(--warn)'
                             : 'background:var(--mod-stat-lt);color:var(--mod-stat-dk)';
            const outline = i === tagIdx ? ';outline:var(--focus);outline-offset:1px' : '';
            const scope = (!isNew && t.scope_name) ? ` <span style="color:var(--ink-4);font-size:var(--fs-0)">${esc(t.scope_name)}</span>` : '';
            const label = isNew ? `${t.scope_name ? esc(t.scope_name) + ':' : ''}${esc(t.t)} (new)` : esc(t.t);
            return `<span class="badge" style="${bg}${outline};margin:var(--s-1);cursor:pointer" data-ti="${i}">${label}${scope}</span>`;
        }).join(' ');
        tagHintEl.querySelectorAll('[data-ti]').forEach(el => {
            el.onclick = () => confirmTagChoice(tagMatches[parseInt(el.dataset.ti)]);
        });
    }

    function formatTagToken(tag) {
        return tag.scope_name ? '#' + tag.scope_name + ':' + tag.t : '#:' + tag.t;
    }

    function confirmTagChoice(tag) {
        const val = getText();
        const before = val.slice(0, tagAnchor);
        const after = val.slice(getCursorOffset());
        const fullTag = formatTagToken(tag);
        input.textContent = before + fullTag + ' ' + after;
        tagMatches = [];
        tagIdx = -1;
        tagHintEl.style.display = 'none';
        highlightInput();
        input.focus();
        setCursorOffset(before.length + fullTag.length + 1);
    }

    function renderValueHints() {
        if (valueMatches.length === 0) {
            valueHintEl.style.display = 'none';
            return;
        }
        valueHintEl.style.display = 'block';
        valueHintEl.innerHTML = valueMatches.slice(0, 8).map((v, i) => {
            const outline = i === valueIdx ? ';outline:var(--focus);outline-offset:1px' : '';
            return `<span class="badge" style="background:var(--mod-log-lt);color:var(--mod-log-dk)${outline};margin:var(--s-1);cursor:pointer" data-vi="${i}">${esc(v.k)} <span style="color:var(--ink-4);font-size:var(--fs-0)">${esc(v.d)}</span></span>`;
        }).join(' ');
        valueHintEl.querySelectorAll('[data-vi]').forEach(el => {
            el.onclick = () => confirmValueChoice(valueMatches[parseInt(el.dataset.vi)]);
        });
    }

    function confirmValueChoice(mv) {
        const val = getText();
        const before = val.slice(0, valueAnchor);
        const after = val.slice(getCursorOffset());
        const token = '@' + mv.k + '(';
        input.textContent = before + token + after;
        valueMatches = [];
        valueIdx = -1;
        valueHintEl.style.display = 'none';
        highlightInput();
        input.focus();
        setCursorOffset(before.length + token.length);
    }

    input.oninput = async () => {
        highlightInput();
        const val = getText();
        // Slash recipe detection
        if (val.startsWith('/') && !val.includes(' ')) {
            const recipes = await getRecipes();
            const typed = val.slice(1).toLowerCase();
            slashMatches = recipes.filter(r => r.u.toLowerCase().startsWith(typed));
            slashIdx = -1;
            recipesHint.style.display = 'block';
            renderRecipeHints();
            tagHintEl.style.display = 'none';
            return;
        } else {
            slashMatches = [];
            slashIdx = -1;
            recipesHint.style.display = 'none';
        }

        // Tag detection (active when /recipe prefix present)
        const slashRecipeMatch = val.match(/^\/(\S+)\s/);
        if (slashRecipeMatch) {
            // Lazy-load recipe scopes if not yet loaded
            if (!hasRecipe) {
                hasRecipe = true;
                slashBtn.style.display = 'none';
                const recipes = await getRecipes();
                const recipe = recipes.find(r => r.u === slashRecipeMatch[1]);
                recipeScopes = (recipe && recipe.scopes) ? recipe.scopes.map(s => s.scope_name) : [];
            }
            const pos = getCursorOffset();
            const textBeforeCursor = val.slice(0, pos);
            const hashMatch = textBeforeCursor.match(/#([a-zA-Z0-9_:-]*)$/);
            if (hashMatch) {
                tagAnchor = pos - hashMatch[0].length;
                const raw = hashMatch[1] || '';
                const allTags = await getTags();

                let scopeFilter = null;
                let termFilter = raw;
                if (raw.includes(':')) {
                    const parts = raw.split(':');
                    scopeFilter = parts[0].toLowerCase();
                    termFilter = parts.slice(1).join(':').toLowerCase();
                } else {
                    termFilter = raw.toLowerCase();
                }

                // Exclude the current #fragment being typed from used tags
                // Exclude the current #fragment being typed from used tags
                const textWithoutCurrent = val.slice(0, tagAnchor) + val.slice(getCursorOffset());
                const usedNames = parseInlineTags(textWithoutCurrent).map(u => { const c = u.indexOf(':'); return c >= 0 ? u.slice(c+1) : u; });
                tagMatches = allTags.filter(t => {
                    if (usedNames.includes(t.t)) return false;
                    if (scopeFilter && (!t.scope_name || !t.scope_name.toLowerCase().startsWith(scopeFilter))) return false;
                    return t.t.toLowerCase().includes(termFilter);
                });

                // Sort: recipe scope tags first
                if (recipeScopes.length > 0) {
                    tagMatches.sort((a, b) => {
                        const aIn = recipeScopes.includes(a.scope_name) ? 0 : 1;
                        const bIn = recipeScopes.includes(b.scope_name) ? 0 : 1;
                        return aIn - bIn || a.t.localeCompare(b.t);
                    });
                }

                // Add "new tag" option if no exact match
                if (termFilter && !tagMatches.find(t => t.t.toLowerCase() === termFilter)) {
                    tagMatches.push({ t: termFilter, scope_name: scopeFilter || null, d: '', _isNew: true });
                }

                tagIdx = -1;
                renderTagHints();
                return;
            }
        }
        tagMatches = [];
        tagIdx = -1;
        tagHintEl.style.display = 'none';

        // Value detection: @key or @key( without closing )
        const vPos = getCursorOffset();
        const vBefore = val.slice(0, vPos);
        const atMatch = vBefore.match(/@([a-zA-Z0-9_-]*)$/);
        if (atMatch && !vBefore.match(/@[a-zA-Z0-9_-]*\([^)]*$/)) {
            // Typing key name (no open paren yet)
            valueAnchor = vPos - atMatch[0].length;
            const typed = (atMatch[1] || '').toLowerCase();
            const allValues = await getValues();
            // Exclude already-used value keys
            const usedKeys = (val.match(/@([a-zA-Z0-9_-]+)\(/g) || []).map(m => m.slice(1, -1));
            valueMatches = allValues.filter(v =>
                !usedKeys.includes(v.k) && v.k.toLowerCase().includes(typed)
            );
            valueIdx = -1;
            renderValueHints();
            return;
        }
        valueMatches = [];
        valueIdx = -1;
        valueHintEl.style.display = 'none';
    };

    input.onkeydown = async (e) => {
        if (e.key === 'Escape') {
            if (valueMatches.length > 0) {
                valueMatches = []; valueIdx = -1; valueHintEl.style.display = 'none';
                return;
            }
            if (tagMatches.length > 0) {
                tagMatches = []; tagIdx = -1; tagHintEl.style.display = 'none';
                return;
            }
            closeSpotlight();
            return;
        }

        // Value mode: Tab cycles, Enter confirms
        if (valueMatches.length > 0) {
            if (e.key === 'Tab') {
                e.preventDefault();
                if (valueMatches.length === 1) { confirmValueChoice(valueMatches[0]); return; }
                valueIdx = (valueIdx + 1) % valueMatches.length;
                renderValueHints();
                return;
            }
            if (e.key === 'Enter') {
                e.preventDefault();
                if (valueMatches.length === 1) { confirmValueChoice(valueMatches[0]); return; }
                if (valueIdx >= 0) { confirmValueChoice(valueMatches[valueIdx]); return; }
                return;
            }
        }

        // Tag mode: Tab cycles, Enter/Space confirms
        if (tagMatches.length > 0) {
            if (e.key === 'Tab') {
                e.preventDefault();
                if (tagMatches.length === 1) { confirmTagChoice(tagMatches[0]); return; }
                tagIdx = (tagIdx + 1) % tagMatches.length;
                renderTagHints();
                return;
            }
            if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                if (tagMatches.length === 1) { confirmTagChoice(tagMatches[0]); return; }
                if (tagIdx >= 0) { confirmTagChoice(tagMatches[tagIdx]); return; }
                // Space with no selection: confirm exact match or first match
                if (e.key === ' ') {
                    const typed = getText().slice(tagAnchor + 1, getCursorOffset()).toLowerCase();
                    const exact = tagMatches.find(t => t.t.toLowerCase() === typed);
                    confirmTagChoice(exact || tagMatches[0]);
                }
                return;
            }
        }

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
            return;
        }

        if (e.key === 'Enter') {
            e.preventDefault();
            const raw = getText().trim();
            if (!raw) return;

            // Block bare /recipe with no text
            const slashMatch = raw.match(/^\/(\S+)\s+([\s\S]+)/);
            if (raw.startsWith('/') && !slashMatch) return;

            // Parse inline #scope:tag and #tag tokens
            const hintTags = parseInlineTags(raw);
            // Parse inline @key(value) tokens
            const hintValues = [];
            const valueRe = /@([a-zA-Z0-9_-]+)\(([^)]+)\)/g;
            let vm;
            while ((vm = valueRe.exec(raw)) !== null) {
                const v = parseFloat(vm[2]);
                if (!isNaN(v)) hintValues.push({ k: vm[1], v });
            }
            // Keep annotated text intact for LLM context; only strip /recipe prefix
            let text = raw.trim();
            let payload = { text, source: 'web' };
            if (slashMatch) {
                const textAfterRecipe = text.replace(/^\/\S+\s*/, '');
                payload = { text: textAfterRecipe, source: 'web', recipe_u: slashMatch[1] };
            }
            if (hintTags.length > 0) {
                payload.hint_tags = hintTags;
            }
            if (hintValues.length > 0) {
                payload.hint_values = hintValues;
            }

            input.setAttribute('aria-disabled', 'true');
            input.contentEditable = 'false';
            hint.textContent = slashMatch ? `Sending with /${slashMatch[1]}...` : 'Sending...';
            recipesHint.style.display = 'none';
            tagHintEl.style.display = 'none';
            try {
                const { ok, data } = await Client.ingestText(payload);
                if (ok) {
                    closeSpotlight();
                    location.hash = '#draft/' + data.queue_id;
                } else {
                    hint.textContent = 'Error: ' + (data.error || 'unknown');
                    hint.style.color = 'var(--neg)';
                    input.removeAttribute('aria-disabled');
                    input.contentEditable = 'true';
                }
            } catch (err) {
                hint.textContent = 'Error: ' + err.message;
                hint.style.color = 'var(--neg)';
                input.removeAttribute('aria-disabled');
                input.contentEditable = 'true';
            }
        }
    };
}

function closeSpotlight() {
    const el = document.getElementById('spotlight-overlay');
    if (el) {
        if (el._vvCleanup) el._vvCleanup();
        el.remove();
    }
    // Restore mobile nav + FAB
    const mobileNav = document.getElementById('mobile-nav');
    const fab = document.querySelector('.mobile-fab');
    if (mobileNav) mobileNav.style.display = '';
    if (fab) fab.style.display = '';
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
            const item = await Client.getDraft(queueId);
            if (!item) {
                document.getElementById('draft-content').innerHTML = `<p style="color:var(--neg)">Queue item not found.</p>`;
                clearInterval(draftPollTimer);
                return;
            }
            renderDraftContent(item, queueId);
        } catch (e) {
            document.getElementById('draft-content').innerHTML = `<p style="color:var(--neg)">Error: ${e.message}</p>`;
        }
    }

    poll();
    draftPollTimer = setInterval(poll, 1500);
}

async function dismissDraft(id) {
    await Client.dismissDraft(id);
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

        el.querySelectorAll('textarea').forEach(ta => {
            ta.addEventListener('input', () => autoResize(ta));
            autoResize(ta);
        });

        let tagInput;
        const valueRows = [];
        fetchMasterData().then(master => {
            const tagSugs = master.tags.map(t => ({
                value: t.t, label: t.t,
                hint: t.scope_name ? t.scope_name + (t.d ? ' \u00b7 ' + t.d : '') : (t.d || '')
            }));
            tagInput = createTagInput(
                document.getElementById('draft-done-tags'), tagSugs, (result.tags || []).map(bareTag),
                { allowNew: true, placeholder: 'Add tags...' }
            );

            const valSugs = master.values.map(v => ({ value: v.k, label: v.k, hint: v.d }));
            const valContainer = document.getElementById('draft-done-values');

            (result.values || []).forEach(v => addValueRow(valContainer, valSugs, valueRows, v.k, v.v));
            document.getElementById('draft-done-add-value').onclick = () => addValueRow(valContainer, valSugs, valueRows, '', '');
        });

        document.getElementById('draft-done-save').onclick = async () => {
            const tl = document.getElementById('draft-done-tl').value.trim();
            const dt = document.getElementById('draft-done-dt').value.trim();
            const st = parseInt(document.getElementById('draft-done-st').value);
            const tags = tagInput ? tagInput.getSelected() : [];
            const values = collectValues(valueRows);

            if (!tl) { alert('Title required'); return; }

            try {
                const body = { full: true, tl, st, tags, values, r: item.recipe_u };
                if (dt) body.dt = dt;
                if (result.record_id) {
                    await Client.updateRecord(result.record_id, body);
                } else {
                    await Client.createRecord(body);
                }
                await Client.dismissDraft(queueId);
                invalidateMasterCache();
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
                const { ok, data } = await Client.ingestText({ text: item.payload, source: 'web', recipe_u: recipe });
                if (ok) location.hash = '#draft/' + data.queue_id;
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
        el.querySelectorAll('textarea').forEach(ta => {
            ta.addEventListener('input', () => autoResize(ta));
            autoResize(ta);
        });

        let tagInput;
        const valueRows = [];
        fetchMasterData().then(master => {
            const tagSugs = master.tags.map(t => ({
                value: t.t, label: t.t,
                hint: t.scope_name ? t.scope_name + (t.d ? ' \u00b7 ' + t.d : '') : (t.d || '')
            }));
            tagInput = createTagInput(
                document.getElementById('draft-tags-input'), tagSugs, (partial.tags || []).map(bareTag),
                { allowNew: true, placeholder: 'Add tags...' }
            );

            const valSugs = master.values.map(v => ({ value: v.k, label: v.k, hint: v.d }));
            const valContainer = document.getElementById('draft-values');

            (partial.values || []).forEach(v => addValueRow(valContainer, valSugs, valueRows, v.k, v.v));
            document.getElementById('draft-add-value').onclick = () => addValueRow(valContainer, valSugs, valueRows, '', '');
        });

        document.getElementById('draft-resubmit').onclick = async () => {
            const extra = document.getElementById('draft-extra').value.trim();
            if (!extra) return;
            const { ok, data } = await Client.ingestText({ text: item.payload + '\n' + extra, source: 'web', recipe_u: item.recipe_u });
            if (ok) location.hash = '#draft/' + data.queue_id;
        };

        document.getElementById('draft-save').onclick = async () => {
            const tl = document.getElementById('draft-tl').value.trim();
            const tags = tagInput ? tagInput.getSelected() : [];
            const values = collectValues(valueRows);

            if (!tl) { alert('Title required'); return; }

            try {
                await Client.createRecord({ tl, st: partial.st || 3, tags, values, r: item.recipe_u });
                await Client.dismissDraft(queueId);
                invalidateMasterCache();
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

// --- Value Input Component ---
// Two inputs in a fieldset: key (text + autocomplete) + number.
// valSugs: [{value, label, hint?}], returns {get(), removed} entry.

function addValueRow(container, valSugs, valueRows, k, v) {
    const row = document.createElement('div');
    row.className = 'value-row';

    const keyInput = document.createElement('input');
    keyInput.type = 'text';
    keyInput.className = 'value-key';
    keyInput.placeholder = 'key';
    if (k) keyInput.value = k;

    const numInput = document.createElement('input');
    numInput.type = 'number';
    numInput.className = 'value-num';
    numInput.inputMode = 'decimal';
    numInput.placeholder = '0';
    numInput.step = 'any';
    if (v != null && v !== '') numInput.value = v;

    const removeBtn = document.createElement('button');
    removeBtn.type = 'button';
    removeBtn.className = 'btn-remove';
    removeBtn.textContent = '\u00d7';

    row.appendChild(keyInput);
    row.appendChild(numInput);
    row.appendChild(removeBtn);
    container.appendChild(row);

    // Autocomplete for key
    let dropdown = null;
    let activeIdx = -1;

    function hideDropdown() {
        if (dropdown) { dropdown.remove(); dropdown = null; }
        activeIdx = -1;
    }

    function showDropdown(filter) {
        hideDropdown();
        const matches = valSugs.filter(s =>
            s.value.toLowerCase().startsWith(filter.toLowerCase())
        ).slice(0, 8);
        if (!matches.length) return;

        dropdown = document.createElement('div');
        dropdown.className = 'value-dropdown';
        matches.forEach((s, i) => {
            const opt = document.createElement('div');
            opt.className = 'value-dropdown-item';
            opt.textContent = s.value;
            if (s.hint) {
                const hint = document.createElement('span');
                hint.className = 'value-dropdown-hint';
                hint.textContent = s.hint;
                opt.appendChild(hint);
            }
            opt.onmousedown = (e) => {
                e.preventDefault();
                keyInput.value = s.value;
                hideDropdown();
                numInput.focus();
            };
            dropdown.appendChild(opt);
        });
        row.appendChild(dropdown);
    }

    keyInput.addEventListener('input', () => {
        const text = keyInput.value.trim();
        if (text.length > 0) showDropdown(text);
        else hideDropdown();
    });

    keyInput.addEventListener('keydown', (e) => {
        if (!dropdown) return;
        const items = dropdown.querySelectorAll('.value-dropdown-item');
        if (e.key === 'ArrowDown') { e.preventDefault(); activeIdx = Math.min(activeIdx + 1, items.length - 1); }
        else if (e.key === 'ArrowUp') { e.preventDefault(); activeIdx = Math.max(activeIdx - 1, 0); }
        else if ((e.key === 'Tab' || e.key === 'Enter') && activeIdx >= 0) {
            e.preventDefault();
            items[activeIdx]?.onmousedown(e);
            return;
        } else return;
        items.forEach((it, i) => it.classList.toggle('active', i === activeIdx));
    });

    keyInput.addEventListener('blur', () => setTimeout(hideDropdown, 150));

    const entry = {
        get() {
            return { k: keyInput.value.trim(), v: parseFloat(numInput.value) };
        },
        removed: false
    };
    valueRows.push(entry);
    removeBtn.onclick = () => { row.remove(); entry.removed = true; };
    return entry;
}

function collectValues(valueRows) {
    const values = [];
    valueRows.forEach(vr => {
        if (vr.removed) return;
        const { k, v } = vr.get();
        if (k && !isNaN(v)) values.push({ k, v });
    });
    return values;
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

// Fetch master data for autocomplete (cached, invalidated on record save)
let _masterCache = null;
function invalidateMasterCache() { _masterCache = null; }
async function fetchMasterData() {
    if (_masterCache) return _masterCache;
    const [tags, scopes, values] = await Promise.all([
        Client.listTags().catch(() => []),
        Client.listScopes().catch(() => []),
        Client.listValues().catch(() => []),
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
    logSource = Client.botLogSource();

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
    const ws = Client.connectWS(() => {
        const hash = location.hash || '#dashboard';
        if (hash === '#records') renderRecords();
        if (hash === '#dashboard') renderDashboard();
    });
    ws.onclose = () => setTimeout(connectWS, 2000);
}
connectWS();

// --- Status Dots ---

async function updateStatusDots() {
    const checks = [
        { id: 'dot-server', fn: Client.checkServer },
        { id: 'dot-bot', fn: Client.checkBot },
        { id: 'dot-mcp', fn: Client.checkMcp },
    ];
    await Promise.all(checks.map(async ({ id, fn }) => {
        const dot = document.getElementById(id);
        if (!dot) return;
        const result = await fn();
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
