import type {
  PersonAnswerBlockV1, PersonAnswerChoiceV1, PersonAnswerCitationV8, PersonAnswerEvidenceCitationV8, PersonAnswerPreviousV1, PersonAnswerTableRowV1,
  PersonAskCheckCitationKindV1, PersonAskCheckItemV1, PersonAskCheckRequestItemV1, PersonAskCheckStateV1, PersonChangesAreaV1, PersonChangesV1, PersonMeetingRequestV2,
  PersonMeetingResultsV2, PersonOpenItemCurrentV1, PersonOpenItemV1, PersonProjectActivityItemV1, PersonRunsRequestV1, PersonRunsResultsV1,
} from '@echo-brain/organization-api';
// The only shapes that cross process boundaries. Everything here is
// token-free: the person host builds these view models from the client's
// validated output, and the renderer never sees a token, a path or a
// server-written error message.

export interface Account {
  readonly authority: string;
  readonly membership_id: string;
  readonly display_name: string;
  readonly role: 'owner' | 'employee';
  /**
   * The weekly sign-in: when this session can no longer be refreshed, and how long until then by the host's clock when
   * status was read. Past it, only signing in again helps.
   */
  readonly sign_in_due?: { readonly at: string; readonly in_ms: number };
}

/** Why this computer was signed out by a refresh, and the organization it was signed in to. */
export interface SessionEnded {
  /** The weekly sign-in passed (`reauthentication_required`), or the Authority refused the refresh (`sign_in_required`). */
  readonly reason: 'reauthentication_required' | 'sign_in_required';
  readonly authority: string;
}

export interface AppStatus {
  readonly signed_in: boolean;
  readonly account: Account | null;
  readonly client_version: string;
  /** Signed out because a refresh ended the session: until someone signs in again. */
  readonly session_ended?: SessionEnded;
}

export interface ProjectSummary {
  readonly project_id: string;
  readonly name: string;
  readonly role: 'lead' | 'member';
  readonly created_at: string;
  /** Archived projects remain readable, but do not accept new material. */
  readonly status: 'active' | 'archived';
}

export interface ProjectPage {
  readonly items: readonly ProjectSummary[];
  readonly next_cursor: string | null;
}

/** The receipt that settles a rename, archive or leave operation. */
export interface ProjectSettingsReceipt {
  readonly request_id: string;
  readonly project_id: string;
  readonly operation: 'rename' | 'archive' | 'leave';
}

/** Who can read an item: only you, everyone in the organization, or one or more projects' members. */
export type Visibility = 'only-me' | 'team' | 'project';

/** What a list shows: everything only you can read, filed in a project or not, or one project's items. The desktop never lists all you can read. */
export type ListScope = { readonly kind: 'only-me' } | { readonly kind: 'project'; readonly project_id: string };

/** One item, by kind and id: a note's context id, a document's id, or an approved meeting's record digest. */
export interface ItemRef {
  readonly kind: 'imported_meeting' | 'note' | 'document' | 'meeting';
  readonly id: string;
}

/** One row of a list: never an item's text, and never a project's id. */
export interface ListItem {
  readonly ref: ItemRef;
  readonly title: string;
  /** When it entered ECHO (ISO 8601). */
  readonly added_at: string;
  readonly visibility: Visibility;
  /** The names of your projects it is filed in. */
  readonly projects: readonly string[];
  /** A document's kind and size, from the bytes the Authority checked, and where its text stands. */
  readonly document?: { readonly type: DocumentSummary['type']; readonly size: number; readonly extraction: Extraction };
}

/** Newest first. Meetings still being indexed are held for a later read. */
export interface ListPage {
  readonly items: readonly ListItem[];
  readonly next_cursor: string | null;
  readonly meetings_held: boolean;
}

/** A saved document: an original file, and the text extracted from it. */
export interface DocumentSummary {
  readonly document_id: string;
  readonly title: string;
  readonly filename: string;
  readonly received_at: string;
  /** What kind of file it is, from the bytes the Authority checked. */
  readonly type: 'pdf' | 'word' | 'markdown' | 'text';
  /** Bytes. */
  readonly size: number;
  readonly audience: Visibility;
  readonly extraction: Extraction;
  /** The projects it is filed in that are yours. */
  readonly project_ids: readonly string[];
}

/** One piece of a document's extracted text, from a page or a paragraph. */
interface TextChunk {
  readonly anchor: 'page' | 'paragraph';
  readonly start: number;
  readonly text: string;
}

/** A document and one page of its extracted text. */
export interface DocumentText {
  readonly document: DocumentSummary;
  readonly chunks: readonly TextChunk[];
  readonly next_cursor: string | null;
}

/** A person in a project, or one a directory found. */
export interface Member {
  readonly membership_id: string;
  readonly display_name: string;
  /** Absent for a directory entry. */
  readonly role?: 'lead' | 'member';
}

export interface MemberPage {
  readonly items: readonly Member[];
  readonly next_cursor: string | null;
}

/**
 * A change to a project: who is in it, or what is filed in it. Each is sent
 * with a request id, and resending the same one never changes anything twice.
 */
export type ProjectChange =
  | { readonly kind: 'member-add' | 'member-remove'; readonly project_id: string; readonly membership_id: string }
  | { readonly kind: 'member-set'; readonly project_id: string; readonly membership_id: string; readonly role: 'lead' | 'member' }
  | { readonly kind: 'associate' | 'dissociate'; readonly project_id: string; readonly context_id: string }
  | { readonly kind: 'document-associate' | 'document-dissociate'; readonly project_id: string; readonly document_id: string };

/** A project the Authority made for one request. Its name and your role in it come from reading it. */
export interface CreatedProject {
  readonly project_id: string;
}

/** One of the organization's employees, as its owner's list shows them. */
export interface Employee {
  readonly email: string;
  readonly display_name: string;
  readonly membership: 'active' | 'revoked';
  readonly invitation: 'pending' | 'expired' | 'redeemed' | 'none';
}

export interface Employees {
  readonly items: readonly Employee[];
}

/** An invitation saved in the folder main made. The path stays in main. */
export interface InvitationSaved {
  /** When the invitation stops working (ISO 8601). */
  readonly expires_at: string;
}

/** Add files…: the documents chosen in main's dialog, each as a handle, and the names of any it refused. */
interface ChosenFiles {
  readonly files: readonly FileHandle[];
  readonly refused: readonly string[];
}

export interface ContextContent {
  readonly context_id: string;
  readonly title: string;
  readonly text: string;
  readonly received_at: string;
  /** Who can read it, as its row marks it. */
  readonly audience: Visibility;
  /** The projects it is filed in that are yours. */
  readonly project_ids: readonly string[];
}

/**
 * A live match for the bar's text: an item in the project in scope, or, in
 * all context, one of the saved notes you can read (of either note version).
 * Each opens by its ref, as a note.
 */
export interface Match {
  readonly context_id: string;
  readonly title: string;
  readonly excerpt: string;
  readonly received_at: string;
}

export interface Matches {
  readonly items: readonly Match[];
}

