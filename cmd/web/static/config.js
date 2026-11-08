// Caddy reverse proxies /api to the server — same origin, no cross-port needed
(function() {
    var h = location.hostname;
    var p = location.protocol + '//';
    window.PASCAL_API_URL = '';
    window.PASCAL_BOT_URL = p + h + ':7602';
})();
