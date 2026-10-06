import type {
  PersonResearchEvalReadRequestV1,
  PersonResearchEvalReadResponseV1,
  PersonResearchEvalStartReceiptV1,
  PersonResearchEvalStartRequestV1,
} from '@echo-brain/organization-api';

/** Staging-only research evaluation (research loop evaluation v1). */
export interface PersonResearchEvalHttpApplicationV1 {
  start(input: { readonly access_token: string; readonly request: PersonResearchEvalStartRequestV1; readonly signal?: AbortSignal }): Promise<PersonResearchEvalStartReceiptV1>;
  read(input: { readonly access_token: string; readonly request: PersonResearchEvalReadRequestV1; readonly signal?: AbortSignal }): Promise<PersonResearchEvalReadResponseV1>;
  /** Stops running research when the Authority shuts down. */
  close(): void;
}