/**
 * Ask is always explicitly scoped; there is no default. Mine (only what you added) is never asked from the desktop any
 * more (ADR-0049): it stays for the turns kept on this computer that were asked in it.
 */
export type AskScope = { readonly kind: 'global' } | ProjectScope | { readonly kind: 'mine' };

/** An Ask in one project: the bar's chip. */
export type ProjectScope = { readonly kind: 'project'; readonly project_id: string };

/** A scope the desktop asks in: everything you can read, or one project. */
export type AskedScope = Exclude<AskScope, { readonly kind: 'mine' }>;

/** Immutable coordinates of one answer source; opaque to the renderer. */
export interface SourceRef {
  readonly source_id: string;
  readonly revision_id: string;
  readonly source_sha256: string;
  readonly representation_sha256: string;
  readonly anchor_sha256: string;
  readonly document_id?: string;
}

/** Who may read an approved record: the organization's members, a project's members, or its reviewer only. */
export type RecordPolicy = 'restricted-reviewer-person-v2' | 'project-members-readable-person-v1';

/** An approved record an answer cites, read as Ask cites it with `person records --record-sha256 --brief`. */
export interface RecordRef {
  readonly record_sha256: string;
  readonly policy_id: RecordPolicy;
}

/** What a connected tool keeps its items in: a Jira project or a Confluence space. */
export type ToolContainerKind = 'jira_project' | 'confluence_space';

/**
 * What an answer is based on, or an item Ask named while it worked: an
 * approved record's item, an original's passage, a follow-up, a project, a
 * person, a tool, or live evidence. Each kind opens through one opener
 * (renderer/openers.ts).
 */
export type ExternalAnswerSource =
  | { readonly kind: 'ticket' | 'page'; readonly tool_id: string; readonly label: string; readonly permalink: string }
  /**
   * A Jira project or Confluence space in a tool you connected (research tool
   * contract v1): it opens in its tool, by its link. `key` is its key there
   * ("THERM"), when it has one.
   */
  | { readonly kind: 'container'; readonly tool_id: string; readonly label: string; readonly permalink: string; readonly container: ToolContainerKind; readonly key?: string };
export type AnswerSource = (
  /** `atom_id`: the decision, action or rationale cited, as its record's items carry it. */
  | { readonly kind: 'record'; readonly label: string; readonly record: RecordRef; readonly atom_id: string }
  /** `item`: the note, document or imported meeting it is a passage of, from the Authority's own ref, when it sent one. */
  | { readonly kind: 'original'; readonly label: string; readonly ref: SourceRef; readonly item?: ItemRef }
  /**
   * One of ECHO's shared follow-ups (ADR-0040), by its item id: it opens its
   * item page, where its owner, status and check are read again as Home shows them.
   */
  | { readonly kind: 'follow_up'; readonly label: string; readonly item_id: string }
  /** One of your projects (research tool contract v1), by its id: it opens the project, as the sidebar does. */
  | { readonly kind: 'project'; readonly label: string; readonly project_id: string }
  /** A person in your organization, by their membership: shown by name, it opens nothing. */
  | { readonly kind: 'person'; readonly label: string; readonly membership_id: string }
  /** One of your tools, by its id: it opens Tools, where you connect it. */
  | { readonly kind: 'tool'; readonly label: string; readonly tool_id: string }
  | ExternalAnswerSource
) & {
  /**
   * Only you can read it (cited as yours alone, or the approver's): only on an
   * answer's sources, so a table row that cites it shows the lock (ADR-0045).
   */
  readonly private?: true;
  /**
   * The citation exactly as the answer's response carried it, only on an
   * answer's sources: opaque here. A follow-up or Ask again sends the earlier
   * answer's citations back with it (`previous`, ADR-0047), and a check asks
   * about the evidence citation of one that can change or go (`checkOf`).
   */
  readonly cited?: PersonAnswerCitationV8;
};

/** The kinds of evidence a check asks about (Ask source check, C1): what an old answer cited that can change or go. */
const CHECK_KINDS: readonly PersonAskCheckCitationKindV1[] = ['approved_record', 'source_revision', 'follow_up', 'ticket', 'page'];
/** A checkable source's evidence citation, as the answer cited it. */
export type CheckCitation = Extract<PersonAnswerEvidenceCitationV8, { readonly kind: PersonAskCheckCitationKindV1 }>;

/**
 * What `ask.check` asks about a source (ADR-0047): its evidence citation,
 * exactly as the answer cited it, when it can change or go (a record's item,
 * an original's passage, a follow-up, a ticket or a page). Opaque here.
 */
export function checkOf(source: AnswerSource): CheckCitation | undefined {
  const citation = source.cited?.citation;
  return citation !== undefined && (CHECK_KINDS as readonly string[]).includes(citation.kind) ? citation as CheckCitation : undefined;
}

/**
 * What Ask is doing now (ADR-0039), from what ECHO ran: a step's searches,
 * its reads and the research model reading, the final access check, or the
 * answer being written.
 */
export type AskStage = 'searching' | 'reading' | 'checking_access' | 'writing';
/**
 * A kind of source a step searched: meetings, documents or follow-ups; your
 * projects, the people in your organization or your tools; or a live tool's
 * tickets, pages or containers (its Jira projects or Confluence spaces), by
 * the tool's id.
 */
export type AskSearchedSource = { readonly kind: 'meetings' | 'documents' | 'follow_ups' | 'projects' | 'people' | 'tools' }
  | { readonly kind: 'tickets' | 'pages' | 'containers'; readonly tool_id: string };
/** One step's searches: the source kinds, and how many items they returned that no earlier read had. */
export interface AskSearched {
  readonly type: 'searched';
  readonly sources: readonly AskSearchedSource[];
  readonly found: number;
}
/** Items whose full text research was just given, each after the access check before that read: as a source opens. */
export interface AskRead {
  readonly type: 'read';
  readonly items: readonly AnswerSource[];
}
/** One step of an Ask still working. `pending`, only while reading: items about to be read whose names have not come yet. */
export type AskStep = { readonly type: 'stage'; readonly stage: AskStage; readonly pending?: number } | AskSearched | AskRead;
/**
 * What an answered Ask looked through, rebuilt by the Authority from the
 * items that passed its final check: how many items it looked through (from
 * progress V3, ADR-0043, the rows it was shown as well as what it read in
 * full; before, only what it read in full), and its searches and reads in
 * order, neighbours of a type already merged.
 */
export interface AskReceipt {
  readonly looked_through: number;
  readonly rows: readonly (AskSearched | AskRead)[];
}

/** A cited statement in the Agentic Ask response. Citation indexes address Answer.sources. */
export interface AnswerStatement {
  readonly text: string;
  readonly citation_indexes: readonly number[];
  readonly private: boolean;
}

/**
 * How a part reads (answer layout v1, ADR-0045): blocks that group its
 * statements, in their order, into a lead, headings, paragraphs, bullets and
 * tables. It adds no claim and no citation: a table's rows each cite only
 * what its statements cite. The contract's own type, as the host validated it.
 */
