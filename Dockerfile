# Multi-stage build: compile with dev dependencies, ship only production ones.
# The same image runs as API or worker: set APP_ROLE=api | worker.
# Set APP_ENV=development | staging | preprod | production to load the
# configuration from AWS Secrets Manager (see README: Environments & secrets).

FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig*.json nest-cli.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM node:22-alpine
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build --chown=node:node /app/package.json ./
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
USER node
EXPOSE 3000
# Liveness only (no dependencies); point the readiness probe at /api/health/ready.
HEALTHCHECK --interval=30s --timeout=3s --start-period=20s \
  CMD wget -qO- http://127.0.0.1:${PORT:-3000}/api/health >/dev/null || exit 1
# exec form: node is PID 1 and receives SIGTERM for graceful shutdown.
CMD ["node", "dist/main"]
