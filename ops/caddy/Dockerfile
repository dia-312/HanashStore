# The web server for production: Caddy with the built web app inside, so the server needs no
# Node and no checkout of the build output. Build context: the repository root.
#   docker compose -f docker-compose.prod.yml build caddy
FROM node:24-alpine AS web
WORKDIR /build
COPY package.json package-lock.json ./
COPY apps/web/package.json apps/web/
RUN npm ci
COPY apps/web apps/web
COPY shared shared
RUN npm --prefix apps/web run build

FROM caddy:2.8-alpine
COPY --from=web /build/apps/web/dist /srv
COPY ops/caddy/Caddyfile /etc/caddy/Caddyfile
