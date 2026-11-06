# Build context: repository root (see docker-compose.yml)
FROM node:22-alpine AS build
WORKDIR /app
RUN npm install -g pnpm@10.28.0
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc tsconfig.base.json ./
COPY shared/package.json shared/
COPY server/package.json server/
COPY web/package.json web/
RUN pnpm install --frozen-lockfile --filter @myciti/server...
COPY shared shared
COPY server server
RUN BUNDLE_ALL=1 pnpm --filter @myciti/server run build

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production DATA_DIR=/data PORT=3000
COPY --from=build /app/server/dist ./dist
RUN mkdir -p /data && chown node:node /data
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD wget -qO- http://127.0.0.1:3000/api/health >/dev/null || exit 1
CMD ["node", "--enable-source-maps", "dist/index.js"]
