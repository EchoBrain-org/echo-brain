FROM node:22.22.1-bookworm-slim@sha256:4f77a690f2f8946ab16fe1e791a3ac0667ae1c3575c3e4d0d4589e9ed5bfaf3d AS build

WORKDIR /app
COPY package.json npm-shrinkwrap.json ./
COPY packages/federation-protocol/package.json ./packages/federation-protocol/package.json
COPY packages/organization-protocol/package.json ./packages/organization-protocol/package.json
COPY packages/organization-api/package.json ./packages/organization-api/package.json
COPY src/product/person-client/package.json ./src/product/person-client/package.json
COPY services/organization-authority/package.json ./services/organization-authority/package.json
COPY packages/organization-control-plane/package.json ./packages/organization-control-plane/package.json
COPY packages/organization-record/package.json ./packages/organization-record/package.json
COPY packages/organization-retrieval/package.json ./packages/organization-retrieval/package.json
# Keep dependency installation independent of application source.  BuildKit can
# reuse this layer when a source-only change is rebuilt in CI.
RUN npm ci
COPY tsconfig*.json ./
COPY packages ./packages
COPY services/organization-authority ./services/organization-authority
COPY packages/organization-control-plane ./packages/organization-control-plane
COPY packages/organization-record ./packages/organization-record
COPY packages/organization-retrieval ./packages/organization-retrieval
RUN npm run build --workspace @echo-brain/organization-authority \
  && npm ci --omit=dev --workspace @echo-brain/organization-authority --include-workspace-root=false
RUN find packages services -type f \( -name '*.d.ts' -o -name '*.tsbuildinfo' \) -delete

FROM node:22.22.1-bookworm-slim@sha256:4f77a690f2f8946ab16fe1e791a3ac0667ae1c3575c3e4d0d4589e9ed5bfaf3d

ARG ECHO_SOURCE_SHA
ARG ECHO_BUILD_NUMBER
LABEL org.opencontainers.image.revision="${ECHO_SOURCE_SHA}"
LABEL org.echobrain.authority.build-number="${ECHO_BUILD_NUMBER}"
LABEL org.echobrain.authority.telemetry.staging-journey-v1="true"
LABEL org.echobrain.authority.state-capability.staging-synthetic-meeting-canary-v1="true"
ENV NODE_ENV=production \
    ECHO_STAGING_JOURNEY_TELEMETRY_V1="true" \
    ECHO_SOURCE_SHA="${ECHO_SOURCE_SHA}" \
    ECHO_BUILD_NUMBER="${ECHO_BUILD_NUMBER}"
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
COPY --from=build /app/packages/organization-control-plane/package.json ./packages/organization-control-plane/package.json
COPY --from=build /app/packages/organization-control-plane/dist ./packages/organization-control-plane/dist
COPY --from=build /app/packages/organization-control-plane/baselines ./packages/organization-control-plane/baselines
COPY --from=build /app/packages/organization-record/package.json ./packages/organization-record/package.json
COPY --from=build /app/packages/organization-record/dist ./packages/organization-record/dist
COPY --from=build /app/packages/organization-record/baselines ./packages/organization-record/baselines
COPY --from=build /app/packages/organization-retrieval/package.json ./packages/organization-retrieval/package.json
COPY --from=build /app/packages/organization-retrieval/dist ./packages/organization-retrieval/dist
COPY --from=build /app/packages/organization-retrieval/baselines ./packages/organization-retrieval/baselines
RUN install -d -m 1777 /echo-runtime
USER node
ENTRYPOINT ["node", "services/organization-authority/dist/clean-live-main.js"]
