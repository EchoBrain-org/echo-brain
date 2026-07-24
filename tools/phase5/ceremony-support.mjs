import { spawn } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
} from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const TOOL_DIRECTORY = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(TOOL_DIRECTORY, "..", "..");
const EMPLOYEE_DRIVER = join(TOOL_DIRECTORY, "employee-driver.mjs");
const REHEARSAL_FAULT_INJECTION = join(
  REPO_ROOT,
  "dist",
  "product",
  "organization",
  "state",
  "rehearsal-fault-injection.js",
);
const MAX_RESPONSE_BYTES = 128 * 1024;
const CHILD_TIMEOUT_MS = 30_000;

function privateChildEnvironment(temporaryDirectory) {
  return {
    PATH: `${dirname(process.execPath)}:/usr/bin:/bin:/usr/sbin:/sbin`,
    LANG: process.env.LANG ?? "C",
    LC_ALL: process.env.LC_ALL ?? "C",
    HOME: temporaryDirectory,
    TMPDIR: temporaryDirectory,
    NODE_OPTIONS: "",
    NODE_PATH: "",
  };
}

function waitForEmployee(child, command) {
  return new Promise((resolveResult, reject) => {
    let stdout = "";
    let stderrBytes = 0;
    let settled = false;
    let terminationError = null;
    let forceTimer;
    let confirmationTimer;
    const timer = setTimeout(() => {
      terminate(new Error(`employee ${command} timed out`));
    }, CHILD_TIMEOUT_MS);
    timer.unref?.();
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(forceTimer);
      clearTimeout(confirmationTimer);
      error === undefined ? resolveResult(value) : reject(error);
    };
    const terminate = (error) => {
      if (settled || terminationError !== null) return;
      terminationError = error;
      clearTimeout(timer);
      if (
        child.pid === undefined ||
        child.exitCode !== null ||
        child.signalCode !== null
      ) {
        finish(error);
        return;
      }
      child.kill("SIGTERM");
      forceTimer = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) {
          child.kill("SIGKILL");
        }
      }, 1_000);
      forceTimer.unref?.();
      confirmationTimer = setTimeout(() => {
        const unconfirmed = new Error(
          `employee ${command} exit could not be confirmed`,
        );
        unconfirmed.code = "OWNED_PROCESS_EXIT_UNCONFIRMED";
        finish(unconfirmed);
      }, 10_000);
      confirmationTimer.unref?.();
    };
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
      if (Buffer.byteLength(stdout) > MAX_RESPONSE_BYTES) {
        terminate(new Error(`employee ${command} output exceeded its limit`));
      }
    });
    child.stderr.on("data", (chunk) => {
      stderrBytes += chunk.length;
      if (stderrBytes > MAX_RESPONSE_BYTES) {
        terminate(
          new Error(`employee ${command} diagnostics exceeded its limit`),
        );
      }
    });
    child.once("error", () => {
      if (terminationError === null) {
        finish(new Error(`employee ${command} could not start`));
      }
    });
    child.once("exit", (code) => {
      if (terminationError !== null) {
        finish(terminationError);
        return;
      }
      let parsed;
      try {
        parsed = JSON.parse(stdout);
      } catch {
        finish(new Error(`employee ${command} returned invalid JSON`));
        return;
      }
      if (
        parsed === null ||
        typeof parsed !== "object" ||
        typeof parsed.ok !== "boolean"
      ) {
        finish(new Error(`employee ${command} returned an invalid result`));
        return;
      }
      if (parsed.ok && code !== 0) {
        finish(new Error(`employee ${command} success used a failing exit`));
        return;
      }
      if (!parsed.ok && code === 0) {
        finish(new Error(`employee ${command} failure used a success exit`));
        return;
      }
      finish(undefined, parsed);
    });
  });
}

export async function runEmployeeProcess(input, temporaryDirectory) {
  const command =
    typeof input?.command === "string" ? input.command : "unknown";
  const child = spawn(process.execPath, [EMPLOYEE_DRIVER], {
    cwd: TOOL_DIRECTORY,
    env: privateChildEnvironment(temporaryDirectory),
    stdio: ["pipe", "pipe", "pipe"],
  });
  const completed = waitForEmployee(child, command);
  child.stdin.on("error", () => {
    // The result/exit channel owns the normalized failure if the child closes
    // before consuming all private stdin bytes.
  });
  child.stdin.end(JSON.stringify(input));
  return completed;
}

