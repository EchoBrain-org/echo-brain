import type {
  PersonAnswerRequestV3, PersonAnswerResponseV5, PersonAnswerResponseV6, PersonAnswerResponseV7, PersonAnswerResponseV8, PersonAskTimeContextV1,
  PersonAskProgressStepEventV2, PersonAskProgressStepEventV3, PersonAskReceiptV2, PersonAskReceiptV3,
} from '@echo-brain/organization-api';

/** One Ask as the HTTP boundary hands it on, on the unchanged V3 request; the bearer and the cancellation signal stay in it. */
export interface PersonAnswerHttpInputV1 {
  readonly access_token: string;
  readonly request: PersonAnswerRequestV3;
  readonly time_context?: PersonAskTimeContextV1;
  readonly signal?: AbortSignal;
}

/**
 * A live Ask route: each version answers in its own response, and the older
 * routes and their answers stay as they are for installed clients. From `/v6`
 * the same Ask can stream its progress (ADR-0039): `on_start` once, after the
 * request authenticated and validated and before any research, so a failure
 * before it is the JSON error and one after it travels in the stream;
 * `on_progress` for each step event, in order. Without `askWithProgress` the
 * route serves JSON even to a client that asks to stream.
 */
export interface PersonLiveAnswerHttpApplication<Response, Step = never, Receipt = never> {
  ask(input: PersonAnswerHttpInputV1): Promise<Response>;
  askWithProgress?(input: PersonAnswerHttpInputV1 & {
    readonly on_start: () => void;
    readonly on_progress: (event: Step) => void;
  }): Promise<{ readonly response: Response; readonly receipt: Receipt }>;
}

/** `/v4`: the ticket-capable V5 answer; it never streams. */
export type PersonAnswerV4HttpApplication = Pick<PersonLiveAnswerHttpApplication<PersonAnswerResponseV5>, 'ask'>;
/** `/v5`: the live-page V6 answer. It no longer streams: its Ask progress V1 was retired on 2026-10-19. */
export type PersonAnswerV5HttpApplication = Pick<PersonLiveAnswerHttpApplication<PersonAnswerResponseV6>, 'ask'>;
/** `/v6`: the V7 answer, which may read and cite follow-ups (ADR-0040), streamed in Ask progress V2, whose steps may name one. */
export type PersonAnswerV6HttpApplication = PersonLiveAnswerHttpApplication<PersonAnswerResponseV7, PersonAskProgressStepEventV2, PersonAskReceiptV2>;
/**
 * `/v7`: the V8 answer, which may also read and cite the asker's projects, the people in their organization, their
 * tools and their connected tools' containers (research tool contract v1), streamed in Ask progress V3, whose steps may
 * name a workspace item or a tool container.
 */
export type PersonAnswerV7HttpApplication = PersonLiveAnswerHttpApplication<PersonAnswerResponseV8, PersonAskProgressStepEventV3, PersonAskReceiptV3>;