export type AnswerBlock = PersonAnswerBlockV1;
/** One table row of a laid-out part: its cells, in its table's column order, and the citations of what it shows. */
export type AnswerTableRow = PersonAnswerTableRowV1;

export interface AnswerPart {
  readonly question: string;
  readonly status: 'answered' | 'partial' | 'not_found' | 'records_only';
  readonly statements: readonly AnswerStatement[];
  readonly gap?: string;
  readonly records?: readonly AnswerStatement[];
  /** Only on a V8 answer to an Ask that asked for it: how its statements read. Without it, each is a paragraph. */
  readonly layout?: readonly AnswerBlock[];
}

/** One thing a follow-up could be about, as Ask offers it to choose (ADR-0047): a short label, and the full question it asks. */
export type AskChoice = PersonAnswerChoiceV1;

/** An Agentic Ask answer. `text` is its plain reading, for Copy answer when its Markdown is too long. */
export interface Answer {
  readonly text: string;
  readonly scope: AskScope;
  readonly sources: readonly AnswerSource[];
  readonly direct?: AnswerStatement;
  /** At least one, but none when Ask asks which one (`clarify`). */
  readonly parts: readonly AnswerPart[];
  /** `clarify`: a follow-up could mean more than one thing, and `choices` asks which; Ask never guesses (ADR-0047). */
  readonly outcome: 'answered' | 'partial' | 'not_found' | 'clarify';
  /** Only from an Authority that streamed the Ask: what it looked through. */
  readonly receipt?: AskReceipt;
  /** Only for an Ask that carried `previous`: the full question the answer answers ("Who owns THERM-482?"). */
  readonly question?: string;
  /** Only for Ask again: what is different now, each cited; empty when nothing material changed. */
  readonly since?: readonly AnswerStatement[];
  /** Only with outcome `clarify`: two to four things the question could mean. */
  readonly choices?: readonly AskChoice[];
}

/**
 * An answer as the timeline keeps it: what the page reads back of a turn.
 * What only the Ask that brought it reads (what it looked through, "Which
 * one?"'s choices) and what the turn keeps itself (the full question, Ask
 * again's "since") are not kept twice.
 */
export type TimelineAnswer = Omit<Answer, 'receipt' | 'question' | 'since' | 'choices'>;

/**
 * One question and its answer on the Ask timeline (ADR-0047), as the host keeps
 * it in the account's file on this device. Never sent to the Authority.
 */
export interface TimelineTurn {
  /** A UUID the page gave it. */
  readonly id: string;
  /** When it was asked, by this computer's clock (ISO 8601). */
  readonly asked_at: string;
  /** What the person typed: shown while the turn is in full. */
  readonly text: string;
  /** The full question the answer answers: shown when folded, and what Ask again asks. */
  readonly question: string;
  readonly scope: AskScope;
  /**
   * As the host built it, less what the turn keeps itself or only its Ask read (`TimelineAnswer`); each source keeps the
   * citation it was cited by (`cited`), whose evidence citation a check asks about when it can change or go (`checkOf`).
   */
  readonly answer: TimelineAnswer;
  /** Ask again's "Since" list: what is different now, each cited; empty when nothing material changed. */
  readonly since?: readonly AnswerStatement[];
  /** The turn this one asked again. */
  readonly again_of?: string;
  /** Ticket baseline markers by source index: what a check compares a ticket with. */
  readonly markers?: Readonly<Record<string, string>>;
  /**
   * The sources, by index, a check found unreadable: what cites them stays hidden, however long ago that check was, until
   * a check finds them readable again (C5). A check that cannot tell (`unknown`) changes nothing.
   */
  readonly unreadable?: readonly number[];
}

/** The most turns a timeline keeps, and for how long: older ones go on every put. */
export const MAX_TIMELINE_TURNS = 200;
export const TIMELINE_DAYS = 90;
/**
 * The most a put may send: one turn, whose answer is at most the API's 64 KiB
 * with its sources' citations kept beside them. Every other call keeps the
 * broker's MAX_PARAMS_BYTES.
 */
export const MAX_TIMELINE_PUT_BYTES = 256 * 1024;

/** What a check says of one cited source (C1): unchanged, changed, no longer readable by you, or not known now. */
export type AskCheckState = PersonAskCheckStateV1;
/** One source to check: when the turn that cited it was asked, its evidence citation, and a ticket's baseline marker. */
export type AskCheckItem = PersonAskCheckRequestItemV1;
/** What the check said of one item, in the request's order: a readable ticket's current marker too. */
export type AskCheckResult = PersonAskCheckItemV1;
/** The most items one check asks about, and its body's bound (C1). */
export const MAX_CHECK_ITEMS = 100;
export const MAX_CHECK_REQUEST_BYTES = 64 * 1024;

/**
 * The previous turn an Ask carries (C3, ADR-0047): the asker's own context,
 * never evidence, never stored. `follow_up` resolves what "it" means from it;
 * `ask_again` has the writer say what is different since `asked_at`.
 */
export type AskPrevious = PersonAnswerPreviousV1;
/** C3's bounds on `previous`, and the Ask request body's own, which it shares. */
export const PREVIOUS_LIMITS = { statements: 8, statement_chars: 400, citations: 12, statement_citations: 4 } as const;
export const MAX_ASK_BODY_BYTES = 16 * 1024;

/** The newest thing that arrived in one of your projects from someone else that you can read, or null (C2). */
export type ProjectActivity = PersonProjectActivityItemV1;

export interface SourceEvidence {
  readonly label: string;
  readonly text: string;
}

/** One approved decision, action or rationale, with up to three excerpts that support it. */
export interface RecordItem {
  readonly text: string;
  /** Only a decision still open says so. */
  readonly status?: 'proposed' | 'unresolved';
  /** An action's owner, only as the approver confirmed it at approval. */
  readonly owner?: string;
  readonly excerpts: readonly { readonly quote: string; readonly at?: string }[];
  /**
   * A long item read in parts, while some are still unread: its text holds
   * parts `from` to `to` of `count`, and the next page's first part goes on.
   */
  readonly parts?: { readonly from: number; readonly to: number; readonly count: number };
  /** The item's id as an answer cites it (a digest, never its text): only on a record read for Ask's side panel. */
  readonly atom_id?: string;
}

/** At most 32 items; `more` says some were left out. */
export interface RecordSection {
  readonly items: readonly RecordItem[];
  readonly more: boolean;
}

/** An approved meeting record, as the source pane or the reader shows it. The pane's texts are at most 2,000 characters; the reader's at most 4,000 a part, and a long item's parts are joined. */
export interface ApprovedRecord {
  readonly title?: string;
  /** When it was approved (ISO 8601), as its row shows it: only on a record opened by its ref. */
  readonly added_at?: string;
  /** When the meeting started (ISO 8601), in which time zone, and whether it was all day. */
  readonly started_at?: string;
  readonly timezone?: string;
  readonly all_day: boolean;
  readonly approved_by?: string;
  /** At most 32 names; `participants_more` says others were left out. */
  readonly participants: readonly string[];
  readonly participants_more: boolean;
  readonly visibility: 'project' | 'approver';
  readonly decisions: RecordSection;
  readonly actions: RecordSection;
  readonly rationales: RecordSection;
}

