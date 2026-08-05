import { chmodSync, mkdirSync, mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProductRuntimeConfig } from "../../../src/product/config.js";

/**
 * Shared fixtures for the retained retirement-fence behavior tests. The
 * founder-provenance product surface is deleted; residue in these tests is
 * always placeholder bytes placed at the retired mode's frozen state-layout
 * paths, because the detector reads presence and entry type only.
 */

export function createPrivateTestState(
  temporary: string[],
  prefix = "echo-retired-provenance-",
): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  temporary.push(root);
  const state = join(realpathSync(root), "state");
  mkdirSync(state, { mode: 0o700 });
  chmodSync(state, 0o700);
  return state;
}

export function manualRuntimeConfig(stateDir: string): ProductRuntimeConfig {
  return {
    schema_version: 1,
    lane: "team-product",
    state_dir: stateDir,
    meeting_sources: [{
      adapter_id: "granola", instance_id: "primary",
      credential_ref: "file:/private/local/granola-api-key", settings: {},
    }],
    decision_processor: { adapter_id: "structured-text", instance_id: "primary", settings: {} },
    delivery_surfaces: [{ adapter_id: "jsonl-outbox", instance_id: "local", settings: {} }],
    approval_mode: "manual",
  };
}
