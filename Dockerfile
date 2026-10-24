FROM node:24.18.1-bookworm-slim AS workspace

ARG PNPM_VERSION=11.21.0
WORKDIR /workspace
RUN corepack enable && corepack prepare pnpm@${PNPM_VERSION} --activate
COPY --chown=node:node . .
RUN chown node:node /workspace
USER node

FROM workspace AS dependencies
RUN pnpm install --frozen-lockfile

FROM dependencies AS web-build
RUN pnpm --filter '@gotchu/web...' --recursive --sort --if-present run build

FROM dependencies AS coordinator-build
RUN pnpm --filter '@gotchu/coordinator...' --filter '@gotchu/assessment...' --filter '@gotchu/demo-target...' --recursive --sort --if-present run build

FROM workspace AS web-production-dependencies
RUN pnpm install --prod --frozen-lockfile --filter '@gotchu/web...'

FROM workspace AS coordinator-production-dependencies
RUN pnpm install --prod --frozen-lockfile --filter '@gotchu/coordinator...' --filter '@gotchu/assessment...' --filter '@gotchu/demo-target...'

FROM node:24.18.1-bookworm-slim AS web
ENV NODE_ENV=production
WORKDIR /workspace
COPY --from=web-production-dependencies --chown=node:node /workspace/node_modules /workspace/node_modules
COPY --from=web-production-dependencies --chown=node:node /workspace/apps/web/node_modules /workspace/apps/web/node_modules
COPY --from=web-build --chown=node:node /workspace/apps/web/package.json /workspace/apps/web/package.json
COPY --from=web-build --chown=node:node /workspace/apps/web/.output /workspace/apps/web/.output
COPY --from=web-build --chown=node:node /workspace/packages/contracts/package.json /workspace/packages/contracts/package.json
COPY --from=web-build --chown=node:node /workspace/packages/contracts/dist /workspace/packages/contracts/dist
COPY --from=web-production-dependencies --chown=node:node /workspace/packages/contracts/node_modules /workspace/packages/contracts/node_modules
COPY --from=web-build --chown=node:node /workspace/packages/backend/package.json /workspace/packages/backend/package.json
COPY --from=web-build --chown=node:node /workspace/packages/backend/dist /workspace/packages/backend/dist
COPY --from=web-production-dependencies --chown=node:node /workspace/packages/backend/node_modules /workspace/packages/backend/node_modules
COPY --from=web-build --chown=node:node /workspace/packages/triage/package.json /workspace/packages/triage/package.json
COPY --from=web-build --chown=node:node /workspace/packages/triage/dist /workspace/packages/triage/dist
COPY --from=web-production-dependencies --chown=node:node /workspace/packages/triage/node_modules /workspace/packages/triage/node_modules
COPY --from=web-build --chown=node:node /workspace/packages/database/package.json /workspace/packages/database/package.json
COPY --from=web-build --chown=node:node /workspace/packages/database/dist /workspace/packages/database/dist
COPY --from=web-production-dependencies --chown=node:node /workspace/packages/database/node_modules /workspace/packages/database/node_modules
COPY --from=web-build --chown=node:node /workspace/packages/scenarios/package.json /workspace/packages/scenarios/package.json
COPY --from=web-build --chown=node:node /workspace/packages/scenarios/dist /workspace/packages/scenarios/dist
COPY --from=web-production-dependencies --chown=node:node /workspace/packages/scenarios/node_modules /workspace/packages/scenarios/node_modules
COPY --from=web-build --chown=node:node /workspace/packages/monitoring/package.json /workspace/packages/monitoring/package.json
COPY --from=web-build --chown=node:node /workspace/packages/monitoring/dist /workspace/packages/monitoring/dist
COPY --from=web-production-dependencies --chown=node:node /workspace/packages/monitoring/node_modules /workspace/packages/monitoring/node_modules
COPY --from=web-build --chown=node:node /workspace/packages/customer-assessment/package.json /workspace/packages/customer-assessment/package.json
COPY --from=web-build --chown=node:node /workspace/packages/customer-assessment/dist /workspace/packages/customer-assessment/dist
COPY --from=web-build --chown=node:node /workspace/packages/customer-assessment/profiles /workspace/packages/customer-assessment/profiles
COPY --from=web-production-dependencies --chown=node:node /workspace/packages/customer-assessment/node_modules /workspace/packages/customer-assessment/node_modules
WORKDIR /workspace/apps/web
USER node
CMD ["node", ".output/server/index.mjs"]

