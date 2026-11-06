# Build context: repository root (see docker-compose.yml)
FROM node:22-alpine AS build
WORKDIR /app
RUN npm install -g pnpm@10.28.0
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc tsconfig.base.json ./
COPY shared/package.json shared/
COPY server/package.json server/
COPY web/package.json web/
RUN pnpm install --frozen-lockfile --filter @myciti/web...
COPY shared shared
COPY web web
RUN pnpm --filter @myciti/web run build

# unprivileged image: nginx runs as uid 101 and listens on 8080, no capabilities needed
FROM nginxinc/nginx-unprivileged:1.27-alpine
COPY web/nginx-headers.conf /etc/nginx/includes/headers.conf
COPY web/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/web/dist /usr/share/nginx/html
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD wget -qO- http://127.0.0.1:8080/ >/dev/null || exit 1
