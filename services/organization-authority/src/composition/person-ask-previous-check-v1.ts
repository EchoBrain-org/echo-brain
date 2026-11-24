import {
  PERSON_ASK_CHECK_CITATION_KINDS_V1,
  PERSON_ASK_CHECK_REQUEST_KIND_V1,
  validatePersonAskCheckRequestV1,
  type PersonAnswerCitationV8,
  type PersonAnswerEarlierTurnV1,
  type PersonAnswerPreviousV1,
  type PersonAskCheckItemV1,
} from '@echo-brain/organization-api';
import type { PersonAskCheckHttpApplicationV1 } from '../presentation/person-ask-check-http-application.js';

/**
 * The previous turn and its thread's older turns (ADR-0047, ADR-0056) as the Authority lets its model read them (R6):
 * the client's check is a convenience, since access can change before the send and a retry can resend an old turn.
 * One check of every citation, each at its own turn's time; a sentence stays only if it rests on citations all found
 * `same`, and only the kept citations stay, renumbered. Questions always stay; with no check, only they go.
 */
export async function readablePreviousV1(previous: PersonAnswerPreviousV1, input: {
  readonly access_token: string;
  readonly check: Pick<PersonAskCheckHttpApplicationV1, 'check'> | undefined;
  readonly signal?: AbortSignal;
}): Promise<PersonAnswerPreviousV1> {
  const turns: readonly PersonAnswerEarlierTurnV1[] = [...(previous.earlier ?? []), previous];
  const checkable = turns.flatMap((turn, of) => turn.citations.flatMap((cited, at) =>
    (PERSON_ASK_CHECK_CITATION_KINDS_V1 as readonly string[]).includes(cited.citation.kind) ? [{ of, at, asked_at: turn.asked_at, citation: cited.citation }] : []));
  const states = turns.map(() => new Map<number, PersonAskCheckItemV1['state']>());
  if (input.check !== undefined && checkable.length > 0) {
    const request = validatePersonAskCheckRequestV1({ schema_version: 1, kind: PERSON_ASK_CHECK_REQUEST_KIND_V1,
      items: checkable.map(({ asked_at, citation }) => ({ asked_at, citation })) });
    const answered = await input.check.check({ access_token: input.access_token, request, ...(input.signal === undefined ? {} : { signal: input.signal }) });
    checkable.forEach(({ of, at }, place) => { const state = answered.items[place]?.state; if (state !== undefined) states[of]!.set(at, state); });
  }
  const readable = (turn: PersonAnswerEarlierTurnV1, of: number) => {
    // A sentence that rests on no citation has nothing a check could vouch for, so it is never known readable.
    const kept = turn.statements.filter(statement => statement.citation_indexes.length > 0 && statement.citation_indexes.every(at => states[of]!.get(at) === 'same'));
    const order: number[] = [];
    const statements = kept.map(statement => Object.freeze({
      text: statement.text,
      citation_indexes: Object.freeze(statement.citation_indexes.map(at => {
        if (!order.includes(at)) order.push(at);
        return order.indexOf(at);
      })),
    }));
    const citations: PersonAnswerCitationV8[] = order.map(at => turn.citations[at]!);
    return { statements: Object.freeze(statements), citations: Object.freeze(citations) };
  };
  const last = turns.length - 1;
  return Object.freeze({
    ...previous, ...readable(previous, last),
    ...(previous.earlier === undefined ? {} : { earlier: Object.freeze(previous.earlier.map((turn, of) => Object.freeze({ ...turn, ...readable(turn, of) }))) }),
  });
}
