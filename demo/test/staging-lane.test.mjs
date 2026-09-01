import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const demo = resolve(import.meta.dirname, "..");
const staging = resolve(demo, "staging");

test("staging lane selects the demo entrypoint and keeps demo state separate", () => {
  const compose = readFileSync(
    resolve(staging, "compose.synthetic-demo-v1.yaml"),
    "utf8",
  );
  assert.match(compose, /profiles: \[setup\]/);
  assert.match(
    compose,
    /services\/organization-authority\/dist\/clean-live-main\.js/,
  );
  assert.match(compose, /profiles: \[demo\]/);
  assert.match(
    compose,
    /services\/organization-authority\/dist\/synthetic-demo-main\.js/,
  );
  assert.match(compose, /ECHO_DEMO_DATA_ROOT[^\n]+:\/echo-demo/);
  assert.match(
    compose,
    /ECHO_DEMO_DATA_ROOT[^\n]+\/meetings:\/echo-demo\/meetings:ro/,
  );
  assert.doesNotMatch(compose, /clean-data\/state:\/echo-demo\/state/);
  assert.doesNotMatch(compose, /expectations\.json/);
  assert.match(compose, /slack-card-preview:/);
  assert.match(compose, /profiles: \[preview\]/);
  assert.match(compose, /ECHO_DEMO_PREVIEW_IMAGE/);
  assert.match(compose, /ECHO_DEMO_PREVIEW_SOURCE_SHA/);
  assert.match(compose, /\/state:\/echo-demo\/state:ro/);
  assert.doesNotMatch(compose, /slack-card-preview:[\s\S]*ports:/);
});

test("operator lane is syntactically valid and restores the accepted runtime", () => {
  const script = resolve(staging, "switch-synthetic-demo-v1.sh");
  const syntax = spawnSync("bash", ["-n", script], { encoding: "utf8" });
  assert.equal(syntax.status, 0, syntax.stderr);
  const source = readFileSync(script, "utf8");
  assert.match(source, /synthetic-demo-main\.js admit/);
  assert.match(source, /echo-synthetic-demo-runtime-ready-v1/);
  assert.match(source, /compose_clean up -d --no-build --wait/);
  assert.match(source, /wait_for_accepted_public_descriptor/);
  assert.match(source, /synthetic-demo-switchover-v1/);
  assert.match(source, /candidate_staged": False/);
  assert.doesNotMatch(source, /clean-founder-main\.js finalize/);
  assert.doesNotMatch(source, /expectations\.json/);
  assert.match(source, /preview-slack --image <immutable-ecr-digest>/);
  assert.match(source, /docker image inspect --format/);
  assert.match(source, /docker pull "\$image"/);
  assert.match(source, /\[\[ ! -e "\$CLEAN_OPERATION_LOCK" \]\]/);
  assert.match(source, /demo_is_stopped \|\| fail 'Slack preview requires/);
  assert.match(source, /--profile preview run --rm --no-deps slack-card-preview/);
});
