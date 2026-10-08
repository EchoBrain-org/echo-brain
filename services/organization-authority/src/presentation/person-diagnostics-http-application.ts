import type {
  PersonDiagnosticPrepareRequestV1,
  PersonDiagnosticPrepareResponseV1,
  PersonDiagnosticReadRequestV1,
  PersonDiagnosticReadResponseV1,
} from '@echo-brain/organization-api';

/** Private self-capture selection and release; neither operation starts research. */
export interface PersonDiagnosticsHttpApplicationV1 {
  prepare(input: { readonly access_token: string; readonly request: PersonDiagnosticPrepareRequestV1; readonly signal?: AbortSignal }): Promise<PersonDiagnosticPrepareResponseV1>;
  read(input: { readonly access_token: string; readonly request: PersonDiagnosticReadRequestV1; readonly signal?: AbortSignal }): Promise<PersonDiagnosticReadResponseV1>;
  close(): void;
}
