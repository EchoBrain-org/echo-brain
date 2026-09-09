/**
 * Bridge to the real readable-search analyzer.
 *
 * Unlike tools/evals/authority-core (whose oracle must stay independent of the
 * candidate), this quality benchmark deliberately imports the shipped analyzer
 * so tokenization, decision-family expansion and tie-break order are exactly
 * what Layer 3 uses. Build the workspaces first: `npm run build:workspaces`.
 */
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const analyzerPath = resolve(
  here,
  "../../../packages/organization-retrieval/dist/application/analyzer.js",
);

let analyzerModule;
export async function loadAnalyzer() {
  if (analyzerModule === undefined) {
    try {
      analyzerModule = await import(analyzerPath);
    } catch (error) {
      throw new Error(
        `cannot load built analyzer at ${analyzerPath}; run npm run build:workspaces first (${error instanceof Error ? error.message : String(error)})`,
      );
    }
  }
  return analyzerModule;
}

/** Returns the package's own SHA-256 as seen by the composition contract, when exposed. */
export function analyzerSourcePath() {
  return resolve(here, "../../../packages/organization-retrieval/src/application/analyzer.ts");
}

export const require = createRequire(import.meta.url);