/** One item opened by its ref: a note's text, a page of a document's text, or a page of a meeting's approved record. */
export type Opened =
  | { readonly kind: 'imported_meeting'; readonly content: ContextContent; readonly next_cursor: string | null }
  | { readonly kind: 'note'; readonly content: ContextContent }
  | { readonly kind: 'document'; readonly document: DocumentText }
  | { readonly kind: 'meeting'; readonly record: ApprovedRecord; readonly next_cursor: string | null };

/** One audience per item: only you, one project's members, several projects' members, or everyone. */
export type Audience =
  | { readonly kind: 'only-me' }
  | { readonly kind: 'project'; readonly project_id: string }
  /** Several projects, in any order (the host sends them sorted). Capture sends a single project as `project`. */
  | { readonly kind: 'projects'; readonly project_ids: readonly string[] }
  | { readonly kind: 'team' };

/**
 * The most projects a capture is filed in, and the most whose members can
 * read it: the API's own bound (PERSON_UPLOAD_PROJECT_SET_MAX).
 */
export const MAX_CAPTURE_PROJECTS = 20;
/** New project takes up to 20 files. */
export const MAX_PROJECT_FILES = 20;
/** Copy answer takes what an answer can hold: 12,000 characters. */
export const MAX_COPY_CHARACTERS = 12_000;

/** Where a saved document's text extraction stands (the Authority's own states). */
export type Extraction = 'extracting' | 'ready' | 'partial' | 'no_text' | 'encrypted' | 'malformed' | 'limit_exceeded' | 'timed_out'
  | 'unsupported' | 'unavailable';

export interface Receipt {
  readonly request_id: string;
  readonly audience: Audience;
  /** A document's extraction state, when the Authority's receipt carries it. */
  readonly extraction?: Extraction;
}

/**
 * Your connection to one tool: linked, not yet (unlinked), stopped (revoked),
 * or not turned on for your organization (unavailable).
 */
export type ToolStatus = 'linked' | 'unlinked' | 'revoked' | 'unavailable';

/** One of the organization's tools and your connection to it. The page never names a tool: it shows what the Authority lists. */
export interface ConnectedTool {
  readonly tool_id: string;
  readonly name: string;
  readonly status: ToolStatus;
}

/** A connection started in the browser: its id and when the Authority gives up on it. */
export interface ToolAttempt {
  readonly attempt_id: string;
  readonly expires_at: string;
}

/** Where a started connection is. failure_reason is the tool's own code when it failed. */
export interface ToolAttemptStatus {
  readonly status: 'pending' | 'complete' | 'cancelled' | 'expired' | 'failed';
  readonly failure_reason: string | null;
}

export interface ConnectedTools {
  readonly tools: readonly ConnectedTool[];
}

/**
 * Paste a meeting, as the page sends it: the text as typed, and a whole day's date (YYYY-MM-DD) or a start (a UTC
 * timestamp), or neither. The host makes the text canonical and checks it with the meetings API's own validator.
 */
export interface PastedMeeting {
  readonly title: string;
  readonly notes: string;
  readonly transcript: string;
  readonly date?: string;
  readonly started_at?: string;
}
/** The meetings API's bound on a pasted meeting (PERSON_HAND_IN_MEETING_MAX_BYTES_V1), which the page checks before sending. */
export const MAX_PASTED_MEETING_BYTES = 60 * 1024;
/**
 * Pasted text as the meetings API keeps it (personHandInTextV1): line feeds only, other line breaks as line feeds, no
 * control but tab, NFC, trimmed. The host and the client make it with the API's own function; the page measures with this.
 */
export function pastedText(value: string): string {
  return value.replace(/\r\n?|[\u000b\u000c\u0085\u2028\u2029]/g, '\n').replace(/[\u0000-\u0008\u000e-\u001f\u007f-\u0084\u0086-\u009f]/g, '')
    .normalize('NFC').trim();
}
/**
 * A pasted meeting as the client sends it (personHandInMeetingV1): canonical text, and a whole day as its date at noon UTC
 * or a start with this computer's time zone. Its JSON is what the meetings API bounds by MAX_PASTED_MEETING_BYTES.
 */
export function pastedMeetingAsSent(meeting: PastedMeeting, timeZone: string): {
  readonly title: string; readonly notes: string; readonly transcript: string; readonly started_at?: string; readonly time_zone?: string; readonly all_day?: true;
} {
  return { title: pastedText(meeting.title), notes: pastedText(meeting.notes), transcript: pastedText(meeting.transcript),
    ...(meeting.date === undefined ? {} : { started_at: `${meeting.date}T12:00:00.000Z`, all_day: true as const }),
    ...(meeting.started_at === undefined ? {} : { started_at: meeting.started_at, time_zone: timeZone }) };
}

/** What a status check says about a save whose outcome was unknown. */
export interface WriteStatus {
  readonly state: 'saved' | 'not_saved' | 'unknown';
  readonly extraction?: Extraction;
}

export interface FileHandle {
  readonly handle: string;
  readonly name: string;
  /** Bytes, for a document. */
  readonly size?: number;
}

export interface Failure {
  readonly code: string;
  readonly retryable: boolean;
  /** Present for writes: whether the change may already have been applied. */
  readonly mutation_outcome?: 'unknown' | 'not_submitted';
  readonly request_id?: string;
}

export type Result<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly failure: Failure };

/** What the updater shows: one sidebar row, or nothing. */
export type UpdateState =
  | { readonly state: 'none' }
  /** This release should update itself, but its updater could not start: a quiet row says so, and installs nothing. */
  | { readonly state: 'off' }
  | { readonly state: 'available' | 'installing' | 'restart'; readonly release: string }
  | { readonly state: 'failed'; readonly release: string; readonly reason: 'failed' | 'location' };

/** The account the renderer is showing; host calls refuse to run for another. */
export interface Expect {
  readonly authority: string;
  readonly membership_id: string;
}

/** The same account: the same Authority and the same membership. Missing is never the same. */
export function sameExpect(a: Expect | null | undefined, b: Expect | null | undefined): boolean {
  return a != null && b != null && a.authority === b.authority && a.membership_id === b.membership_id;
}

/**
 * A refresh that ended the session for good, signing this computer out: the weekly sign-in passed
 * (`reauthentication_required`), or the Authority refused the refresh (`sign_in_required`).
 */
export const SESSION_ENDED: readonly string[] = ['reauthentication_required', 'sign_in_required'];

/** Failures that say the account on screen is gone (signed out or switched under it), not the call. */
export const ACCOUNT_GONE: readonly string[] = ['signed_out', 'account_changed', 'unauthorized', 'stale_access_state', ...SESSION_ENDED];

/** The change check's areas, in the contract's order. */
export const CHANGE_AREAS: readonly PersonChangesAreaV1[] = ['projects', 'follow_ups', 'reviews'];

/** Project configuration only; Jira evidence is read for each question. */
export interface ProjectJiraMapping {
  project_id: string;
  revision: string | null;
  mapping: { project_id: string; project_key: string } | null;
}

