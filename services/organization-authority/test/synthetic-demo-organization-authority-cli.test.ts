import { canonicalJson } from "@echo-brain/federation-protocol";
import { afterEach, describe, expect, it, vi } from "vitest";

type AnswerCompositionFailureObserver = (event: object) => void;

const runtimeState = vi.hoisted(() => ({
  answer_composition_failure: undefined as
    | AnswerCompositionFailureObserver
    | undefined,
}));

vi.mock("../src/composition/organization-authority-setup-cli.js", () => ({
  readOrganizationAuthoritySetupManifest: () => ({
    authority_url: "https://authority.example",
    oidc_config_path: "/private/oidc.json",
    pkce_key_file: "/private/pkce.key",
    slack_connection_id: "con_manifest",
    slack_approval_channel_id: "C_APPROVAL",
    llm_credential_file: "/private/llm.credential",
    owner_email: "founder@example.com",
  }),
}));

vi.mock("../src/composition/organization-authority-person-administration-cli.js", () => ({
  readPersonOidcConfiguration: () => ({
    client_authentication: "none",
    configuration: {},
  }),
}));

vi.mock(
  "../src/composition/synthetic-demo-organization-authority-composition-root-v1.js",
  () => ({
    openSyntheticDemoOrganizationAuthorityServiceV1: async (config: {
      readonly on_answer_composition_failure?: AnswerCompositionFailureObserver;
    }) => {
      runtimeState.answer_composition_failure =
        config.on_answer_composition_failure;
      return {
        processing: "active" as const,
        close: async () => undefined,
      };
    },
  }),
);

const { runSyntheticDemoOrganizationAuthorityCliV1 } = await import(
  "../src/composition/synthetic-demo-organization-authority-cli.js"
);

afterEach(() => {
  runtimeState.answer_composition_failure = undefined;
});

function start(io: { readonly stderr: (value: string) => void }) {
  return runSyntheticDemoOrganizationAuthorityCliV1(
    [
      "serve",
      "--state-dir",
      "/private/state",
      "--meetings-dir",
      "/private/meetings",
      "--host",
      "127.0.0.1",
      "--port",
      "43179",
      "--slack-signing-secret-file",
      "/private/slack-signing-secret",
    ],
    { stdout: () => undefined, ...io },
  );
}

describe("synthetic demo runtime CLI events", () => {
  it("writes only the closed answer-composition failure schema", async () => {
    const stderr: string[] = [];
    const running = start({ stderr: (value) => stderr.push(value) });
    await vi.waitFor(() =>
      expect(runtimeState.answer_composition_failure).toBeDefined(),
    );

    runtimeState.answer_composition_failure!({
      schema_version: 1,
      kind: "echo-clean-layer4-failure-v1",
      stage: "answer",
      failure_class: "adapter_response",
      elapsed_ms: 120_000,
      http_status: 503,
      finish_reason: "error",
      adapter_id: "private-adapter-sentinel",
      adapter_request_id: "private-request-sentinel",
      retrieval_generation_id: "private-retrieval-sentinel",
      question: "private-question-sentinel",
      evidence: "private-evidence-sentinel",
      answer: "private-answer-sentinel",
    });
    process.emit("SIGTERM");
    await expect(running).resolves.toBe(0);

    expect(stderr).toEqual([
      `${canonicalJson({
        schema_version: 1,
        kind: "echo-synthetic-demo-runtime-ready-v1",
        processing: "active",
      } as never)}\n`,
      `${canonicalJson({
        schema_version: 1,
        kind: "echo-clean-layer4-failure-v1",
        stage: "answer",
        failure_class: "adapter_response",
        elapsed_ms: 120_000,
        http_status: 503,
        finish_reason: "error",
      } as never)}\n`,
    ]);

    const output = stderr.join("");
    for (const sentinel of [
      "private-adapter-sentinel",
      "private-request-sentinel",
      "private-retrieval-sentinel",
      "private-question-sentinel",
      "private-evidence-sentinel",
      "private-answer-sentinel",
    ]) {
      expect(output).not.toContain(sentinel);
    }
  });
});