FROM node:24.18.1-bookworm-slim AS coordinator
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production
WORKDIR /workspace
COPY --from=coordinator-production-dependencies --chown=node:node /workspace/node_modules /workspace/node_modules
COPY --from=coordinator-production-dependencies --chown=node:node /workspace/apps/coordinator/node_modules /workspace/apps/coordinator/node_modules
COPY --from=coordinator-build --chown=node:node /workspace/apps/coordinator/package.json /workspace/apps/coordinator/package.json
COPY --from=coordinator-build --chown=node:node /workspace/apps/coordinator/dist /workspace/apps/coordinator/dist
COPY --from=coordinator-build --chown=node:node /workspace/packages/agent/package.json /workspace/packages/agent/package.json
COPY --from=coordinator-build --chown=node:node /workspace/packages/agent/dist /workspace/packages/agent/dist
COPY --from=coordinator-production-dependencies --chown=node:node /workspace/packages/agent/node_modules /workspace/packages/agent/node_modules
COPY --from=coordinator-build --chown=node:node /workspace/packages/backend/package.json /workspace/packages/backend/package.json
COPY --from=coordinator-build --chown=node:node /workspace/packages/backend/dist /workspace/packages/backend/dist
COPY --from=coordinator-production-dependencies --chown=node:node /workspace/packages/backend/node_modules /workspace/packages/backend/node_modules
COPY --from=coordinator-build --chown=node:node /workspace/packages/triage/package.json /workspace/packages/triage/package.json
COPY --from=coordinator-build --chown=node:node /workspace/packages/triage/dist /workspace/packages/triage/dist
COPY --from=coordinator-production-dependencies --chown=node:node /workspace/packages/triage/node_modules /workspace/packages/triage/node_modules
COPY --from=coordinator-build --chown=node:node /workspace/packages/contracts/package.json /workspace/packages/contracts/package.json
COPY --from=coordinator-build --chown=node:node /workspace/packages/contracts/dist /workspace/packages/contracts/dist
COPY --from=coordinator-production-dependencies --chown=node:node /workspace/packages/contracts/node_modules /workspace/packages/contracts/node_modules
COPY --from=coordinator-build --chown=node:node /workspace/packages/database/package.json /workspace/packages/database/package.json
COPY --from=coordinator-build --chown=node:node /workspace/packages/database/dist /workspace/packages/database/dist
COPY --from=coordinator-production-dependencies --chown=node:node /workspace/packages/database/node_modules /workspace/packages/database/node_modules
COPY --from=coordinator-build --chown=node:node /workspace/packages/assessment/package.json /workspace/packages/assessment/package.json
COPY --from=coordinator-build --chown=node:node /workspace/packages/assessment/dist /workspace/packages/assessment/dist
COPY --from=coordinator-build --chown=node:node /workspace/packages/assessment/advisories /workspace/packages/assessment/advisories
COPY --from=coordinator-production-dependencies --chown=node:node /workspace/packages/assessment/node_modules /workspace/packages/assessment/node_modules
COPY --from=coordinator-build --chown=node:node /workspace/apps/demo-target/package.json /workspace/apps/demo-target/package.json
COPY --from=coordinator-build --chown=node:node /workspace/apps/demo-target/dist /workspace/apps/demo-target/dist
COPY --from=coordinator-build --chown=node:node /workspace/apps/demo-target/src/fixtures /workspace/apps/demo-target/src/fixtures
COPY --from=coordinator-production-dependencies --chown=node:node /workspace/apps/demo-target/node_modules /workspace/apps/demo-target/node_modules
COPY --from=coordinator-build --chown=node:node /workspace/apps/scanner/package.json /workspace/apps/scanner/package.json
COPY --from=coordinator-build --chown=node:node /workspace/apps/scanner/dist /workspace/apps/scanner/dist
COPY --from=coordinator-production-dependencies --chown=node:node /workspace/apps/scanner/node_modules /workspace/apps/scanner/node_modules
COPY --from=coordinator-build --chown=node:node /workspace/packages/customer-assessment/package.json /workspace/packages/customer-assessment/package.json
COPY --from=coordinator-build --chown=node:node /workspace/packages/customer-assessment/dist /workspace/packages/customer-assessment/dist
COPY --from=coordinator-build --chown=node:node /workspace/packages/customer-assessment/profiles /workspace/packages/customer-assessment/profiles
COPY --from=coordinator-production-dependencies --chown=node:node /workspace/packages/customer-assessment/node_modules /workspace/packages/customer-assessment/node_modules
COPY --from=coordinator-build --chown=node:node /workspace/packages/monitoring/package.json /workspace/packages/monitoring/package.json
COPY --from=coordinator-build --chown=node:node /workspace/packages/monitoring/dist /workspace/packages/monitoring/dist
COPY --from=coordinator-production-dependencies --chown=node:node /workspace/packages/monitoring/node_modules /workspace/packages/monitoring/node_modules
COPY --from=coordinator-build --chown=node:node /workspace/packages/scenarios/package.json /workspace/packages/scenarios/package.json
COPY --from=coordinator-build --chown=node:node /workspace/packages/scenarios/dist /workspace/packages/scenarios/dist
COPY --from=coordinator-production-dependencies --chown=node:node /workspace/packages/scenarios/node_modules /workspace/packages/scenarios/node_modules
WORKDIR /workspace/apps/coordinator
USER node
CMD ["node", "dist/main.js"]