/** Project configuration only; Confluence pages are read live under each person's grant. */
export interface ConfluenceSpace { id: string; key: string; name: string }
export interface ProjectConfluenceMapping {
  project_id: string;
  revision: string | null;
  mapping: { space_ids: readonly string[] } | null;
}
export interface ConfluenceSpacesPage { items: readonly ConfluenceSpace[]; next_cursor: string | null }

/**
 * What an open item says now, read live for you in this request and never
 * stored: its citation as a source "Open in …" can open, and its details.
 */
interface OpenItemCurrent extends Omit<PersonOpenItemCurrentV1, 'citation'> {
  readonly source: AnswerSource;
}
/**
 * One open item a decision found, as you may see it: its decision only when
 * you can read it, and what it says now only when you could open it. `reach`
 * says how that live read went: `opened`, refused to you (`no_access`), not
 * answered just now (`unavailable`: an outage, never lost access), or not tried
 * (`not_read`).
 */
export interface OpenItemView extends Omit<PersonOpenItemV1, 'current'> {
  readonly current?: OpenItemCurrent;
}
/** Home's part of the runs: Send rows, the items that wait on you, and what waits on others. */
export interface HomeView extends Omit<PersonRunsResultsV1['home'], 'items'> {
  readonly items: readonly OpenItemView[];
}
/** A page of a scope's open items, its summary, and each decision's check. */
export interface OpenItemsView extends Omit<PersonRunsResultsV1['items'], 'items'> {
  readonly items: readonly OpenItemView[];
}
/**
 * The impact checks of your own approvals, the open items they found, and the
 * sweeps that recheck them. What a check found shows as the meeting's
 * follow-ups, so the desktop never asks for its card (`view`).
 */
export interface RunsResults {
  list: PersonRunsResultsV1['list'];
  start: PersonRunsResultsV1['start'];
  retry: PersonRunsResultsV1['retry'];
  home: HomeView;
  items: OpenItemsView;
  item: OpenItemView;
  send: PersonRunsResultsV1['send'];
  set_state: PersonRunsResultsV1['set_state'];
  assign: PersonRunsResultsV1['assign'];
  sweep: PersonRunsResultsV1['sweep'];
}

export interface HostMethods {
  'runs': { params: { expect: Expect; request: PersonRunsRequestV1 }; result: RunsResults[keyof RunsResults] };
  'tools.meetings': { params: { expect: Expect; request: PersonMeetingRequestV2 }; result: PersonMeetingResultsV2[keyof PersonMeetingResultsV2] };

  'app.status': { params: Record<string, never>; result: AppStatus };
  'signin.begin': { params: { authority_url: string }; result: AppStatus };
  /** The renderer names the invitation only by a handle main issued; main swaps in the path. */
  'signin.invitation': { params: { invitation_handle: string }; result: AppStatus };
  'projects.list': { params: { expect: Expect; status?: 'active' | 'archived'; cursor?: string }; result: ProjectPage };
  /** What changed in your view: one fingerprint per area, no content (desktop refresh and notifications v1; ADR-0036). */
  'changes.read': { params: { expect: Expect }; result: PersonChangesV1 };
  /** One page of what you added, or of one project's notes, documents and meetings, newest first. */
  'list.page': { params: { expect: Expect; scope: ListScope; cursor?: string }; result: ListPage };
  /** One item by its ref, under your current access: a document's text or a meeting's record a page at a time. */
  'open.ref': { params: { expect: Expect; ref: ItemRef; cursor?: string }; result: Opened };
  /** Save original…: the renderer names the file only by a handle main issued; main swaps in the path. */
  'documents.save': { params: { expect: Expect; document_id: string; save_handle: string }; result: null };
  /** The project as it is now, with your role in it. */
  'projects.read': { params: { expect: Expect; project_id: string }; result: ProjectSummary };
  'projects.members': { params: { expect: Expect; project_id: string; cursor?: string }; result: MemberPage };
  /**
   * People in your own organization, by name, for any member and with no
   * project: New project's people, and those a lead adds in People.
   */
  'people.directory': { params: { expect: Expect; query?: string; cursor?: string }; result: MemberPage };
  /** A change to a project. Only the Authority's receipt says it was made. */
  'projects.change': { params: { expect: Expect; request_id: string; change: ProjectChange }; result: null };
  /** New project: made once per request id, and only the receipt says it was made. */
  'projects.create': { params: { expect: Expect; request_id: string; name: string }; result: CreatedProject };
  'projects.rename': { params: { expect: Expect; request_id: string; project_id: string; name: string }; result: ProjectSettingsReceipt };
  'projects.archive': { params: { expect: Expect; request_id: string; project_id: string; archived: boolean }; result: ProjectSettingsReceipt };
  'projects.leave': { params: { expect: Expect; request_id: string; project_id: string }; result: ProjectSettingsReceipt };
  /** People & invites (owners only): everyone the organization invited, and where each stands. */
  'employees.list': { params: { expect: Expect }; result: Employees };
  /**
   * Invite or Reissue: the renderer names where to save only by a handle main
   * issued; main makes a private folder there and swaps in the file's path.
   */
  'employees.invite': { params: { expect: Expect; name: string; email: string; invitation_handle: string }; result: InvitationSaved };
  'employees.reissue': { params: { expect: Expect; email: string; invitation_handle: string }; result: InvitationSaved };
  /** Revoke access: ends the employee's membership at once. */
  'employees.revoke': { params: { expect: Expect; email: string }; result: null };
  /** `project_ids`: the projects it is filed in, at most MAX_CAPTURE_PROJECTS, in any order. */
  'notes.submit': { params: { expect: Expect; request_id: string; text: string; audience: Audience; project_ids: readonly string[] }; result: Receipt };
  /** The renderer names a file only by a handle main issued; main swaps in the path. */
  'documents.upload': {
    params: { expect: Expect; request_id: string; file_handle: string; title: string; audience: Audience; project_ids: readonly string[] };
    result: Receipt;
  };
  /** `previous`: the earlier turn a follow-up or Ask again carries (C3). */
  'ask.run': { params: { expect: Expect; question: string; scope: AskedScope; cancel_id: string; previous?: AskPrevious }; result: Answer };
  /** The account's Ask timeline on this device, oldest first; an unreadable file reads as empty (ADR-0047). */
  'timeline.read': { params: { expect: Expect }; result: { turns: TimelineTurn[] } };
  /** Keeps one turn: a new one at the end, or one already kept in its place; then the oldest past the bounds go. */
  'timeline.put': { params: { expect: Expect; turn: TimelineTurn }; result: Record<string, never> };
  /** What changed of the sources old answers cited (C1): content-free, in the items' order. */
  'ask.check': { params: { expect: Expect; items: AskCheckItem[] }; result: { items: AskCheckResult[] } };
  /** Per project you are in, the newest arrival from someone else you can read (C2). */
  'projects.activity': { params: { expect: Expect }; result: { items: ProjectActivity[] } };
  /** Cancels an active Ask by its renderer-issued opaque id. */
  'ask.cancel': { params: { cancel_id: string }; result: null };
  /** The bar's live search, within its scope: a project, or all context. */
  'search.run': { params: { expect: Expect; query: string; scope: AskScope }; result: Matches };
  'ask.source': { params: { expect: Expect; scope: AskScope; ref: SourceRef }; result: SourceEvidence };
  /** Reads one approved record an answer cites. */
  'ask.record': { params: { expect: Expect; record: RecordRef }; result: ApprovedRecord };
  'writes.status': { params: { expect: Expect; request_id: string; kind: 'note' | 'document' }; result: WriteStatus };
  /** Resends a document's retained original under the same request. */
  'documents.retry': { params: { expect: Expect; request_id: string; audience: Audience }; result: Receipt };
  /** Start over: removes the private copy the client kept to resend a document. The Authority is not asked. */
  'documents.abandon': { params: { expect: Expect; request_id: string }; result: null };
  /**
   * Signs the account on screen out of this computer; the reply is the new status. Its Ask timeline goes with it, except
   * when the same person signs straight back in (`again`, the weekly sign-in done early).
   */
  'account.signOut': { params: { expect: Expect; again?: true }; result: AppStatus };
  /** Tools: the organization's tools and your connection to each, for the account on screen. */
  'account.tools': { params: { expect: Expect }; result: ConnectedTools };
  /** Project members read the mapping; only leads can change it. */
  'projects.jiraRead': { params: { expect: Expect; project_id: string }; result: ProjectJiraMapping };
  'projects.jiraSet': { params: { expect: Expect; project_id: string; request_id: string; expected_revision: string | null; jira_project: string | null }; result: ProjectJiraMapping };
  'projects.confluenceRead': { params: { expect: Expect; project_id: string }; result: ProjectConfluenceMapping };
  'projects.confluenceSet': { params: { expect: Expect; project_id: string; request_id: string; expected_revision: string | null; space_ids: readonly string[] | null }; result: ProjectConfluenceMapping };
  'projects.confluenceSpaces': { params: { expect: Expect; cursor?: string }; result: ConfluenceSpacesPage };
  /** Connect or Reconnect: opens the tool's page in the browser and returns at once with the attempt. */
  'tools.connect': { params: { expect: Expect; tool_id: string }; result: ToolAttempt };
  /** Reads a started connection; a status read is what completes it. */
  'tools.status': { params: { expect: Expect; tool_id: string; attempt_id: string }; result: ToolAttemptStatus };
  'tools.cancel': { params: { expect: Expect; tool_id: string; attempt_id: string }; result: ToolAttemptStatus };
  /** Removes your own connection to the tool. */
  'tools.disconnect': { params: { expect: Expect; tool_id: string }; result: null };
  /**
   * Paste a meeting: the host writes its text to private files for the client, never to its arguments. The same meeting
   * pasted again answers the same id; what it decided still needs your approval.
   */
  'meetings.handIn': { params: { expect: Expect; meeting: PastedMeeting; project_id: string | null }; result: { meeting_id: string } };
}