export async function adminPost(options) {
  let response;
  try {
    response = await fetch(new URL(options.path, options.origin), {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(15_000),
      headers: {
        accept: "application/json",
        authorization: `Bearer ${options.adminToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(options.body),
    });
  } catch {
    throw new Error("ADMIN_RESULT_AMBIGUOUS");
  }
  return readAdminJsonResponse(response);
}

export async function adminGet(options) {
  let response;
  try {
    response = await fetch(new URL(options.path, options.origin), {
      method: "GET",
      redirect: "error",
      signal: AbortSignal.timeout(15_000),
      headers: {
        accept: "application/json",
        authorization: `Bearer ${options.adminToken}`,
      },
    });
  } catch {
    throw new Error("ADMIN_RESULT_AMBIGUOUS");
  }
  return readAdminJsonResponse(response);
}

async function readAdminJsonResponse(response) {
  const declared = response.headers.get("content-length");
  if (
    declared !== null &&
    (!/^\d+$/.test(declared) || Number(declared) > MAX_RESPONSE_BYTES)
  ) {
    throw new Error("ADMIN_RESPONSE_INVALID");
  }
  if (response.body === null) throw new Error("ADMIN_RESPONSE_INVALID");
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw new Error("ADMIN_RESPONSE_INVALID");
      }
      chunks.push(Buffer.from(value));
    }
  } catch (error) {
    if (error instanceof Error && error.message === "ADMIN_RESPONSE_INVALID") {
      throw error;
    }
    throw new Error("ADMIN_RESULT_AMBIGUOUS");
  } finally {
    reader.releaseLock();
  }
  const bytes = Buffer.concat(chunks, total);
  if (bytes.length === 0 || bytes.length > MAX_RESPONSE_BYTES) {
    throw new Error("ADMIN_RESPONSE_INVALID");
  }
  let value;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new Error("ADMIN_RESPONSE_INVALID");
  }
  if (!response.ok) throw new Error("ADMIN_REQUEST_REJECTED");
  return value;
}

export function assertIsolatedPaths(paths) {
  const resolved = paths.map((path) => resolve(path));
  if (new Set(resolved).size !== resolved.length) {
    throw new Error("Phase 5 isolated paths overlap");
  }
  for (let left = 0; left < resolved.length; left += 1) {
    for (let right = left + 1; right < resolved.length; right += 1) {
      const relation = relative(resolved[left], resolved[right]);
      const reverse = relative(resolved[right], resolved[left]);
      if (
        relation === "" ||
        (!relation.startsWith(`..${sep}`) && relation !== "..") ||
        (!reverse.startsWith(`..${sep}`) && reverse !== "..")
      ) {
        throw new Error("Phase 5 isolated paths are nested");
      }
    }
  }
  for (const path of resolved) {
    const state = lstatSync(path, { throwIfNoEntry: false });
    if (state?.isSymbolicLink()) {
      throw new Error("Phase 5 isolated path is a symbolic link");
    }
  }
}

export async function corruptClosedOrganizationDatabase(options) {
  mkdirSync(dirname(options.destination), { recursive: true, mode: 0o700 });
  copyFileSync(options.source, options.destination);
  chmodSync(options.destination, 0o600);
  // Loaded from the repository build, never from the installed package: the
  // fault injector is outside the product boundary closure precisely so a
  // client artifact cannot carry a hook that destroys stored state. Both come
  // from the same source SHA, which the ceremony asserts before this runs.
  const faultInjection = await import(
    pathToFileURL(REHEARSAL_FAULT_INJECTION).href
  );
  faultInjection.corruptStoredOrganizationAccessStateForRehearsal(
    options.destination,
  );
}

function filesUnder(root) {
  const files = [];
  const visit = (path) => {
    const state = lstatSync(path);
    if (state.isSymbolicLink()) {
      throw new Error("private rehearsal state contains a symbolic link");
    }
    if (state.isFile()) {
      files.push(path);
      return;
    }
    if (!state.isDirectory()) {
      throw new Error("private rehearsal state contains a special file");
    }
    if ((state.mode & 0o777) !== 0o700) {
      throw new Error(
        `private state directory mode is unsafe: ${basename(path)}`,
      );
    }
    for (const entry of readdirSync(path)) visit(join(path, entry));
  };
  visit(root);
  return files;
}

export function assertPrivateStatePermissions(roots) {
  let checkedFiles = 0;
  for (const root of roots) {
    for (const file of filesUnder(root)) {
      const fileState = lstatSync(file);
      if ((fileState.mode & 0o777) !== 0o600) {
        throw new Error(`private state file mode is unsafe: ${basename(file)}`);
      }
      checkedFiles += 1;
    }
  }
  return checkedFiles;
}

export function scanFilesForKnownSecrets(roots, secretValues) {
  const secrets = secretValues.map((value) => Buffer.from(value));
  let checkedFiles = 0;
  for (const root of roots) {
    for (const file of filesUnder(root)) {
      const bytes = readFileSync(file);
      for (const secret of secrets) {
        if (secret.length > 0 && bytes.includes(secret)) {
          throw new Error(`known secret leaked into ${basename(file)}`);
        }
      }
      checkedFiles += 1;
    }
  }
  return checkedFiles;
}
