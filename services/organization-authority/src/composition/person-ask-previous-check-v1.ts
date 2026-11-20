import {
  PERSON_ASK_CHECK_CITATION_KINDS_V1,
  PERSON_ASK_CHECK_REQUEST_KIND_V1,
  validatePersonAskCheckRequestV1,
  type PersonAnswerCitationV8,
  type PersonAnswerPreviousV1,
  type PersonAskCheckItemV1,
} from '@echo-brain/organization-api';
import type { PersonAskCheckHttpApplicationV1 } from '../presentation/person-ask-check-http-application.js';

/**
 * The previous turn an Ask carries (ADR-0047), as the Authority lets its model read it: only the sentences whose every
 * citation the caller can read at request time. The client's own check is a convenience; access can change between it and
 * the send, and a retry can send a turn built long before, so the Authority decides.
 *
 * Each citation goes through the Ask source check (`ask.check`), with its per-kind readability rules, for the caller, at
 * once. A sentence stays only when every citation it rests on answered `same`: one `unreadable`, `unknown`, of a kind the
 * check does not read (a person, a tool, a tool container), or with no answer at all, leaves the sentence out, and a
 * citation no sentence that stays rests on leaves with it (its label included). The kept citations are renumbered in the
 * order first cited. The question is the person's own words and stays, as do the purpose and when it was asked. Without a
 * check (`check` undefined), nothing is known readable, so only the question goes.
 */
export async function readablePreviousV1(previous: PersonAnswerPreviousV1, input: {
  readonly access_token: string;
  readonly check: Pick<PersonAskCheckHttpApplicationV1, 'check'> | undefined;
  readonly signal?: AbortSignal;
}): Promise<PersonAnswerPreviousV1> {
  const checkable = previous.citations.flatMap((cited, at) =>
    (PERSON_ASK_CHECK_CITATION_KINDS_V1 as readonly string[]).includes(cited.citation.kind) ? [at] : []);
  const states = new Map<number, PersonAskCheckItemV1['state']>();
  if (input.check !== undefined && checkable.length > 0) {
    const request = validatePersonAskCheckRequestV1({ schema_version: 1, kind: PERSON_ASK_CHECK_REQUEST_KIND_V1,
      items: checkable.map(at => ({ asked_at: previous.asked_at, citation: previous.citations[at]!.citation })) });
    const answered = await input.check.check({ access_token: input.access_token, request, ...(input.signal === undefined ? {} : { signal: input.signal }) });
    checkable.forEach((at, place) => { const state = answered.items[place]?.state; if (state !== undefined) states.set(at, state); });
  }
  const readable = (at: number) => states.get(at) === 'same';
  const kept = previous.statements.filter(statement => statement.citation_indexes.every(readable));
  const order: number[] = [];
  const statements = kept.map(statement => Object.freeze({
    text: statement.text,
    citation_indexes: Object.freeze(statement.citation_indexes.map(at => {
      if (!order.includes(at)) order.push(at);
      return order.indexOf(at);
    })),
  }));
  const citations: PersonAnswerCitationV8[] = order.map(at => previous.citations[at]!);
  return Object.freeze({ ...previous, statements: Object.freeze(statements), citations: Object.freeze(citations) });
}
