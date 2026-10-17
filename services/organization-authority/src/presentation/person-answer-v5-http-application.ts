import type { PersonAskTimeContextV1, PersonAnswerRequestV3, PersonAnswerResponseV6, PersonAskProgressStepEventV1, PersonAskReceiptV1 } from '@echo-brain/organization-api';

/** Additive live-page Ask route. V3 and V4 response contracts remain unchanged. */
export interface PersonAnswerV5HttpApplication {
  ask(input: { readonly access_token: string; readonly request: PersonAnswerRequestV3; readonly time_context?: PersonAskTimeContextV1; readonly signal?: AbortSignal }): Promise<PersonAnswerResponseV6>;
  /**
   * The same Ask, streaming its progress (ADR-0039). `on_start` is called once,
   * after the request authenticated and validated and before any research, so
   * a failure before it is today's JSON error and one after it travels in the
   * stream. `on_progress` receives each step event in order. Without this
   * method the route serves JSON even to a client that asks to stream.
   */
  askWithProgress?(input: {
    readonly access_token: string;
    readonly request: PersonAnswerRequestV3;
    readonly time_context?: PersonAskTimeContextV1;
    readonly signal?: AbortSignal;
    readonly on_start: () => void;
    readonly on_progress: (event: PersonAskProgressStepEventV1) => void;
  }): Promise<{ readonly response: PersonAnswerResponseV6; readonly receipt: PersonAskReceiptV1 }>;
}