export interface MainMethods {
  /** Opens a validated external citation using its evidence kind's link policy. */
  'source.openExternal': { params: { kind: ExternalAnswerSource['kind']; permalink: string }; result: null };
  'dialog.openDocument': { params: Record<string, never>; result: FileHandle | null };
  /** Add files…, in New project: up to 20 documents at once. */
  'dialog.openDocuments': { params: Record<string, never>; result: ChosenFiles };
  /**
   * Invite employee… and Reissue invitation…: where the private invitation
   * folder goes, chosen in main's dialog. `name` only suggests the folder's name.
   */
  'dialog.saveInvitation': { params: { name: string; reissue?: boolean }; result: FileHandle | null };
  /** Show invitation in Finder: the invitation saved under a handle an invite or a reissue used. */
  'invitation.show': { params: { invitation_handle: string }; result: null };
  /** Copy answer: at most 12,000 characters, an answer's own bound. */
  'clipboard.writeText': { params: { text: string }; result: null };
  /** The invitation folder (or its file) the organization owner sent. */
  'dialog.openInvitation': { params: Record<string, never>; result: FileHandle | null };
  /** Save original…: where to save it, chosen in main's dialog. The page gets a handle, never the path. */
  'dialog.saveDocument': { params: { name: string }; result: FileHandle | null };
  /** A save's or a project change's outcome is unknown: quitting asks first, naming a note, a file or a change. */
  'app.setUnresolved': { params: { unresolved: boolean; file?: boolean; change?: boolean }; result: null };
  /** After the host gave up: start it again. */
  'app.retryHost': { params: Record<string, never>; result: null };
  /** Pops up the Account menu at a point in the window, in CSS pixels. */
  'menu.account': { params: { x: number; y: number }; result: null };
  'update.status': { params: Record<string, never>; result: UpdateState };
  /** New version · Restart: installs `release` (or, in state restart, relaunches), then quits. Refused while work is unresolved. */
  'update.install': { params: { release: string }; result: null };
  /**
   * One system notification (desktop refresh and notifications v1, N6): what
   * changed for you, and what a click opens. See `noticeOf`.
   */
  'notice.show': { params: Notice; result: null };
  /** desktop.log, codes only: the change check's areas that moved. Never a digest or an id. */
  'log.changes': { params: { moved: readonly PersonChangesAreaV1[] }; result: null };
}

export type Methods = HostMethods & MainMethods;
export type MethodName = keyof Methods;
export type HostMethodName = keyof HostMethods;

/**
 * Each host method's limit in the host; the client enforces its own shorter network timeouts. Its keys are main's allowlist
 * of host methods, so none can be left out. Plain numbers, so the page's bundle leaves the table out.
 */
