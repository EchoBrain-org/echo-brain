import { describe, expect, it } from "vitest";
import {
  RAYCAST_CLI_MAX_OUTPUT_BYTES,
  RAYCAST_CLI_TIMEOUT_MS,
  runRaycastCliWrapper,
  type RaycastCliSpawn,
} from "../../src/product/person-client/raycast-cli-wrapper.js";

const SHA = `sha256:${"a".repeat(64)}`;

function successOutput(): string {
  return JSON.stringify({
    ok: true,
    result: {
      schema_version: 1,
      kind: "echo-clean-person-answer-v1",
      generation_id: SHA,
      record_head: { position: 1, record_sha256: SHA },
      answer: "Use the smallest viable hotkey overlay.",
      citations: [
        {
          atom_id: SHA,
          record_sha256: SHA,
          policy_id: "organization-member-readable-person-v2",
        },
        {
          atom_id: `sha256:${"b".repeat(64)}`,
          record_sha256: SHA,
          policy_id: "restricted-reviewer-person-v2",
        },
      ],
    },
  });
}

function spawn(result: ReturnType<RaycastCliSpawn>): RaycastCliSpawn {
  return () => result;
}

describe("Raycast CLI wrapper", () => {
  it("invokes only the installed CLI ask argv with a shell-free bounded process", () => {
    let invocation:
      | { executable: string; argv: readonly string[]; options: unknown }
      | undefined;
    const runner: RaycastCliSpawn = (executable, argv, options) => {
      invocation = { executable, argv, options };
      return { status: 0, stdout: successOutput(), stderr: "" };
    };

    const result = runRaycastCliWrapper(
      { cli_path: "/Applications/ECHO/echo-brain", question: "What did we decide?" },
      { spawn_sync: runner },
    );

    expect(result.ok).toBe(true);
    expect(invocation).toEqual({
      executable: "/Applications/ECHO/echo-brain",
      argv: ["person", "ask", "--question", "What did we decide?"],
      options: {
        shell: false,
        timeout: RAYCAST_CLI_TIMEOUT_MS,
        maxBuffer: RAYCAST_CLI_MAX_OUTPUT_BYTES,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      },
    });
  });

  it("formats a valid current CLI answer for Raycast fullOutput", () => {
    const result = runRaycastCliWrapper(
      { cli_path: "/Applications/ECHO/echo-brain", question: "What did we decide?" },
      { spawn_sync: spawn({ status: 0, stdout: successOutput(), stderr: "" }) },
    );

    expect(result).toEqual({
      ok: true,
      answer: "Use the smallest viable hotkey overlay.",
      citation_count: 2,
      citation_policies: [
        "organization-member-readable-person-v2",
        "restricted-reviewer-person-v2",
      ],
      fullOutput:
        "Use the smallest viable hotkey overlay.\n\nCitations: 2\nPolicies: organization-member-readable-person-v2, restricted-reviewer-person-v2",
    });
  });

  it("returns the CLI's safe error envelope for a nonzero exit", () => {
    const result = runRaycastCliWrapper(
      { cli_path: "/Applications/ECHO/echo-brain", question: "What did we decide?" },
      {
        spawn_sync: spawn({
          status: 1,
          stdout: '{"answer":"must not be displayed"}',
          stderr: JSON.stringify({
            ok: false,
            action: "ask",
            error: "Person Authority rejected the request",
          }),
        }),
      },
    );

    expect(result).toEqual({
      ok: false,
      error: "cli_failed",
      fullOutput:
        "ECHO could not answer that question. Person Authority rejected the request",
    });
  });

  it("returns a safe timeout result without exposing process output", () => {
    const result = runRaycastCliWrapper(
      { cli_path: "/Applications/ECHO/echo-brain", question: "What did we decide?" },
      {
        spawn_sync: spawn({
          status: null,
          error: Object.assign(new Error("timed out"), { code: "ETIMEDOUT" }),
          stdout: "sensitive output",
          stderr: "sensitive error",
        }),
      },
    );

    expect(result).toEqual({
      ok: false,
      error: "cli_timed_out",
      fullOutput: "The ECHO request timed out. Try again.",
    });
  });

  it("rejects invalid CLI output without releasing it", () => {
    const result = runRaycastCliWrapper(
      { cli_path: "/Applications/ECHO/echo-brain", question: "What did we decide?" },
      { spawn_sync: spawn({ status: 0, stdout: "not json", stderr: "" }) },
    );

    expect(result).toEqual({
      ok: false,
      error: "cli_output_invalid",
      fullOutput: "The installed ECHO client returned an invalid response.",
    });
  });

  it("preserves shell metacharacters as one literal question argument", () => {
    const question = "What changed?; open /tmp/nope && $(whoami)";
    let argv: readonly string[] | undefined;
    const runner: RaycastCliSpawn = (_executable, receivedArgv) => {
      argv = receivedArgv;
      return { status: 0, stdout: successOutput(), stderr: "" };
    };

    const result = runRaycastCliWrapper(
      { cli_path: "/Applications/ECHO/echo-brain", question },
      { spawn_sync: runner },
    );

    expect(result.ok).toBe(true);
    expect(argv).toEqual(["person", "ask", "--question", question]);
  });
});
