import { chmodSync, lstatSync, mkdtempSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FileOrganizationSecretStore } from "../src/security/file-secret-store.js";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function store(): { secrets: FileOrganizationSecretStore; directory: string } {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "echo-file-secret-store-")));
  directories.push(root);
  const directory = join(root, "secrets");
  return { secrets: new FileOrganizationSecretStore(directory), directory };
}

describe("file organization secret store replace", () => {
  it("replaces the bytes under the same handle, keeping a private file and leaving no temporary file", () => {
    const { secrets, directory } = store();
    const reference = secrets.create("first-secret-value");
    const before = readdirSync(directory);

    secrets.replace(reference, "second-secret-value");

    expect(secrets.read(reference)).toBe("second-secret-value");
    expect(secrets.listReferences()).toEqual([reference]);
    expect(readdirSync(directory)).toEqual(before);
    expect(lstatSync(join(directory, `${reference.secret_handle_id}.secret`)).mode & 0o777).toBe(0o600);
  });

  it("refuses a missing target, a symlinked target and an invalid secret without creating anything", () => {
    const { secrets, directory } = store();
    const missing = { secret_backend_id: "authority-file-v1" as const, secret_handle_id: "sch_00000000-0000-4000-8000-000000000001" };
    expect(() => secrets.replace(missing, "second-secret-value")).toThrow(/ENOENT/);
    expect(readdirSync(directory)).toEqual([]);

    const reference = secrets.create("first-secret-value");
    const path = join(directory, `${reference.secret_handle_id}.secret`);
    const elsewhere = join(directory, "..", "elsewhere.secret");
    writeFileSync(elsewhere, "outside-secret-value", { mode: 0o600 });
    rmSync(path);
    symlinkSync(elsewhere, path);
    expect(() => secrets.replace(reference, "second-secret-value")).toThrow("organization integration secret must be a bounded current-user 0600 canonical file");
    expect(lstatSync(path).isSymbolicLink()).toBe(true);

    rmSync(path);
    writeFileSync(path, "first-secret-value", { mode: 0o600 });
    chmodSync(path, 0o600);
    for (const invalid of ["", " padded ", "nul\0byte"]) {
      expect(() => secrets.replace(reference, invalid)).toThrow("organization integration secret is invalid");
    }
    expect(secrets.read(reference)).toBe("first-secret-value");
    expect(readdirSync(directory)).toEqual([`${reference.secret_handle_id}.secret`]);
  });

  it("never lists a temporary file, and removes one a crash left behind on the next replace", () => {
    const { secrets, directory } = store();
    const reference = secrets.create("first-secret-value");
    const leftover = join(directory, `${reference.secret_handle_id}.secret.replace`);
    writeFileSync(leftover, "crashed-secret-value", { mode: 0o600 });
    expect(secrets.listReferences()).toEqual([reference]);

    secrets.replace(reference, "second-secret-value");

    expect(readdirSync(directory)).toEqual([`${reference.secret_handle_id}.secret`]);
    expect(secrets.read(reference)).toBe("second-secret-value");
  });
});
