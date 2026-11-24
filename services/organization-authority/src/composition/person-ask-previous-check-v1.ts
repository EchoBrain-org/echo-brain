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
 * The previous turn an Ask carries (ADR-0047), with the older turns of its thread (ADR-0056), as the Authority lets its
 * model read them: only the sentences whose every citation the caller can read at request time. The client's own check is
 * a convenience; access can change between it and the send, and a retry can send a turn built long before, so the
 * Authority decides.
 *
 * Every citation of every turn goes through the Ask source check (`ask.check`), with its per-kind readability rules, for
 * the caller, in one check, each with the time its own turn was asked. Turn by turn, a sentence stays only when it rests
 * on at least one citation and every one answered `same`: one `unreadable`, `unknown`, of a kind the check does not read
 * (a person, a tool, a tool container), or with no answer at all, leaves the sentence out, and a citation no sentence
 * that stays rests on leaves with it (its label included). A turn's kept citations are renumbered in the order first
 * cited. Each turn's question is the person's own words and stays, as do the purpose and when each was asked: a turn left
 * with no sentence keeps its question. Without a check (`check` undefined), nothing is known readable, so only the
 * questions go.
 */
export async function readablePreviousV1(previous: PersonAnswerPreviousV1, input: {
  readonly access_token: string;
  readonly check: Pick<PersonAskCheckHttpApplicationV1, 'check'> | undefined;
  readonly signal?: AbortSignal;
}): Promise<PersonAnswerPreviousV1> {
  // The thread's turns, oldest first: the previous turn is the last.
  const turns: readonly PersonAnswerEarlierTurnV1[] = [...(previous.earlier ?? []), previous];
  const checkable = turns.flatMap((turn, of) => turn.citations.flatMap((cited, at) =>
    (PERSON_ASK_CHECK_CITATION_KINDS_V1 as readonly string[]).includes(cited.citation.kind) ? [{ of, at, asked_at: turn.asked_at, citation: cited.citation }] : []));
  /** Each turn's answered states, by the citation's index in that turn. */
  const states = turns.map(() => new Map<number, PersonAskCheckItemV1['state']>());
  if (input.check !== undefined && checkable.length > 0) {
    const request = validatePersonAskCheckRequestV1({ schema_version: 1, kind: PERSON_ASK_CHECK_REQUEST_KIND_V1,
      items: checkable.map(({ asked_at, citation }) => ({ asked_at, citation })) });
    const answered = await input.check.check({ access_token: input.access_token, request, ...(input.signal === undefined ? {} : { signal: input.signal }) });
    checkable.forEach(({ of, at }, place) => { const state = answered.items[place]?.state; if (state !== undefined) states[of]!.set(at, state); });
  }
  /** What one turn keeps: its sentences resting only on citations found `same`, and those citations, renumbered. */
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
