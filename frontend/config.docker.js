/**
 * The in-container counterpart to config.js: the API is on this page's own origin,
 * under /api, because nginx forwards /api/* to the api service (see nginx.conf).
 */
window.__API_URL__ = "/api";
