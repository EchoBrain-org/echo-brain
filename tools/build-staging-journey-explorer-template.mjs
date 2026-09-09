#!/usr/bin/env node

import { transform } from "esbuild";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const deployment = resolve(root, "deploy", "organization-authority");
const templatePath = resolve(
  deployment,
  "authority-staging-journey-explorer-v1.template.json",
);
const handlerPath = resolve(
  deployment,
  "staging-journey-explorer-handler-v1.cjs",
);
const inlineTemplateLimit = 51_200;
const arguments_ = process.argv.slice(2);
const check = arguments_.includes("--check");

if (arguments_.length > 0 && (!check || arguments_.length !== 1)) {
  throw new Error("usage: build-staging-journey-explorer-template.mjs [--check]");
}

const source = readFileSync(handlerPath, "utf8");
// Keep the checked-in handler readable for review. CloudFormation transports
// only the generated inline artifact, where identifier minification keeps the
// fixed 51,200-byte TemplateBody below its API limit.
const emitted = await transform(source, {
  format: "cjs",
  legalComments: "none",
  minifyIdentifiers: true,
  minifySyntax: true,
  minifyWhitespace: true,
  target: "node24",
});
const template = JSON.parse(readFileSync(templatePath, "utf8"));
const code = template?.Resources?.CustomWidgetJourneyExplorer?.Properties?.Code;

if (!code || typeof code !== "object" || Array.isArray(code)) {
  throw new Error("Journey Explorer Lambda inline code is missing");
}

// The checked-in template is an inline CloudFormation body. Compact its JSON
// separately from the readable handler so Code.ZipFile and template transport
// whitespace do not consume the 51,200-byte API limit.
template.Resources.CustomWidgetJourneyExplorer.Properties.Code = {
  ZipFile: emitted.code,
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
