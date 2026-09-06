import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, it } from "vitest";

const REPO = resolve(import.meta.dirname, "../..");

it("installs a checksum-bound resolver for the current MCP API without exposing resolved values", () => {
  const root = mkdtempSync(join(tmpdir(), "echo-asm-exec-"));
  try {
    const bootstrap = readFileSync(
      join(REPO, "deploy/organization-authority/bootstrap-ubuntu-arm64.sh"),
      "utf8",
    );
    const upstream = readFileSync(join(REPO, "tests/fixtures/asm-exec/upstream.py"));
    const hash = (value: Buffer) => createHash("sha256").update(value).digest("hex");
    expect(hash(upstream)).toBe(bootstrap.match(/^ASM_EXEC_UPSTREAM_SHA256=(\w+)$/m)?.[1]);
    const resolver = join(root, "asm-exec");
    writeFileSync(resolver, upstream);
    const patch = bootstrap.match(/patch --batch --forward "\$asm_exec" <<'PATCH'\n([\s\S]*?)\nPATCH/)?.[1];
    expect(patch).toBeDefined();
    const applied = spawnSync("patch", ["--batch", "--forward", resolver], {
      input: `${patch}\n`, encoding: "utf8",
    });
    expect(applied.status, applied.stdout + applied.stderr).toBe(0);
    expect(hash(readFileSync(resolver))).toBe(bootstrap.match(/^ASM_EXEC_PATCHED_SHA256=(\w+)$/m)?.[1]);
    const proof = spawnSync("python3", ["-", resolver], {
      encoding: "utf8",
      input: String.raw`
import ast, contextlib, io, json, os, sys, types, urllib.error
namespace = {"__name__": "resolver_under_test"}
exec(compile(open(sys.argv[1]).read(), sys.argv[1], "exec"), namespace)
namespace["_check_sma"] = lambda: False
sentinel = "synthetic-value {{resolve:secretsmanager:do-not-resolve}}"
secret = "arn:aws:secretsmanager:us-west-2:123456789012:secret:staging/test-abc"
stage = "AWSCURRENT"
region = "us-west-2"
response = {}
calls = []
def post(payload, session_id=None):
    calls.append(payload)
    if payload["method"] == "initialize":
        return {}, "synthetic-session"
    assert session_id == "synthetic-session"
    if payload["method"] == "notifications/initialized":
        return {}, None
    assert payload["method"] == "tools/call"
    params = payload["params"]
    assert params["name"] == "aws___run_script", "retired MCP tool"
    assert set(params["arguments"]) == {"code"}
    tree = ast.parse(params["arguments"]["code"])
    assert len(tree.body) == 2
    assignment, terminal = tree.body
    assert isinstance(assignment, ast.Assign)
    assert len(assignment.targets) == 1 and assignment.targets[0].id == "result"
    assert isinstance(assignment.value, ast.Await)
    call = assignment.value.value
    assert call.func.id == "call_boto3" and not call.args
    assert {k.arg: ast.literal_eval(k.value) for k in call.keywords} == {
        "service_name": "secretsmanager", "operation_name": "GetSecretValue",
        "region_name": region, "params": {"SecretId": secret, "VersionStage": stage},
    }
    assert isinstance(terminal, ast.Expr) and terminal.value.id == "result"
    return response, None
namespace["_mcp_post"] = post
capture_out, capture_err = io.StringIO(), io.StringIO()
with contextlib.redirect_stdout(capture_out), contextlib.redirect_stderr(capture_err):
    value = json.dumps({"token": sentinel})
    for result in [
        {"content": [{"type": "text", "text": json.dumps({"status": "success", "return_value": {"SecretString": value}})}]},
        {"structuredContent": {"status": "success", "return_value": {"SecretString": value}}},
        {"structuredContent": {"output": json.dumps({"SecretString": value})}},
    ]:
        response = {"result": result}
        assert namespace["resolve_string"]("{{resolve:secretsmanager:" + secret + ":SecretString:token}}") == sentinel
    # Values are Python literals, even with quotes/newlines; no executable interpolation.
    secret, stage, region = "test'\nname", "label'\nvalue", None
    assert namespace["_resolve_via_mcp"](secret, stage, region) == value
    secret, stage, region = "test", "AWSCURRENT", "us-west-2"
    for response in [
        {"error": {"message": sentinel}},
        {"result": {"isError": True, "structuredContent": {"return_value": {"SecretString": value}}}},
        {"result": {"content": [{"type": "text", "text": "not json " + sentinel}]}},
        {"result": {"structuredContent": {"status": "error", "error": sentinel}}},
    ]:
        assert namespace["_resolve_via_mcp"](secret, stage, region) is None
    def unavailable(*args):
        raise urllib.error.URLError(sentinel)
    namespace["_mcp_post"] = unavailable
    assert namespace["_resolve_via_mcp"](secret, stage, region) is None
    # Exercise the real entry point: only the child receives the resolved environment.
    namespace["_mcp_post"] = post
    response = {"result": {"structuredContent": {"return_value": {"SecretString": value}}}}
    os.environ.clear()
    os.environ.update(AWS_REGION=region, TEST_TOKEN="{{resolve:secretsmanager:test:SecretString:token}}")
    sys.argv = ["asm-exec", "--", "synthetic-child"]
    children = []
    def child(args, env):
        assert args == ["synthetic-child"] and env["TEST_TOKEN"] == sentinel
        children.append(True)
        return types.SimpleNamespace(returncode=0)
    namespace["subprocess"].run = child
    try:
        namespace["main"]()
    except SystemExit as result:
        assert result.code == 0
    assert children == [True]
assert capture_out.getvalue() == "" and capture_err.getvalue() == ""
assert calls
`,
    });
    expect(proof.status, proof.stderr).toBe(0);
    expect(proof.stdout).toBe("");
    expect(proof.stderr).toBe("");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
