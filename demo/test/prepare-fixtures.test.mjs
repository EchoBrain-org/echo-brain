import assert from "node:assert/strict";
import {
  cpSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { prepareFixtures } from "../staging/prepare-fixtures.mjs";

const demo = resolve(import.meta.dirname, "..");
const canonicalNames = [
  "01-revenue-signal-calibration.json",
  "02-data-handling-review.json",
  "03-implementation-capacity-triage.json",
  "04-commercial-exception-review.json",
];

function temporaryDirectory() {
  return mkdtempSync(resolve(tmpdir(), "echo-demo-fixtures-"));
}

function copiedMeetings(root) {
  const source = resolve(root, "meetings");
  cpSync(resolve(demo, "meetings"), source, { recursive: true });
  return source;
}

test("personalizes exactly the four canonical fixtures into a new pretty JSON directory", () => {
  const root = temporaryDirectory();
  try {
    const output = resolve(root, "personalized");
    const result = prepareFixtures({
      sourceDirectory: copiedMeetings(root),
      outputDirectory: output,
      ownerEmail: "operator@example.test",
    });
    assert.deepEqual(result.filenames, canonicalNames);
    assert.deepEqual(readdirSync(output).sort(), canonicalNames);
    assert.equal(statSync(output).mode & 0o777, 0o700);
    for (const name of canonicalNames) {
      const text = readFileSync(resolve(output, name), "utf8");
      assert.equal(statSync(resolve(output, name)).mode & 0o777, 0o600);
      assert.equal(text.includes("owner@example.test"), false);
      assert.equal(text.includes("operator@example.test"), true);
      assert.equal(text.endsWith("\n"), true);
      assert.equal(typeof JSON.parse(text), "object");
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("fails closed for an invalid owner, malformed fixtures, unexpected names, symlinks, or a nonempty output", () => {
  const root = temporaryDirectory();
  try {
    const source = copiedMeetings(root);
    const output = resolve(root, "output");
    assert.throws(
      () =>
        prepareFixtures({
          sourceDirectory: source,
          outputDirectory: output,
          ownerEmail: "Owner@example.test",
        }),
      /lowercase/,
    );

    writeFileSync(resolve(source, "extra.json"), "{}");
    assert.throws(
      () =>
        prepareFixtures({
          sourceDirectory: source,
          outputDirectory: output,
          ownerEmail: "operator@example.test",
        }),
      /exactly/,
    );
    rmSync(resolve(source, "extra.json"));

    writeFileSync(resolve(source, canonicalNames[0]), "not json");
    assert.throws(
      () =>
        prepareFixtures({
          sourceDirectory: source,
          outputDirectory: output,
          ownerEmail: "operator@example.test",
        }),
      /valid JSON/,
    );
    cpSync(
      resolve(demo, "meetings", canonicalNames[0]),
      resolve(source, canonicalNames[0]),
    );

    rmSync(resolve(source, canonicalNames[1]));
    symlinkSync(
      resolve(demo, "meetings", canonicalNames[1]),
      resolve(source, canonicalNames[1]),
    );
    assert.throws(
      () =>
        prepareFixtures({
          sourceDirectory: source,
          outputDirectory: output,
          ownerEmail: "operator@example.test",
        }),
      /real file/,
    );
    assert.equal(
      lstatSync(resolve(source, canonicalNames[1])).isSymbolicLink(),
      true,
    );
    rmSync(resolve(source, canonicalNames[1]));
    cpSync(
      resolve(demo, "meetings", canonicalNames[1]),
      resolve(source, canonicalNames[1]),
    );

    mkdirSync(output);
    writeFileSync(resolve(output, "already-there"), "x");
    assert.throws(
      () =>
        prepareFixtures({
          sourceDirectory: source,
          outputDirectory: output,
          ownerEmail: "operator@example.test",
        }),
      /new or empty/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
