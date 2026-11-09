import { lstatSync } from 'node:fs';
import { readPrivateAuthorityCredentialFile } from '@echo-brain/organization-authority-kernel/adapters/security/private-file-credentials';
import type { CoreRuntimeObservationScopeV1 } from '@echo-brain/organization-authority-kernel/shared/core-runtime-observation-v1';
import { STAGING_AUTHORITY_ORIGIN_V1 } from '@echo-brain/organization-authority-kernel/composition/staging-authority-environment-v1';
import { createLangSmithObserverV1, LangSmithExportErrorV1, type LangSmithRunV1 } from './langsmith-observer-v1.js';

const ENDPOINTS = {
  us: 'https://api.smith.langchain.com', eu: 'https://eu.api.smith.langchain.com',
  apac: 'https://apac.api.smith.langchain.com', 'aws-us': 'https://aws.api.smith.langchain.com',
} as const;
const CONFIG_ERROR = 'LangSmith staging tracing configuration is invalid';
interface Config {
  project: string;
  region: keyof typeof ENDPOINTS;
  api_key: string;
  workspace_id?: string;
  expires_at: string | null;
}

/** No environment fallback: this private file is the complete, explicit export selection. */
export function readLangSmithConfigV1(path: string, authorityUrl: string, now = Date.now()): Config | undefined {
  try {
    try { lstatSync(path); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
    if (authorityUrl !== STAGING_AUTHORITY_ORIGIN_V1) throw new Error(CONFIG_ERROR);
    const value = JSON.parse(readPrivateAuthorityCredentialFile(`file:${path}`, 1)) as Config;
    if (value === null || typeof value !== 'object' || Array.isArray(value) ||
        Object.keys(value).some(key => !['project', 'region', 'api_key', 'workspace_id', 'expires_at'].includes(key)) ||
        typeof value.project !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._ -]{0,99}$/.test(value.project) ||
        typeof value.region !== 'string' || !Object.hasOwn(ENDPOINTS, value.region) || typeof value.api_key !== 'string' || !/^[\x21-\x7e]{16,2048}$/.test(value.api_key) ||
        (value.workspace_id !== undefined && (typeof value.workspace_id !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value.workspace_id))) ||
        (value.expires_at !== null && (typeof value.expires_at !== 'string' || !Number.isFinite(Date.parse(value.expires_at)) ||
        Date.parse(value.expires_at) > now + 24 * 60 * 60_000))) throw new Error(CONFIG_ERROR);
    if (value.expires_at !== null && Date.parse(value.expires_at) <= now) return undefined;
    return value;
  } catch { throw new Error(CONFIG_ERROR); }
}

/** The documented multipart ingestion API; bounded by the observer, with no SDK logging or disk fallback. */
export function createLangSmithSenderV1(config: Config, fetcher: typeof fetch = fetch) {
  return async (runs: LangSmithRunV1[], signal: AbortSignal): Promise<void> => {
    const body = new FormData();
    try {
      for (const run of runs) {
        const { inputs, outputs, events, ...rest } = run;
        for (const [suffix, value] of [['', rest], ['.inputs', inputs], ['.outputs', outputs], ['.events', events]] as const) {
          if (value === undefined) continue;
          const json = JSON.stringify(value);
          // Node FormData omits per-part Content-Length; LangSmith also accepts
          // this Content-Type parameter, measured in UTF-8 bytes, on every part.
          body.append(`post.${run.id}${suffix}`, new Blob([json], { type: `application/json; length=${Buffer.byteLength(json, 'utf8')}` }));
        }
      }
    } catch { throw new LangSmithExportErrorV1('serialization'); }
    const deadline = AbortSignal.timeout(5000);
    let response: Response;
    try {
      response = await fetcher(`${ENDPOINTS[config.region]}/runs/multipart`, {
        method: 'POST', body, redirect: 'error', signal: AbortSignal.any([signal, deadline]),
        headers: { 'x-api-key': config.api_key, ...(config.workspace_id === undefined ? {} : { 'x-tenant-id': config.workspace_id }) },
      });
    } catch {
      throw new LangSmithExportErrorV1(signal.aborted ? 'cancelled' : deadline.aborted ? 'timeout' : 'network');
    }
    // Never read or log a service response body. Disposal must not hide its HTTP status.
    try { await response.body?.cancel(); } catch { /* the response status remains authoritative */ }
    if (!response.ok) throw new LangSmithExportErrorV1('http', response.status);
  };
}

export function createLangSmithRuntimeV1(options: {
  path?: string; authority_url: string; release_sha: string;
  existing?: CoreRuntimeObservationScopeV1; write: (value: string) => void;
  vocabulary?: CoreRuntimeObservationScopeV1['vocabulary'];
}) {
  const config = options.path === undefined ? undefined : readLangSmithConfigV1(options.path, options.authority_url);
  if (config === undefined) return { scope: options.existing, start() {}, async close() {} };
  // Research runs and meeting extractions each have their own exporter (captures, upload queue and counts), so meeting
  // lanes never delay or drop a research trace.
  const exporterFor = (root: 'research_run' | 'extraction') => createLangSmithObserverV1({ project: config.project, release_sha: options.release_sha, root,
    ...(config.expires_at === null ? {} : { expires_at: Date.parse(config.expires_at) }), send: createLangSmithSenderV1(config) });
  const research = exporterFor('research_run'), meetings = exporterFor('extraction');
  const deliver = (action: (() => void | Promise<void>) | undefined) => {
    try { if (action !== undefined) void Promise.resolve(action()).catch(() => undefined); } catch { /* observation only */ }
  };
  const scope: CoreRuntimeObservationScopeV1 = { vocabulary: options.vocabulary, ...options.existing,
    observer(event) {
      deliver(() => research.scope.observer!(structuredClone(event)));
      deliver(() => meetings.scope.observer!(structuredClone(event)));
      deliver(options.existing?.observer === undefined ? undefined : () => options.existing!.observer!(event));
    },
    // An operation's payloads go to each exporter capturing it: one in practice, as research and meeting extraction never
    // share an operation.
    diagnostic_exporter(operation) {
      const recorders = [research, meetings].flatMap(exporter => exporter.scope.diagnostic_exporter!(operation) ?? []);
      return recorders.length < 2 ? recorders[0] : event => { for (const record of recorders) void record(event); };
    },
  };
  let timer: ReturnType<typeof setInterval> | undefined;
  let last = '';
  const report = () => {
    // Research's counts stay top level, where the release preflight reads them; meeting extraction's are reported apart.
    const status = { kind: 'echo-langsmith-tracing-status-v1', enabled: config.expires_at === null || Date.now() < Date.parse(config.expires_at),
      ...research.status(), meeting_extraction: meetings.status() };
    const line = JSON.stringify(status);
    if (line !== last) { last = line; deliver(() => options.write(`${line}\n`)); }
  };
  return { scope, start() { report(); timer ??= setInterval(report, 60_000); timer.unref(); },
    async close() { clearInterval(timer); await Promise.all([research.close(), meetings.close()]); report(); } };
}
