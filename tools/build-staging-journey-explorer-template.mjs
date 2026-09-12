#!/usr/bin/env node

import { javascriptSourceAssemblyV1 } from './lib/source-assemblies.mjs';
import { build } from "esbuild";
import { readFileSync, writeFileSync } from "node:fs";
import { relative, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const deployment = resolve(root, "deploy", "organization-authority");
const templatePath = resolve(
  deployment,
  "authority-staging-journey-explorer-v1.template.json",
);
const assembly = javascriptSourceAssemblyV1(JSON.parse(readFileSync(resolve(deployment, 'journey-explorer-assembly.v1.json'), 'utf8')));
const inlineTemplateLimit = 51_200;
const arguments_ = process.argv.slice(2);
const check = arguments_.includes("--check");

if (arguments_.length > 0 && (!check || arguments_.length !== 1)) {
  throw new Error("usage: build-staging-journey-explorer-template.mjs [--check]");
}

// Keep the checked-in handler readable for review. CloudFormation transports
// only the generated inline artifact, where identifier minification keeps the
// fixed 51,200-byte TemplateBody below its API limit.
const emitted = await build({
  absWorkingDir: root,
  entryPoints: [assembly.entrypoint],
  bundle: true,
  write: false,
  metafile: true,
  platform: "node",
  external: ["@aws-sdk/client-cloudwatch-logs"],
  format: "cjs",
  legalComments: "none",
  minifyIdentifiers: true,
  minifySyntax: true,
  minifyWhitespace: true,
  target: "node24",
});
const actualInputs = Object.keys(emitted.metafile.inputs).map(path => relative(root, resolve(root, path))).sort();
const expectedInputs = [assembly.entrypoint, ...assembly.neutral_sources, ...assembly.provider_assets].sort();
if (JSON.stringify(actualInputs) !== JSON.stringify(expectedInputs)) throw new Error('Explorer assembly does not match bundled inputs');
const template = JSON.parse(readFileSync(templatePath, "utf8"));
const code = template?.Resources?.CustomWidgetJourneyExplorer?.Properties?.Code;

if (!code || typeof code !== "object" || Array.isArray(code)) {
  throw new Error("Journey Explorer Lambda inline code is missing");
}

// The checked-in template is an inline CloudFormation body. Compact its JSON
// separately from the readable handler so Code.ZipFile and template transport
// whitespace do not consume the 51,200-byte API limit.
template.Resources.CustomWidgetJourneyExplorer.Properties.Code = {
  ZipFile: emitted.outputFiles[0].text,
};
const generated = `${JSON.stringify(template)}\n`;

if (Buffer.byteLength(generated) >= inlineTemplateLimit) {
  throw new Error(
    `Journey Explorer template is ${String(Buffer.byteLength(generated))} bytes; it must stay below ${String(inlineTemplateLimit)}`,
  );
}

if (check) {
  if (readFileSync(templatePath, "utf8") !== generated) {
    throw new Error(
      "Journey Explorer template is stale; run npm run build:staging-journey-explorer-template",
    );
  }
} else {
  writeFileSync(templatePath, generated);
}
