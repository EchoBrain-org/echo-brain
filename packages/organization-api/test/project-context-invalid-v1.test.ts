import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import {
  validatePersonUpdateSubmitV2,
  validateProjectContextBrowseV1,
  validateProjectContextSearchV1,
  validateProjectContextSearchResultV2,
  validateProjectCreateV1,
  validateProjectMemberSetV1,
} from '../src/index.js';

/** The project context contract fixture's inputs that the public codecs must reject before any mutation. */
const { cases } = JSON.parse(readFileSync(new URL('../../../tests/fixtures/project-context-v1/invalid.json', import.meta.url), 'utf8')) as {
  cases: { id: string; validator: string; value: unknown }[];
};
const validators: Readonly<Record<string, (value: unknown) => unknown>> = {
  'person-update-v2-submit': validatePersonUpdateSubmitV2,
  'project-create': validateProjectCreateV1,
  'project-member-set': validateProjectMemberSetV1,
  'project-browse': validateProjectContextBrowseV1,
  'project-search': validateProjectContextSearchV1,
  'project-search-result-v2': validateProjectContextSearchResultV2,
};

it.each(cases)('$id is rejected by its public codec', testCase => {
  expect(validators[testCase.validator], testCase.id).toBeTypeOf('function');
  expect(() => validators[testCase.validator]!(testCase.value)).toThrow();
});
