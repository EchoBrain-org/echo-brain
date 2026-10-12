import { readFileSync } from "node:fs";
import { expect } from "vitest";

export type CloudFormationResource = {
  readonly Type: string;
  readonly Condition?: string;
  readonly DependsOn?: string | string[];
  readonly DeletionPolicy?: string;
  readonly UpdateReplacePolicy?: string;
  readonly CreationPolicy?: Record<string, unknown>;
  readonly Properties: Record<string, unknown>;
};

/** The template sections the stack tests read; the JSON cast is unchecked. */
export type CloudFormationTemplate = {
  readonly Description: string;
  readonly Parameters: Record<string, Record<string, unknown>>;
  readonly Conditions: Record<string, unknown>;
  readonly Rules: Record<string, unknown>;
  readonly Resources: Record<string, CloudFormationResource>;
  readonly Outputs: Record<string, Record<string, unknown>>;
};

export function readTemplate(path: string): CloudFormationTemplate {
  return JSON.parse(readFileSync(path, "utf8")) as CloudFormationTemplate;
}

export function resource(
  stack: CloudFormationTemplate,
  logicalId: string,
): CloudFormationResource {
  const value = stack.Resources[logicalId];
  expect(value, `missing ${logicalId}`).toBeDefined();
  return value!;
}
