import type { PersonAskTimeContextV1, PersonAnswerRequestV3, PersonAnswerResponseV7, PersonAskProgressStepEventV2, PersonAskReceiptV2 } from '@echo-brain/organization-api';

/**
 * `POST /v6/person/ask`: the V7 answer, which may read and cite follow-ups
 * (ADR-0040), on the unchanged V3 request. The `/v3` to `/v5` routes and their
 * answers stay as they are for installed clients.
 */
export interface PersonAnswerV6HttpApplication {
  ask(input: { readonly access_token: string; readonly request: PersonAnswerRequestV3; readonly time_context?: PersonAskTimeContextV1; readonly signal?: AbortSignal }): Promise<PersonAnswerResponseV7>;
  /**
   * The same Ask, streaming its progress in Ask progress V2 (ADR-0039), exactly
   * as `/v5` streams V1: `on_start` once, after the request authenticated and
   * validated and before any research; `on_progress` for each step event, which
   * may name a follow-up. Without this method the route serves JSON.
   */
  askWithProgress?(input: {
    readonly access_token: string;
    readonly request: PersonAnswerRequestV3;
    readonly time_context?: PersonAskTimeContextV1;
    readonly signal?: AbortSignal;
    readonly on_start: () => void;
    readonly on_progress: (event: PersonAskProgressStepEventV2) => void;
  }): Promise<{ readonly response: PersonAnswerResponseV7; readonly receipt: PersonAskReceiptV2 }>;
}
