#!/usr/bin/env node
/**
 * Produces a per-operator copy of the four synthetic meeting fixtures.
 * This intentionally has no dependency on the demo expectations oracle.
 */
import {
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const OWNER_PLACEHOLDER = "owner@example.test";
const EXPECTED_FILENAMES = [
  "01-revenue-signal-calibration.json",
  "02-data-handling-review.json",
  "03-implementation-capacity-triage.json",
  "04-commercial-exception-review.json",
];

function fail(message) {
  throw new Error(`fixture preparation failed: ${message}`);
}

function validateOwnerEmail(ownerEmail) {
  if (
    typeof ownerEmail !== "string" ||
    ownerEmail !== ownerEmail.trim() ||
    ownerEmail !== ownerEmail.toLowerCase()
  ) {
    fail("owner email must be lowercase without surrounding whitespace");
  }
  if (
    !/^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/.test(
      ownerEmail,
    )
  ) {
    fail("owner email is invalid");
  }
}

function replaceOwner(value, ownerEmail) {
  if (typeof value === "string") {
    const count = value.split(OWNER_PLACEHOLDER).length - 1;
    return {
      value:
        count === 0 ? value : value.replaceAll(OWNER_PLACEHOLDER, ownerEmail),
      replacements: count,
    };
  }
  if (Array.isArray(value)) {
    let replacements = 0;
    const items = value.map((item) => {
      const result = replaceOwner(item, ownerEmail);
      replacements += result.replacements;
      return result.value;
    });
    return { value: items, replacements };
  }
  if (value !== null && typeof value === "object") {
    let replacements = 0;
    const object = {};
    for (const [key, item] of Object.entries(value)) {
      const result = replaceOwner(item, ownerEmail);
      replacements += result.replacements;
      object[key] = result.value;
    }
    return { value: object, replacements };
  }
  return { value, replacements: 0 };
}

function checkedDirectory(path, description) {
  let stat;
  try {
    stat = lstatSync(path);
  } catch {
    fail(`${description} directory does not exist`);
  }
  if (stat.isSymbolicLink() || !stat.isDirectory())
    fail(`${description} path must be a real directory`);
}

function exactNames(directory, description) {
  const names = readdirSync(directory).sort();
  if (
    JSON.stringify(names) !== JSON.stringify([...EXPECTED_FILENAMES].sort())
  ) {
    fail(`${description} must contain exactly the four expected meeting files`);
  }
  return names;
}

export function prepareFixtures({
  sourceDirectory,
  outputDirectory,
  ownerEmail,
}) {
  validateOwnerEmail(ownerEmail);
  const source = resolve(sourceDirectory);
  const output = resolve(outputDirectory);
  if (source === output) fail("source and output directories must differ");
  checkedDirectory(source, "source");

  const documents = exactNames(source, "source").map((name) => {
    const path = resolve(source, name);
    const stat = lstatSync(path);
    if (stat.isSymbolicLink() || !stat.isFile())
      fail(`source file ${name} must be a real file`);
    let parsed;
    try {
      parsed = JSON.parse(readFileSync(path, "utf8"));
    } catch {
      fail(`source file ${name} is not valid JSON`);
    }
    const result = replaceOwner(parsed, ownerEmail);
    if (
      result.replacements === 0 ||
      JSON.stringify(result.value).includes(OWNER_PLACEHOLDER)
    ) {
      fail(`source file ${name} does not replace every owner placeholder`);
    }
    return { name, document: result.value };
  });

  try {
    const outputStat = lstatSync(output);
    if (outputStat.isSymbolicLink() || !outputStat.isDirectory())
      fail("output path must be a real directory");
    if (readdirSync(output).length !== 0)
      fail("output directory must be new or empty");
  } catch (error) {
    if (
      error instanceof Error &&
      error.message.startsWith("fixture preparation failed:")
    )
      throw error;
    mkdirSync(output, { mode: 0o700 });
  }

  for (const { name, document } of documents) {
    writeFileSync(
      resolve(output, name),
      `${JSON.stringify(document, null, 2)}\n`,
      {
        encoding: "utf8",
        flag: "wx",
        mode: 0o600,
      },
    );
  }
  exactNames(output, "output");
  for (const name of EXPECTED_FILENAMES) {
    const stat = lstatSync(resolve(output, name));
    if (stat.isSymbolicLink() || !stat.isFile())
      fail(`output file ${name} is not a real file`);
  }
  return { outputDirectory: output, filenames: [...EXPECTED_FILENAMES] };
}

function parseArguments(argumentsList) {
  if (
    argumentsList.length !== 6 ||
    argumentsList[0] !== "--source" ||
    argumentsList[2] !== "--output" ||
    argumentsList[4] !== "--owner"
  ) {
    fail(
      "usage: prepare-fixtures.mjs --source <meetings-dir> --output <empty-dir> --owner <lowercase-email>",
    );
  }
  return {
    sourceDirectory: argumentsList[1],
    outputDirectory: argumentsList[3],
    ownerEmail: argumentsList[5],
  };
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const result = prepareFixtures(parseArguments(process.argv.slice(2)));
  process.stdout.write(`${JSON.stringify(result)}\n`);
}
