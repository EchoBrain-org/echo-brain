import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { dirname, join } from "node:path";

const START_TIMEOUT_MS = 15_000;
const STOP_TIMEOUT_MS = 10_000;
const MAX_CAPTURE_BYTES = 64 * 1024;

class OwnedProcessExitUnconfirmedError extends Error {
  constructor(label) {
    super(`${label} exit could not be confirmed`);
    this.code = "OWNED_PROCESS_EXIT_UNCONFIRMED";
  }
}

function boundedAppend(current, chunk) {
  const next = `${current}${String(chunk)}`;
  return next.length <= MAX_CAPTURE_BYTES
    ? next
    : next.slice(next.length - MAX_CAPTURE_BYTES);
}

function privateRuntimeEnvironment(config) {
  return {
    PATH: `${dirname(process.execPath)}:/usr/bin:/bin:/usr/sbin:/sbin`,
    LANG: process.env.LANG ?? "C",
    LC_ALL: process.env.LC_ALL ?? "C",
    HOME: config.homeDirectory,
    TMPDIR: config.temporaryDirectory,
    NODE_OPTIONS: "",
    NODE_PATH: "",
    ECHO_ORGANIZATION_AUTHORITY_ALLOW_DEVELOPMENT_FILE_SIGNER: "true",
    ECHO_ORGANIZATION_AUTHORITY_ID: config.authorityId,
    ECHO_ORGANIZATION_ID: config.organizationId,
    ECHO_ORGANIZATION_AUTHORITY_DEVELOPMENT_KEY_DIRECTORY: config.keyDirectory,
    ...(config.command === "serve"
      ? {
          ECHO_ORGANIZATION_DISPLAY_NAME: config.organizationDisplayName,
          ECHO_ORGANIZATION_AUTHORITY_PIN_SHA256: config.authorityPin,
          ECHO_ORGANIZATION_AUTHORITY_DATABASE_PATH: config.databasePath,
          ECHO_ORGANIZATION_AUTHORITY_ADMIN_TOKEN: config.adminToken,
          ECHO_ORGANIZATION_AUTHORITY_TRUSTED_PROXY_TOKEN:
            config.trustedProxyToken,
          ECHO_ORGANIZATION_AUTHORITY_HOST: "127.0.0.1",
          ECHO_ORGANIZATION_AUTHORITY_PORT: String(config.port),
          ECHO_ORGANIZATION_AUTHORITY_ACTIVE_LEASE_TTL_MS: String(
            config.activeLeaseTtlMs,
          ),
          ECHO_ORGANIZATION_AUTHORITY_ACCESS_REQUEST_MAXIMUM_AGE_MS: String(
            config.accessRequestMaximumAgeMs,
          ),
        }
      : {}),
  };
}

function authorityEntrypoint(packageRoot) {
  return join(packageRoot, "dist", "main.js");
}

function waitForExit(child, timeoutMs) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve({ code: child.exitCode, signal: child.signalCode });
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("authority process did not exit before timeout"));
    }, timeoutMs);
    timer.unref?.();
    const onExit = (code, signal) => {
      cleanup();
      resolve({ code, signal });
    };
    const onError = () => {
      cleanup();
      reject(new Error("authority process emitted a process error"));
    };
    const cleanup = () => {
      clearTimeout(timer);
      child.off("exit", onExit);
      child.off("error", onError);
    };
    child.once("exit", onExit);
    child.once("error", onError);
  });
}

async function terminateOwnedChild(child, label) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  if (child.pid === undefined) return;
  child.kill("SIGTERM");
  try {
    await waitForExit(child, STOP_TIMEOUT_MS);
    return;
  } catch {
    // Escalate only the child process created by this module.
  }
  child.kill("SIGKILL");
  try {
    await waitForExit(child, STOP_TIMEOUT_MS);
  } catch {
    throw new OwnedProcessExitUnconfirmedError(label);
  }
}

export function generatePrivateRuntimeToken() {
  return randomBytes(32).toString("base64url");
}

export async function reserveLoopbackPort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    server.close();
    throw new Error("could not reserve a loopback port");
  }
  await new Promise((resolve, reject) =>
    server.close((error) => (error === undefined ? resolve() : reject(error))),
  );
  return address.port;
}

export async function initializeDevelopmentAuthority(config) {
  const child = spawn(
    process.execPath,
    [authorityEntrypoint(config.packageRoot), "init-development"],
    {
      cwd: config.packageRoot,
      env: privateRuntimeEnvironment({
        ...config,
        command: "init-development",
      }),
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout = boundedAppend(stdout, chunk);
  });
  child.stderr.on("data", (chunk) => {
    stderr = boundedAppend(stderr, chunk);
  });
  let result;
  try {
    result = await waitForExit(child, START_TIMEOUT_MS);
  } catch (error) {
    await terminateOwnedChild(child, "authority initialization process");
    throw error;
  }
  if (result.code !== 0) {
    throw new Error(
      `packaged authority initialization failed with code ${String(result.code)}${stderr === "" ? "" : " (diagnostics suppressed)"}`,
    );
  }
  let parsed;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new Error("packaged authority initialization returned invalid JSON");
  }
  if (
    parsed === null ||
    typeof parsed !== "object" ||
    Object.keys(parsed).sort().join(",") !==
      "authority_descriptor,authority_pin_sha256"
  ) {
    throw new Error(
      "packaged authority initialization returned an unexpected shape",
    );
  }
  return parsed;
}

export async function startAuthorityProcess(config) {
  const child = spawn(
    process.execPath,
    [authorityEntrypoint(config.packageRoot), "serve"],
    {
      cwd: config.packageRoot,
      env: privateRuntimeEnvironment({ ...config, command: "serve" }),
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let stderr = "";
  let settled = false;
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      finish(new Error("packaged authority did not become ready"));
    }, START_TIMEOUT_MS);
    timer.unref?.();
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.off("error", onError);
      child.off("exit", onExit);
      error === undefined ? resolve() : reject(error);
    };
    const onError = () =>
      finish(new Error("packaged authority could not start"));
    const onExit = (code) =>
      finish(
        new Error(
          `packaged authority exited before readiness with code ${String(code)}`,
        ),
      );
    child.once("error", onError);
    child.once("exit", onExit);
    child.stdout.resume();
    child.stderr.on("data", (chunk) => {
      stderr = boundedAppend(stderr, chunk);
      if (
        stderr.includes(
          `organization authority listening on 127.0.0.1:${String(config.port)}`,
        )
      ) {
        finish();
      }
    });
  }).catch(async (error) => {
    await terminateOwnedChild(child, "authority startup process");
    throw error;
  });

  let stopped = false;
  return {
    generation: config.generation,
    origin: `http://127.0.0.1:${String(config.port)}/`,
    async stop() {
      if (stopped) return;
      stopped = true;
      await terminateOwnedChild(child, "authority service process");
    },
    assertRunning() {
      if (child.exitCode !== null || child.signalCode !== null) {
        throw new Error("packaged authority process is not running");
      }
    },
  };
}
