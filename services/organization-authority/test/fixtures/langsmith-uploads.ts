import type { LangSmithRunV1 } from '../../src/composition/observability/langsmith-observer-v1.js';

/** The runs one multipart LangSmith upload carried, root first, rebuilt from their parts. */
export async function uploadedRuns(form: FormData): Promise<LangSmithRunV1[]> {
  const runs = new Map<string, Record<string, unknown>>();
  for (const [name, value] of form.entries()) {
    const [, id, part] = /^post\.([^.]+)(?:\.(\w+))?$/u.exec(name)!;
    const json = JSON.parse(await (value as Blob).text()) as Record<string, unknown>;
    runs.set(id!, { ...runs.get(id!), ...(part === undefined ? json : { [part]: json }) });
  }
  return [...runs.values()] as unknown as LangSmithRunV1[];
}
