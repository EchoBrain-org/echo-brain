#!/usr/bin/env bash

set -euo pipefail

if [[ "$#" -ne 2 ]]; then
  printf 'usage: %s <artifact.tgz> <expected-version>\n' "$0" >&2
  exit 2
fi

artifact="$1"
expected_version="$2"

if [[ ! -f "$artifact" || -L "$artifact" ]]; then
  printf 'artifact must be a regular file: %s\n' "$artifact" >&2
  exit 1
fi
if [[ "$(node -p 'process.platform')" != 'darwin' ]]; then
  printf 'INTERNAL LIVE smoke requires macOS\n' >&2
  exit 1
fi
if [[ "$(node -p 'process.arch')" != 'arm64' ]]; then
  printf 'INTERNAL LIVE smoke requires arm64\n' >&2
  exit 1
fi

prefix="$RUNNER_TEMP/echo-brain-internal-live-install"
runtime_root="$RUNNER_TEMP/echo-brain-internal-live-runtime"
mkdir -p "$prefix" "$runtime_root"
runtime_root="$(cd "$runtime_root" && pwd -P)"

npm install --prefix "$prefix" "$artifact"
cli="$prefix/node_modules/.bin/echo-brain"
config="$runtime_root/config/runtime.json"
state="$runtime_root/state"
status_file="$runtime_root/service-status.json"
doctor_file="$runtime_root/doctor.json"

cleanup() {
  if [[ -x "${cli:-}" && -f "${config:-}" ]]; then
    "$cli" service uninstall --config "$config" >/dev/null 2>&1 || true
  fi
}

dump_diagnostics() {
  {
    printf '%s\n' 'INTERNAL LIVE LaunchAgent status:'
    if [[ -f "$status_file" ]]; then
      cat "$status_file"
    else
      printf '%s\n' 'status file was not created'
    fi
    for log_key in stdout_path stderr_path; do
      log_path="$(
        node -e '
          const fs = require("node:fs");
          try {
            const value = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
            process.stdout.write(value.service?.[process.argv[2]] ?? "");
          } catch {}
        ' "$status_file" "$log_key"
      )"
      printf '%s\n' "LaunchAgent $log_key:"
      if [[ -n "$log_path" && -f "$log_path" ]]; then
        cat "$log_path"
      else
        printf '%s\n' 'log file is unavailable'
      fi
    done
  } >&2
}

trap cleanup EXIT

actual_version="$($cli --version)"
if [[ "$actual_version" != "$expected_version" ]]; then
  printf 'installed version %s does not match expected %s\n' \
    "$actual_version" "$expected_version" >&2
  exit 1
fi

# This package smoke has no live organization Authority. Materialize its
# deliberately offline fixture directly; employee setup is exercised through
# the public `bootstrap` command in the product tests.
mkdir -p "$(dirname "$config")" "$state/credentials"
chmod 700 "$(dirname "$config")" "$state" "$state/credentials"
node -e '
  const fs = require("node:fs");
  const path = require("node:path");
  const configPath = process.argv[1];
  const state = process.argv[2];
  const value = {
    schema_version: 1,
    lane: "team-product",
    state_dir: state,
    meeting_sources: [{
      adapter_id: "granola",
      instance_id: "primary",
      credential_ref: `file:${path.join(state, "credentials", "granola-api-key")}`,
      settings: {
        base_url: "https://127.0.0.1:1",
        request_timeout_ms: 1000,
      },
    }],
    decision_processor: {
      adapter_id: "structured-text",
      instance_id: "primary",
      settings: {},
    },
    delivery_surfaces: [{
      adapter_id: "jsonl-outbox",
      instance_id: "local",
      settings: {
        path: path.join(state, "outbox.jsonl"),
        destination_id: "local-outbox",
      },
    }],
    approval_mode: "manual",
  };
  fs.writeFileSync(configPath, `${JSON.stringify(value, null, 2)}\n`);
' "$config" "$state"
chmod 600 "$config"
printf 'grn_ci_internal_live_smoke\n' > "$state/credentials/granola-api-key"
chmod 600 "$state/credentials/granola-api-key"

"$cli" init --config "$config"
"$cli" service install --config "$config"