export const HOST_TIMEOUT_MS: Readonly<Record<HostMethodName, number>> = {
  'app.status': 5_000, 'signin.begin': 660_000, 'signin.invitation': 660_000, 'projects.list': 45_000, 'changes.read': 15_000,
  'list.page': 45_000, 'open.ref': 45_000, 'notes.submit': 45_000, 'documents.upload': 720_000,
  'ask.run': 145_000, 'ask.cancel': 5_000, 'ask.source': 15_000, 'ask.record': 15_000, 'writes.status': 45_000, 'documents.retry': 720_000, 'documents.abandon': 15_000,
  'account.signOut': 45_000, 'account.tools': 45_000, 'search.run': 45_000,
  'documents.save': 720_000, 'projects.read': 45_000, 'projects.members': 45_000,
  'people.directory': 45_000, 'projects.change': 45_000, 'projects.create': 45_000, 'projects.rename': 45_000, 'projects.archive': 45_000,
  'projects.leave': 45_000, 'employees.list': 45_000, 'employees.invite': 45_000,
  'employees.reissue': 45_000, 'employees.revoke': 45_000,
  'projects.jiraRead': 45_000, 'projects.jiraSet': 90_000, 'projects.confluenceRead': 45_000, 'projects.confluenceSet': 90_000, 'projects.confluenceSpaces': 45_000,
  'tools.meetings': 90_000, 'runs': 45_000, 'tools.connect': 45_000, 'tools.status': 45_000, 'tools.cancel': 45_000, 'tools.disconnect': 45_000,
  'meetings.handIn': 90_000,
  // The timeline is this computer's own file; a check waits out the Authority's 15 s budget; activity is one read, as the change check.
  'timeline.read': 15_000, 'timeline.put': 15_000, 'ask.check': 30_000, 'projects.activity': 15_000,
};
export const MAIN_METHODS: readonly (keyof MainMethods)[] = [
  'source.openExternal', 'dialog.openDocument', 'clipboard.writeText', 'dialog.openInvitation', 'app.setUnresolved', 'app.retryHost', 'menu.account',
  'dialog.saveDocument', 'dialog.openDocuments', 'dialog.saveInvitation', 'invitation.show', 'update.status', 'update.install', 'notice.show', 'log.changes',
];
/** Host methods that change what the Authority stores. */
export const WRITE_METHODS: ReadonlySet<string> = new Set<HostMethodName>([
  'notes.submit', 'documents.upload', 'documents.retry', 'projects.change', 'projects.create', 'projects.rename', 'projects.archive', 'projects.leave', 'employees.invite', 'employees.reissue',
  'employees.revoke', 'tools.meetings', 'runs', 'tools.disconnect', 'projects.jiraSet', 'projects.confluenceSet',
  'meetings.handIn',
]);
/** Operations of a write method that only read. */
const READ_OPERATIONS: Readonly<Record<string, ReadonlySet<string>>> = {
  'tools.meetings': new Set<PersonMeetingRequestV2['operation']>(['home', 'reviews', 'browse', 'open', 'review_open']),
  runs: new Set<PersonRunsRequestV1['operation']>(['list', 'home', 'items', 'item']),
};
/** Whether a call may change what the Authority stores. An operation not known to only read counts as a write. */
export function isWriteCall(method: string, params: unknown): boolean {
  if (!WRITE_METHODS.has(method)) return false;
  const operation = (params as { request?: { operation?: unknown } | null } | null | undefined)?.request?.operation;
  return !(typeof operation === 'string' && READ_OPERATIONS[method]?.has(operation) === true);
}
/** Every runs operation: only these reach the log by name. */
const RUNS_OPERATIONS: ReadonlySet<string> = new Set<PersonRunsRequestV1['operation']>(
  ['list', 'home', 'start', 'retry', 'items', 'item', 'send', 'set_state', 'assign', 'sweep'],
);
/**
 * A call as desktop.log names it, content-free: the method, and for runs its operation and how much it read ("runs.home",
 * "runs.items rows"). Never an id, a scope id or a cursor; an operation or a read not known is left out.
 */
export function rpcLogName(method: string, params: unknown): string {
  if (method !== 'runs') return method;
  const request = (params as { request?: unknown } | null | undefined)?.request;
  if (request === null || typeof request !== 'object') return method;
  const { operation, read } = request as Record<string, unknown>;
  if (typeof operation !== 'string' || !RUNS_OPERATIONS.has(operation)) return method;
  return `runs.${operation}${read === 'rows' || read === 'counts' ? ` ${read}` : ''}`;
}
/**
 * The Account menu's version line: "ECHO 0.1.0-internal.1 · 038f099". Releases can share a version, so the commit the app was
 * built from tells them apart, as the tray's Build line does; "(modified)" when it was built with changes beside that commit.
 */
export function versionLine(version: string, build: { readonly source_sha: string; readonly dirty: boolean } | null): string {
  return build === null ? `ECHO ${version}` : `ECHO ${version} · ${build.source_sha.slice(0, 7)}${build.dirty ? ' (modified)' : ''}`;
}
/** Host methods whose reply is the account status: main keeps the Account menu current from them. */
export const STATUS_METHODS: ReadonlySet<string> = new Set<HostMethodName>(['app.status', 'signin.begin', 'signin.invitation', 'account.signOut']);

/** What an Account menu item asks the window to do. */
export type AccountCommand = 'signin' | 'invitation' | 'switch' | 'signout' | 'tools';

/** Events main pushes to the renderer. */
export interface Events {
  'capture.open': Record<string, never>;
  /**
   * Where the window stands, when that changes: on screen (shown, not minimized, not covered by other windows), and in
   * front (ECHO the active app on macOS; elsewhere its window focused). Not in front, the page is covered; back on screen
   * and in front, it came back.
   */
  'window.state': { onScreen: boolean; front: boolean };
  /** The machine woke from sleep (powerMonitor `resume`). */
  'system.woke': Record<string, never>;
  'signin.phase': { phase: 'open-browser' | 'installed'; browser_opened?: boolean };
  'host.restarted': Record<string, never>;
  /** The host kept exiting and main stopped restarting it. */
  'host.failed': Record<string, never>;
  /** An Account menu item was chosen, in the window or the tray. */
  'account.command': { command: AccountCommand };
  /** Organization ▸ People & invites… was chosen in the tray (owners only). */
  'organization.open': Record<string, never>;
  /** What the updater shows now: a check, an install's progress, or a previous run's outcome. */
  'update.changed': UpdateState;
  /** A notification was clicked: what it opens, as the page said when it asked for it. */
  'notice.open': { target: NoticeTarget };
  /**
   * A step of the Ask the host is running (ADR-0039), for the account and the
   * Ask's renderer-issued cancel id it ran under: the page drops any other.
   */
  'ask.progress': AskProgressNotice;
}
export interface AskProgressNotice {
  readonly cancel_id: string;
  readonly expect: Expect;
  readonly step: AskStep;
}
export type EventName = keyof Events;

/** Requests main sends to the host process, and its replies. */
export interface HostRequest {
  readonly id: number;
  readonly method: HostMethodName;
  readonly params: unknown;
}
export interface HostReply {
  readonly id: number;
  readonly result: Result<unknown>;
}
export interface HostNotice {
  readonly notice: 'signin.phase' | 'open-external' | 'ask.progress';
  readonly payload: unknown;
}

/** The only address an 'open-external' notice opens: https, with no credentials in it. */
export function externalUrl(raw: unknown): string | null {
  try {
    const url = new URL(String(raw));
    return url.protocol === 'https:' && url.username === '' && url.password === '' ? url.href : null;
  } catch {
    return null;
  }
}

/** The provider validated tenant and identity; this display boundary constrains URL safety. */
function webPermalink(raw: unknown, allowQuery: boolean): string | null {
  if (typeof raw !== 'string' || raw.length > 2048 || /[\s\\\p{Cc}]/u.test(raw)) return null;
  try {
    const url = new URL(raw);
    return url.protocol === 'https:' && url.hostname !== '' && url.username === '' && url.password === '' &&
      (allowQuery || url.search === '') && url.hash === '' && url.href === raw ? raw : null;
  } catch { return null; }
}

/** Page identifiers can be carried in the provider's query string. */
export const pagePermalink = (raw: unknown): string | null => webPermalink(raw, true);
/** A ticket display link has no embedded authorization or redirect parameters. */
export const ticketPermalink = (raw: unknown): string | null => webPermalink(raw, false);

/**
 * A cited link, checked by its kind's rule: a ticket's, a page's, or a tool
 * container's, which is checked as a ticket's (no query, no fragment).
 */
