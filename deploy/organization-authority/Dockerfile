FROM node:22.22.1-bookworm-slim@sha256:4f77a690f2f8946ab16fe1e791a3ac0667ae1c3575c3e4d0d4589e9ed5bfaf3d AS build

WORKDIR /app
COPY package.json npm-shrinkwrap.json tsconfig*.json ./
COPY packages ./packages
COPY src/product/person-client/package.json ./src/product/person-client/package.json
COPY services/organization-authority ./services/organization-authority
COPY services/organization-control-plane ./services/organization-control-plane
COPY services/organization-record ./services/organization-record
COPY services/organization-retrieval ./services/organization-retrieval
RUN npm ci \
  && npm run build --workspace @echo-brain/organization-authority \
  && npm ci --omit=dev --workspace @echo-brain/organization-authority --include-workspace-root=false
RUN find packages services -type f \( -name '*.d.ts' -o -name '*.tsbuildinfo' \) -delete

FROM node:22.22.1-bookworm-slim@sha256:4f77a690f2f8946ab16fe1e791a3ac0667ae1c3575c3e4d0d4589e9ed5bfaf3d

ARG ECHO_SOURCE_SHA
LABEL org.opencontainers.image.revision="${ECHO_SOURCE_SHA}"
ENV NODE_ENV=production
WORKDIR /app
RUN apt-get update \
  && DEBIAN_FRONTEND=noninteractive apt-get upgrade -y \
  && rm -rf /var/lib/apt/lists/*
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/packages/federation-protocol/package.json ./packages/federation-protocol/package.json
COPY --from=build /app/packages/federation-protocol/dist ./packages/federation-protocol/dist
COPY --from=build /app/packages/organization-protocol/package.json ./packages/organization-protocol/package.json
COPY --from=build /app/packages/organization-protocol/dist ./packages/organization-protocol/dist
COPY --from=build /app/packages/organization-api/package.json ./packages/organization-api/package.json
COPY --from=build /app/packages/organization-api/dist ./packages/organization-api/dist
COPY --from=build /app/services/organization-authority/package.json ./services/organization-authority/package.json
COPY --from=build /app/services/organization-authority/dist ./services/organization-authority/dist
COPY --from=build /app/services/organization-authority/baselines ./services/organization-authority/baselines
COPY --from=build /app/services/organization-control-plane/package.json ./services/organization-control-plane/package.json
COPY --from=build /app/services/organization-control-plane/dist ./services/organization-control-plane/dist
COPY --from=build /app/services/organization-control-plane/baselines ./services/organization-control-plane/baselines
COPY --from=build /app/services/organization-record/package.json ./services/organization-record/package.json
COPY --from=build /app/services/organization-record/dist ./services/organization-record/dist
COPY --from=build /app/services/organization-record/baselines ./services/organization-record/baselines
COPY --from=build /app/services/organization-retrieval/package.json ./services/organization-retrieval/package.json
COPY --from=build /app/services/organization-retrieval/dist ./services/organization-retrieval/dist
COPY --from=build /app/services/organization-retrieval/baselines ./services/organization-retrieval/baselines
RUN install -d -m 1777 /echo-runtime
USER node
ENTRYPOINT ["node", "services/organization-authority/dist/clean-live-main.js"]