launchagent_pid=''
for _ in {1..20}; do
  "$cli" status --config "$config" > "$status_file"
  if launchagent_pid="$(
    node -e '
      const fs = require("node:fs");
      const value = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
      const pid = value.service?.pid;
      if (
        !value.initialized ||
        !value.service?.installed ||
        !value.service?.loaded ||
        !value.service?.running ||
        !Number.isSafeInteger(pid) ||
        pid <= 0
      ) {
        process.exit(1);
      }
      process.stdout.write(String(pid));
    ' "$status_file"
  )"; then
    break
  fi
  launchagent_pid=''
  sleep 1
done
if [[ -z "$launchagent_pid" ]]; then
  dump_diagnostics
  exit 1
fi

sleep 2
"$cli" status --config "$config" > "$status_file"
stable_pid="$(
  node -e '
    const fs = require("node:fs");
    const value = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    const pid = value.service?.pid;
    if (
      !value.initialized ||
      !value.service?.installed ||
      !value.service?.loaded ||
      !value.service?.running ||
      !Number.isSafeInteger(pid) ||
      pid <= 0
    ) {
      process.exit(1);
    }
    process.stdout.write(String(pid));
  ' "$status_file"
)" || {
  dump_diagnostics
  exit 1
}
if [[ "$stable_pid" != "$launchagent_pid" ]]; then
  dump_diagnostics
  printf 'LaunchAgent PID changed from %s to %s\n' \
    "$launchagent_pid" "$stable_pid" >&2
  exit 1
fi

plist="$(
  node -e '
    const fs = require("node:fs");
    const value = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    process.stdout.write(value.service.plist_path);
  ' "$status_file"
)"
plutil -lint "$plist"
if [[ "$(stat -f '%Lp' "$plist")" != '600' ]]; then
  printf 'LaunchAgent plist must have mode 0600\n' >&2
  exit 1
fi

set +e
"$cli" doctor --config "$config" > "$doctor_file" 2>&1
doctor_status="$?"
set -e
if [[ "$doctor_status" -ne 1 ]]; then
  printf 'fixture doctor must fail only on the deliberately unreachable Granola endpoint\n' >&2
  cat "$doctor_file" >&2
  exit 1
fi
node -e '
  const fs = require("node:fs");
  const value = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  const expectedLifecycleCheckIds = [
    "platform",
    "config",
    "state-filesystem",
    "state-directory",
    "installation-manifest",
    "node-runtime",
    "cli-entrypoint",
    "service-plist",
    "service-running",
    "service-credentials",
    "organization-state",
  ];
  const expectedCheckIds = [...expectedLifecycleCheckIds, "adapters"];
  const checksById = new Map(
    Array.isArray(value.checks)
      ? value.checks.map((check) => [check?.id, check])
      : [],
  );
  const exactChecks =
    Array.isArray(value.checks) &&
    checksById.size === expectedCheckIds.length &&
    value.checks.length === expectedCheckIds.length &&
    expectedCheckIds.every((id) => checksById.has(id));
  const lifecycleChecks = expectedLifecycleCheckIds.map((id) => checksById.get(id));
  const adapterCheck = checksById.get("adapters");
  const granola = value.adapters?.find((adapter) => adapter?.adapter_id === "granola");
  const otherAdapters = value.adapters?.filter((adapter) => adapter?.adapter_id !== "granola");
  if (
    value.ok !== false ||
    !exactChecks ||
    lifecycleChecks.some((check) => check?.ok !== true) ||
    adapterCheck?.ok !== false ||
    granola?.status !== "degraded" ||
    !Array.isArray(otherAdapters) ||
    otherAdapters.length !== 2 ||
    otherAdapters.some((adapter) => adapter?.status !== "healthy")
  ) {
    throw new Error(`doctor fixture result was unexpected: ${JSON.stringify(value)}`);
  }
' "$doctor_file"

"$cli" service uninstall --config "$config"
"$cli" status --config "$config" > "$status_file"
node -e '
  const fs = require("node:fs");
  const value = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  if (
    !value.initialized ||
    value.service.installed ||
    value.service.loaded ||
    value.service.running
  ) {
    throw new Error(`LaunchAgent cleanup failed: ${JSON.stringify(value)}`);
  }
  process.stdout.write(`${JSON.stringify({
    ok: true,
    kind: "echo-internal-live-macos-smoke",
    version: process.argv[2],
    platform: process.platform,
    arch: process.arch,
    launchagent_stable: true,
    doctor_lifecycle_checks_ok: true,
    doctor_live_adapter_check: "expected-degraded-fixture",
    uninstall_ok: true,
  })}\n`);
' "$status_file" "$expected_version"
