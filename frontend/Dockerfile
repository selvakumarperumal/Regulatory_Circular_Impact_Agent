# syntax=docker/dockerfile:1
# Frontend image: the static console (plain HTML/CSS/JS, nothing to build) served by
# nginx, which also forwards /api to the api service.

# The unprivileged variant listens on 8080 and runs as uid 101, never as root.
FROM nginxinc/nginx-unprivileged:1.29-alpine

COPY --chown=nginx:nginx nginx.conf /etc/nginx/conf.d/default.conf
COPY --chown=nginx:nginx index.html /usr/share/nginx/html/
COPY --chown=nginx:nginx css/ /usr/share/nginx/html/css/
COPY --chown=nginx:nginx js/ /usr/share/nginx/html/js/
# In here the API is at /api on the same origin (see config.docker.js)
COPY --chown=nginx:nginx config.docker.js /usr/share/nginx/html/config.js

EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
    CMD wget --quiet --tries=1 --spider http://127.0.0.1:8080/ || exit 1
