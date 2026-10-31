---
schema_version: 1
id: CMP-DESKTOP-APP
kind: component
title: Desktop app
owners:
  - unassigned
component_ids:
  - CMP-DESKTOP-APP
created_at: 2026-10-30
reviewed_at: 2026-10-30
reviewed_ref: aa92138e4a7d8386b2ff51a95c7d2f82e86236be
---

# Desktop app

## Responsibility

`product/echo-desktop/` owns the Electron app team members use: the window,
tray, global shortcuts, system notifications, the device-only Ask timeline, the
runs driver that starts impact checks, and self-update from the signed client
feed. It holds no Authority logic and no organization state. Every read and
write runs a [Person client](person-client.md) command in-process, in a host
utility process that is the only part of the app holding a token. The app is
its own package with its own `node_modules`, not a root workspace, and bundles
only public exports of `organization-api` and `federation-protocol`.

Non-goals: no direct Authority HTTP client, no local database, no processing,
no background work after the app quits.

## Data authority

The app owns local conveniences only: the Ask timeline file per account beside
the Person session, updater state under its app data, Chromium data,
`desktop.log`, and three renderer `localStorage` keys. The Person client owns
the session; the Authority owns everything organizational.

## Boundaries

- Renderer → main: allowlisted `rpc` methods, plain JSON, trusted sender only.
- Main → host: host methods; file handles become paths; host notices return as
  events.
- Host → Person client: argv in, JSON lines out, with a token refresh before
  and an account check around every account-scoped call.
- Updates: [ADR-0035](../decisions/ADR-0035-desktop-updates-from-the-signed-feed.md)
  and [ADR-0050](../decisions/ADR-0050-update-floor-only-rises.md).
- Change check and notifications:
  [ADR-0036](../decisions/ADR-0036-person-change-check.md).
- Ask progress, layout and timeline:
  [ADR-0039](../decisions/ADR-0039-ask-progress-names-after-the-access-check.md),
  [ADR-0045](../decisions/ADR-0045-ask-answer-layout.md),
  [ADR-0047](../decisions/ADR-0047-ask-timeline.md).
- Item routing on the decision page:
  [ADR-0046](../decisions/ADR-0046-private-meetings-and-item-routing.md),
  [ADR-0049](../decisions/ADR-0049-only-me-is-a-lock.md).

## Current references

- [Desktop app architecture](../architecture/desktop-app.md): processes, call
  path, screens, background work, local state.
- [Desktop README](../../product/echo-desktop/README.md): build, package,
  install and run.
- Regression proof: the `desktop-app` CI job (typecheck, unit tests,
  Playwright, packaging with its release leak check, packaged smoke) on macOS
  arm64 and Linux x64.
