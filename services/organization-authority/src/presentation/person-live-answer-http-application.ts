import type {
  PersonAnswerRequestV3, PersonAnswerResponseV8, PersonAskTimeContextV1, PersonAskProgressStepEventV3, PersonAskReceiptV3,
} from '@echo-brain/organization-api';

/** One Ask as the HTTP boundary hands it on, on the V3 request; the bearer and the cancellation signal stay in it. */
export interface PersonAnswerHttpInputV1 {
  readonly access_token: string;
  /** May carry the asker's previous turn (ADR-0047). */
  readonly request: PersonAnswerRequestV3;
  readonly time_context?: PersonAskTimeContextV1;
  /** The client asked for answer layout v1 (ADR-0045). */
  readonly answer_layout?: boolean;
  readonly signal?: AbortSignal;
}

/**
 * The Ask route, `/v7`: the V8 answer, which may read and cite live tickets and pages, ECHO's shared follow-ups
 * (ADR-0040), and the asker's projects, the people in their organization, their tools and their connected tools'
 * containers (research tool contract v1). The same Ask can stream its progress in Ask progress V3 (ADR-0039):
 * `on_start` once, after the request authenticated and validated and before any research, so a failure before it is the
 * JSON error and one after it travels in the stream; `on_progress` for each step event, in order. Without
 * `askWithProgress` the route serves JSON even to a client that asks to stream.
 */
export interface PersonAnswerV7HttpApplication {
  ask(input: PersonAnswerHttpInputV1): Promise<PersonAnswerResponseV8>;
  askWithProgress?(input: PersonAnswerHttpInputV1 & {
    readonly on_start: () => void;
    readonly on_progress: (event: PersonAskProgressStepEventV3) => void;
  }): Promise<{ readonly response: PersonAnswerResponseV8; readonly receipt: PersonAskReceiptV3 }>;
}
