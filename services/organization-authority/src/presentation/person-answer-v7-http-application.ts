import type { PersonAskTimeContextV1, PersonAnswerRequestV3, PersonAnswerResponseV8, PersonAskProgressStepEventV3, PersonAskReceiptV3 } from '@echo-brain/organization-api';

/**
 * `POST /v7/person/ask`: the V8 answer, which may read and cite the asker's
 * projects, the people in their organization, their tools and their connected
 * tools' containers (research tool contract v1), on the unchanged V3 request.
 * The `/v3` to `/v6` routes and their answers stay as they are for installed
 * clients.
 */
export interface PersonAnswerV7HttpApplication {
  ask(input: { readonly access_token: string; readonly request: PersonAnswerRequestV3; readonly time_context?: PersonAskTimeContextV1; readonly signal?: AbortSignal }): Promise<PersonAnswerResponseV8>;
  /**
   * The same Ask, streaming its progress in Ask progress V3, exactly as `/v6`
   * streams V2: `on_start` once, after the request authenticated and validated
   * and before any research; `on_progress` for each step event, which may name
   * a workspace item or a tool container. Without this method the route serves
   * JSON.
   */
  askWithProgress?(input: {
    readonly access_token: string;
    readonly request: PersonAnswerRequestV3;
    readonly time_context?: PersonAskTimeContextV1;
    readonly signal?: AbortSignal;
    readonly on_start: () => void;
    readonly on_progress: (event: PersonAskProgressStepEventV3) => void;
  }): Promise<{ readonly response: PersonAnswerResponseV8; readonly receipt: PersonAskReceiptV3 }>;
}
