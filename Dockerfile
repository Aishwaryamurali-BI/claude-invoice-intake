# MCP server image. Not built or run on the author's machine (no Docker there);
# see README "Self-hosting".
FROM node:24-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
# better-sqlite3 downloads a prebuilt binary here; if none matches, it needs python3/make/g++.
RUN npm ci
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM node:24-slim
WORKDIR /app
ENV NODE_ENV=production HOST=0.0.0.0 PORT=8787 DATA_DIR=/data
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
COPY fixtures ./fixtures
# Only used by keyless replay mode (synthetic test invoices).
COPY evals/cases ./evals/cases
RUN mkdir -p /data && chown node:node /data
USER node
EXPOSE 8787
CMD ["node", "dist/mcp-server.js"]
