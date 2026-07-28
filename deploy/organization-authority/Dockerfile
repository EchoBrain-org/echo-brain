FROM node:22.22.1-bookworm-slim@sha256:4f77a690f2f8946ab16fe1e791a3ac0667ae1c3575c3e4d0d4589e9ed5bfaf3d AS build

WORKDIR /app
COPY package.json npm-shrinkwrap.json tsconfig*.json ./
COPY packages ./packages
COPY services/organization-authority ./services/organization-authority
RUN npm ci \
  && npm run build:workspaces \
  && npm prune --omit=dev

FROM node:22.22.1-bookworm-slim@sha256:4f77a690f2f8946ab16fe1e791a3ac0667ae1c3575c3e4d0d4589e9ed5bfaf3d

ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/packages/federation-protocol/package.json ./packages/federation-protocol/package.json
COPY --from=build /app/packages/federation-protocol/dist ./packages/federation-protocol/dist
COPY --from=build /app/packages/organization-protocol/package.json ./packages/organization-protocol/package.json
COPY --from=build /app/packages/organization-protocol/dist ./packages/organization-protocol/dist
COPY --from=build /app/packages/organization-api/package.json ./packages/organization-api/package.json
COPY --from=build /app/packages/organization-api/dist ./packages/organization-api/dist
COPY --from=build /app/services/organization-authority/package.json ./services/organization-authority/package.json
COPY --from=build /app/services/organization-authority/dist ./services/organization-authority/dist
COPY --from=build /app/services/organization-authority/migrations ./services/organization-authority/migrations
USER node
ENTRYPOINT ["node", "services/organization-authority/dist/main.js"]
CMD ["help"]
