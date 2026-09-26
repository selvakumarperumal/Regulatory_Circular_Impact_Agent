/**
 * Where the page finds the API when you serve this folder by hand
 * (e.g. `python -m http.server 5500`): left unset, app.js uses http://localhost:8000.
 *
 * The Docker image replaces this file with config.docker.js, which sets "/api": nginx
 * there forwards /api/* to the api service, so the browser only sees one origin.
 * To point this page at another backend:
 *
 *     window.__API_URL__ = "http://192.168.1.20:8000";
 */
