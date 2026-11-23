# Remote TestChimp MCP server (Streamable HTTP, OAuth bearer auth) — suitable for Cloud Run.
FROM node:20-slim AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.json ./
# Host umask can leave package.json mode 600; USER node needs to read it at runtime.
RUN chmod a+r package.json package-lock.json tsconfig.json && npm ci
COPY src ./src
RUN npm run build

FROM node:20-slim
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
RUN chmod a+r package.json package-lock.json \
  && npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
USER node
EXPOSE 8080
CMD ["node", "dist/bin/testchimp.js", "mcp", "--http"]
