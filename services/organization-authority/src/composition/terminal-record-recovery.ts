import { canonicalJson } from '@echo-brain/federation-protocol';
import {
  readAuthorityProcessingSourceStoredBinding,
  type AuthorityProcessingSourceStoredBinding,
} from '../adapters/persistence/sqlite/processing-source-runtime-binding.js';
import {
  SqliteAuthorityProcessingStore,
  type AuthorityTerminalRecordAct,
} from '../processing/storage/sqlite-authority-processing-store.js';
import type {
  ComposeServerInstallationRecordWriterOptions,
} from './server-installation-record-writer.js';
import { composeServerInstallationRecordWriter } from './server-installation-record-writer.js';

const STARTUP_TERMINAL_RECORD_RECOVERY_LIMIT = 100;

export type RecoverAuthorityTerminalRecordActsOptions =
  ComposeServerInstallationRecordWriterOptions;

export interface AuthorityTerminalRecordRecoveryResult {
  readonly source_binding: 'absent' | 'active' | 'inactive';
  readonly recovered_processing_keys: readonly string[];
}

export interface TerminalRecordRecoveryStore {
  initializeTerminalRecordRecovery(): Promise<void>;
  listTerminalRecordRecoveryPage(input?: {
    readonly limit?: number;
    readonly after?: {
      readonly resolved_at: string;
      readonly processing_key: string;
    };
  }): readonly {
    readonly resolved_at: string;
    readonly processing_key: string;
  }[];
  readTerminalRecordAct(processingKey: string): AuthorityTerminalRecordAct | null;
}

export interface TerminalRecordActWriter {
  write(input: {
    readonly processing_key: string;
    readonly meeting: AuthorityTerminalRecordAct['candidate']['meeting'];
    readonly decisions: NonNullable<
      AuthorityTerminalRecordAct['candidate']['first_decision']
    >;
    readonly decision: AuthorityTerminalRecordAct['decision'];
  }): Promise<void>;
}

export type TerminalRecordWriterFactory<
  TStore extends TerminalRecordRecoveryStore = SqliteAuthorityProcessingStore,
> = (store: TStore) => TerminalRecordActWriter;

function assertRecoveryAct(
  processingKey: string,
  act: AuthorityTerminalRecordAct | null,
): asserts act is AuthorityTerminalRecordAct & {
  readonly candidate: AuthorityTerminalRecordAct['candidate'] & {
    readonly first_decision: NonNullable<
      AuthorityTerminalRecordAct['candidate']['first_decision']
    >;
    readonly first_request: NonNullable<
      AuthorityTerminalRecordAct['candidate']['first_request']
    >;
  };
} {
  if (
    act === null ||
    act.candidate.processing_key !== processingKey ||
    act.candidate.first_decision === null ||
    act.candidate.first_request === null ||
    act.candidate.first_request.processing_key !== processingKey ||
    canonicalJson(act.candidate.first_request.meeting) !==
      canonicalJson(act.candidate.meeting) ||
    canonicalJson(act.candidate.first_request.decisions) !==
      canonicalJson(act.candidate.first_decision)
  ) {
    throw new Error(
      'authority terminal record recovery act does not match its frozen candidate',
    );
  }
}

/**
 * Runs one bounded, provider-free pass. It never marks a candidate processed
 * and never delivers: normal Record idempotency is the append receipt.
 */
export async function recoverTerminalRecordActsFromStore<
  TStore extends TerminalRecordRecoveryStore,
>(
  store: TStore,
  createWriter: TerminalRecordWriterFactory<TStore>,
): Promise<readonly string[]> {
  await store.initializeTerminalRecordRecovery();
  const recovered: string[] = [];
  let after:
    | { readonly resolved_at: string; readonly processing_key: string }
    | undefined;
  let writer: TerminalRecordActWriter | undefined;
  for (;;) {
    const page = store.listTerminalRecordRecoveryPage({
      limit: STARTUP_TERMINAL_RECORD_RECOVERY_LIMIT,
      ...(after === undefined ? {} : { after }),
    });
    if (page.length === 0) break;
    writer ??= createWriter(store);
    for (const entry of page) {
      const act = store.readTerminalRecordAct(entry.processing_key);
      assertRecoveryAct(entry.processing_key, act);
      await writer.write({
        processing_key: entry.processing_key,
        meeting: act.candidate.meeting,
        decisions: act.candidate.first_decision,
        decision: act.decision,
      });
      recovered.push(entry.processing_key);
    }
    after = page.at(-1)!;
    if (page.length < STARTUP_TERMINAL_RECORD_RECOVERY_LIMIT) break;
  }
  return Object.freeze(recovered);
}

function processingStore(
  options: RecoverAuthorityTerminalRecordActsOptions,
  binding: AuthorityProcessingSourceStoredBinding,
): SqliteAuthorityProcessingStore {
  return new SqliteAuthorityProcessingStore(
    options.config.database_path,
    {
      organization_id: binding.organization_id,
      principal_id: binding.principal_id,
      membership_id: binding.membership_id,
      membership_type: binding.membership_type,
      source_adapter_id: binding.source_adapter_id,
      source_instance_id: binding.source_instance_id,
    },
    {
      bindingMode: 'require-existing',
      sourceConfiguration: {
        owner_email_sha256: binding.owner_email_sha256,
        credential_scope: binding.credential_scope,
        credential_reference_sha256: binding.credential_reference_sha256,
      },
      fileMustExist: true,
    },
  );
}

/**
 * Authority-startup recovery for human acts already durably resolved before a
 * crash. Normal polling is composed separately and remains active-custody-only.
 */
export async function recoverAuthorityTerminalRecordActs(
  options: RecoverAuthorityTerminalRecordActsOptions,
): Promise<AuthorityTerminalRecordRecoveryResult> {
  const binding = readAuthorityProcessingSourceStoredBinding(
    options.config.database_path,
    options.config.organization_id,
  );
  if (binding === null) {
    return Object.freeze({
      source_binding: 'absent',
      recovered_processing_keys: Object.freeze([]),
    });
  }

  const store = processingStore(options, binding);
  try {
    const recovered = await recoverTerminalRecordActsFromStore(
      store,
      (recoveryStore) =>
        composeServerInstallationRecordWriter(options).createResolvedActWriter(
          recoveryStore,
        ),
    );
    return Object.freeze({
      source_binding: binding.custody_status,
      recovered_processing_keys: recovered,
    });
  } finally {
    store.close();
  }
}
