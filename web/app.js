const API = window.location.origin + '/api';

// WebSocket for real-time updates
function connectWS() {
    const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(proto + '//' + window.location.host + '/ws');

    ws.onmessage = (e) => {
        const evt = JSON.parse(e.data);
        console.log('ws event:', evt);
        // Refresh on any change
        loadRecords();
    };

    ws.onclose = () => {
        setTimeout(connectWS, 2000);
    };
}

async function loadRecords() {
    const resp = await fetch(API + '/records');
    const records = await resp.json();
    const el = document.getElementById('records');
    if (!records || records.length === 0) {
        el.innerHTML = '<p>No records yet.</p>';
        return;
    }
    el.innerHTML = records.map(r => `
        <div class="record">
            <strong>${r.tl}</strong>
            <span class="scope">${r.sc}</span>
            <span class="category">${r.cg}</span>
        </div>
    `).join('');
}

connectWS();
loadRecords();