export function externalSourcePermalink(kind: unknown, raw: unknown): string | null {
  return kind === 'ticket' || kind === 'container' ? ticketPermalink(raw) : kind === 'page' ? pagePermalink(raw) : null;
}

/** A follow-up's id, in the API's own grammar. */
const ITEM_ID = /^itm_[A-Za-z0-9-]{4,60}$/;
/** A project's id, as the API writes one. */
const NOTICE_PROJECT_ID = /^prj_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
/** A name or a title a notification shows: as long as the API lets either be, in characters. */
export const NOTICE_TEXT_MAX = 200;
/** A notification's whole line: two titles or names and the words between them, in characters. */
const NOTICE_LINE_MAX = 2 * NOTICE_TEXT_MAX + 120;

/** The most follow-ups one notification counts, and opens. */
export const NOTICE_ITEMS_MAX = 100;

/** What a notification opens: one follow-up's page, a list of exactly the follow-ups it counted, or a project. */
export type NoticeTarget = { readonly kind: 'item'; readonly item_id: string } | { readonly kind: 'items'; readonly item_ids: readonly string[] }
  | { readonly kind: 'project'; readonly project_id: string };

/** One notification, as the page asks main to show it: one line ("Ana handed you Pricing page"), and what a click opens. */
export interface Notice {
  readonly text: string;
  readonly target: NoticeTarget;
}

/**
 * A notification as main shows it, or null for anything else: exactly a text
 * and a target, the text one non-empty line of at most NOTICE_LINE_MAX
 * characters, and the target an item, two to NOTICE_ITEMS_MAX distinct items,
 * or a project, by their ids.
 */
export function noticeOf(params: unknown): Notice | null {
  const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
  if (!record(params) || Object.keys(params).sort().join() !== 'target,text') return null;
  const { text, target } = params;
  if (typeof text !== 'string' || text.trim() === '' || [...text].length > NOTICE_LINE_MAX || /\p{Cc}/u.test(text) || !record(target)) return null;
  const keys = Object.keys(target).sort().join();
  const ids = target.item_ids;
  if (target.kind === 'items' && keys === 'item_ids,kind' && Array.isArray(ids) && ids.length >= 2 && ids.length <= NOTICE_ITEMS_MAX
      && ids.every(id => typeof id === 'string' && ITEM_ID.test(id)) && new Set(ids).size === ids.length) {
    return { text: text.trim(), target: { kind: 'items', item_ids: [...ids as string[]] } };
  }
  if (target.kind === 'item' && keys === 'item_id,kind' && typeof target.item_id === 'string' && ITEM_ID.test(target.item_id)) {
    return { text: text.trim(), target: { kind: 'item', item_id: target.item_id } };
  }
  if (target.kind === 'project' && keys === 'kind,project_id' && typeof target.project_id === 'string' && NOTICE_PROJECT_ID.test(target.project_id)) {
    return { text: text.trim(), target: { kind: 'project', project_id: target.project_id } };
  }
  return null;
}

/** The change check's areas, as desktop.log names them: known names only, each once, in the contract's order. */
export function changesLogLine(params: unknown): string | null {
  if (params === null || typeof params !== 'object' || Array.isArray(params)) return null;
  const { moved } = params as Record<string, unknown>;
  if (Object.keys(params).join() !== 'moved' || !Array.isArray(moved) || moved.length === 0) return null;
  const areas: readonly string[] = CHANGE_AREAS;
  if (!moved.every(area => typeof area === 'string' && areas.includes(area)) || new Set(moved).size !== moved.length) return null;
  return `changes moved ${areas.filter(area => moved.includes(area)).join(',')}`;
}

/** Parameters larger than this are refused at the broker. */
export const MAX_PARAMS_BYTES = 64 * 1024;
/** The most a call's parameters may take at the broker: a timeline put carries one whole answer, every other call MAX_PARAMS_BYTES. */
export function paramsLimit(method: string): number {
  return method === 'timeline.put' ? MAX_TIMELINE_PUT_BYTES : MAX_PARAMS_BYTES;
}
/** Deeper than any request's parameters: it bounds the walk, and ends a cycle a structured clone can carry. */
const MAX_PARAMS_DEPTH = 32;

/**
 * About the UTF-8 bytes `value` takes as JSON, or null when it is not plain
 * JSON data or takes more than `limit`. Only plain objects, arrays, strings,
 * finite numbers, booleans and null count: a Map, Set, Date or typed array
 * crosses IPC intact, where JSON would write `{}`. Undefined counts as null.
 */
export function plainJsonBytes(value: unknown, limit: number): number | null {
  const encoder = new TextEncoder();
  let total = 0;
  const add = (bytes: number): boolean => (total += bytes) <= limit;
  // Quotes, and at least a byte a UTF-16 unit before encoding it, so a long string is never encoded.
  const text = (node: string): boolean => add(2 + node.length) && add(encoder.encode(JSON.stringify(node)).length - 2 - node.length);
  const walk = (node: unknown, depth: number): boolean => {
    if (node === null || node === undefined) return add(4);
    if (typeof node === 'string') return text(node);
    if (typeof node === 'number') return Number.isFinite(node) && add(String(node).length);
    if (typeof node === 'boolean') return add(node ? 4 : 5);
    // A bigint, symbol or function, or nesting no request needs.
    if (typeof node !== 'object' || depth >= MAX_PARAMS_DEPTH) return false;
    if (Array.isArray(node)) {
      // Brackets and commas first: a sparse array's length alone can pass the limit.
      if (!add(2 + Math.max(0, node.length - 1))) return false;
      for (let index = 0; index < node.length; index += 1) if (!walk(node[index], depth + 1)) return false;
      return true;
    }
    const prototype = Object.getPrototypeOf(node) as unknown;
    if (prototype !== Object.prototype && prototype !== null) return false;
    const keys = Object.keys(node);
    // Braces, commas and colons.
    if (!add(2 + Math.max(0, keys.length - 1) + keys.length)) return false;
    for (const key of keys) if (!text(key) || !walk((node as Record<string, unknown>)[key], depth + 1)) return false;
    return true;
  };
  return walk(value, 0) ? total : null;
}

/**
 * A call no host answered. A write the host was holding may already have
 * reached the Authority; one no host took never left the machine.
 */
export function hostGoneFailure(code: 'host_restarted' | 'host_failed', write: boolean, requestId: unknown, taken: boolean): Failure {
  return {
    code, retryable: true,
    ...(write ? { mutation_outcome: taken ? 'unknown' as const : 'not_submitted' as const } : {}),
    ...(typeof requestId === 'string' ? { request_id: requestId } : {}),
  };
}

/** Chromium takes a switch after one dash or two. Release builds refuse every form of remote debugging. */
export function remoteDebuggingRequested(argv: readonly string[], hasSwitch: (name: string) => boolean): boolean {
  return ['remote-debugging-port', 'remote-debugging-pipe', 'remote-allow-origins'].some(name => hasSwitch(name)) ||
    argv.some(argument => /^--?remote-(debugging|allow-origins)/.test(argument));
}
