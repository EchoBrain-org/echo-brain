// Stroke icons drawn to the canvas design. Every one paints in the colour of
// the text around it (currentColor), so each appearance colours them through
// styles.css; the few that carry a meaning of their own take it from a class.
export const Plus = () => (
  <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true"><path d="M7 2v10M2 7h10" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" fill="none" /></svg>
);
export const Up = () => (
  <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true"><path d="M7 11.5v-9M3.5 6 7 2.5 10.5 6" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" fill="none" /></svg>
);
export const Back = () => (
  <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"><path d="M7.5 2 3.5 6l4 4" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" fill="none" /></svg>
);
export const Close = () => (
  <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><path d="M1.5 1.5l7 7M8.5 1.5l-7 7" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" fill="none" /></svg>
);
export const Clip = () => (
  <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><path d="M12 6.5 6.5 12a2.6 2.6 0 0 1-3.7-3.7l6.4-6.4a3.7 3.7 0 0 1 5.2 5.2L8 13.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" fill="none" /></svg>
);
/** Done, in the colour of the text around it. */
export const Check = () => (
  <svg width="13" height="13" viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" fill="none" /></svg>
);
/** Something went well: a check in the done colour. */
export const Saved = () => (
  <svg class="mark-ok" width="14" height="14" viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" fill="none" /></svg>
);
export const Note = () => (
  <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true"><path d="M2 3.5h10M2 7h10M2 10.5h6" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" /></svg>
);
export const Lock = () => (
  <svg width="11" height="12" viewBox="0 0 11 12" aria-hidden="true"><rect x="1" y="5" width="9" height="6.5" rx="1.5" stroke="currentColor" stroke-width="1.3" fill="none" /><path d="M3 5V3.5a2.5 2.5 0 0 1 5 0V5" stroke="currentColor" stroke-width="1.3" fill="none" /></svg>
);
export const Globe = () => (
  <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"><circle cx="6" cy="6" r="5" stroke="currentColor" stroke-width="1.2" fill="none" /><path d="M1 6h10M6 1c1.6 1.4 2.4 3.1 2.4 5S7.6 9.6 6 11M6 1C4.4 2.4 3.6 4.1 3.6 6S4.4 9.6 6 11" stroke="currentColor" stroke-width="1.1" fill="none" /></svg>
);
export const Capture = () => (
  <svg width="15" height="15" viewBox="0 0 24 24" aria-hidden="true"><rect x="4" y="4" width="16" height="16" rx="4" stroke="currentColor" stroke-width="1.6" fill="none" /><path d="M12 8v8M8 12h8" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" fill="none" /></svg>
);
export const SidebarIcon = () => (
  <svg width="15" height="15" viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="3" stroke="currentColor" stroke-width="1.6" fill="none" /><path d="M9 4v16" stroke="currentColor" stroke-width="1.6" fill="none" /></svg>
);
export const Person = () => (
  <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"><circle cx="6" cy="4" r="2.3" fill="currentColor" /><path d="M1.8 11c.5-2.4 2.2-3.6 4.2-3.6s3.7 1.2 4.2 3.6z" fill="currentColor" /></svg>
);
export const Doc = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" aria-hidden="true"><path d="M7 3h7l4 4v14H7zM14 3v4h4" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" fill="none" /></svg>
);
export const People = () => (
  <svg width="16" height="14" viewBox="0 0 16 14" aria-hidden="true"><circle cx="5.5" cy="4.5" r="2.4" stroke="currentColor" stroke-width="1.3" fill="none" /><path d="M1 12.5c.4-2.4 2.2-3.6 4.5-3.6s4.1 1.2 4.5 3.6" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" fill="none" /><circle cx="11.3" cy="4.8" r="2" stroke="currentColor" stroke-width="1.2" fill="none" /><path d="M11.6 8.9c1.8.1 3 1.2 3.4 3.3" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" fill="none" /></svg>
);
export const Ellipsis = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" aria-hidden="true"><circle cx="6" cy="12" r="1.2" fill="currentColor" stroke="currentColor" stroke-width="1" /><circle cx="12" cy="12" r="1.2" fill="currentColor" stroke="currentColor" stroke-width="1" /><circle cx="18" cy="12" r="1.2" fill="currentColor" stroke="currentColor" stroke-width="1" /></svg>
);
export const Chevron = () => (
  <svg width="12" height="12" viewBox="0 0 24 24" aria-hidden="true"><path d="M9 5l7 7-7 7" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" fill="none" /></svg>
);
/** Opens a list: in the colour of the text around it. */
export const Caret = () => (
  <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><path d="M2 3.5 5 6.5l3-3" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" fill="none" /></svg>
);
/** Something needs another look: a triangle in the danger colour. */
export const Warning = () => (
  <svg class="mark-warn" width="14" height="14" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 4 2.8 19.5h18.4z" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" fill="none" /><path d="M12 10v4.5M12 17.2v.3" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" /></svg>
);
/** Mine: one person, in outline. */
export const OnePerson = () => (
  <svg width="15" height="15" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="8.5" r="3.5" stroke="currentColor" stroke-width="1.6" fill="none" /><path d="M5 19.5c.9-3.4 3.6-5.2 7-5.2s6.1 1.8 7 5.2" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" fill="none" /></svg>
);
/** Follow-ups: a short list, each line ticked. */
export const Ticks = () => (
  <svg width="15" height="15" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 6.5l1.6 1.6L8.6 5M4 12.5l1.6 1.6L8.6 11M4 18.5l1.6 1.6L8.6 17M12 7h8M12 13h8M12 19h8" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" fill="none" /></svg>
);
/** An approved meeting's row. */
export const Calendar = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" aria-hidden="true"><rect x="3.5" y="5" width="17" height="15.5" rx="3" stroke="currentColor" stroke-width="2.2" fill="none" /><path d="M3.5 10.5h17M8.5 2.8v4.2M15.5 2.8v4.2" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" fill="none" /></svg>
);
/** A document's row. */
export const Page = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" aria-hidden="true"><path d="M7 3h7l4 4v14H7zM14 3v4h4" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" fill="none" /></svg>
);
/** A project, in ECHO or in a tool (a Jira project, a Confluence space): a folder, in outline. */
export const Folder = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" aria-hidden="true"><path d="M3.5 6.5a1.5 1.5 0 0 1 1.5-1.5h4.2l2 2.2H19a1.5 1.5 0 0 1 1.5 1.5v9.3a1.5 1.5 0 0 1-1.5 1.5H5a1.5 1.5 0 0 1-1.5-1.5z" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round" fill="none" /></svg>
);
export const Meeting = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" aria-hidden="true"><rect x="4" y="5" width="16" height="15" rx="2.5" stroke="currentColor" stroke-width="1.6" fill="none" /><path d="M4 10h16M9 3v4M15 3v4" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" fill="none" /></svg>
);
/** Tools: a plug, in the sidebar's outline. */
export const Plug = () => (
  <svg width="15" height="15" viewBox="0 0 24 24" aria-hidden="true"><path d="M9 3.5v4.5M15 3.5v4.5M6 8h12v3.5a6 6 0 0 1-12 0zM12 17.5v3" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" fill="none" /></svg>
);
export const Home = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 11l8-7 8 7v9a1 1 0 0 1-1 1h-5v-6h-4v6H5a1 1 0 0 1-1-1z" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" fill="none" /></svg>
);

/** ECHO's mark: a signal and what comes back from it. Its centre takes the signal colour. */
export const EchoMark = () => (
  <svg class="echo-mark" width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><circle class="core" cx="8" cy="8" r="2.3" /><circle cx="8" cy="8" r="4.9" fill="none" stroke="currentColor" stroke-width="1.3" opacity="0.6" /><circle cx="8" cy="8" r="7.2" fill="none" stroke="currentColor" stroke-width="1.1" opacity="0.28" /></svg>
);
/** An empty Home: the same rings, quiet, with nothing at their centre waiting. */
export const EchoRings = () => (
  <svg class="echo-rings" width="96" height="96" viewBox="0 0 96 96" aria-hidden="true"><circle cx="48" cy="48" r="46" fill="none" stroke="currentColor" stroke-width="1" opacity="0.14" /><circle cx="48" cy="48" r="34" fill="none" stroke="currentColor" stroke-width="1.2" opacity="0.26" /><circle cx="48" cy="48" r="22" fill="none" stroke="currentColor" stroke-width="1.4" opacity="0.45" /><circle cx="48" cy="48" r="6" fill="currentColor" /></svg>
);

/**
 * What a Home row asks of you, as a shape beside its verb, so the kinds tell
 * apart by more than colour: a decision (diamond) to approve, follow-ups to
 * send (arrow), a document to update (arrows round), one to review (eye), a
 * check to retry (alert), and one still checking (a ring).
 */
export const KindMark = ({ kind }: { kind: 'approve' | 'send' | 'update' | 'review' | 'failed' | 'checking' }) => {
  switch (kind) {
    case 'approve': return <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"><path d="M6 .9 11.1 6 6 11.1.9 6z" fill="currentColor" /></svg>;
    case 'send': return <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true"><path d="M4 10 10 4M5 4h5v5" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" fill="none" /></svg>;
    case 'update': return <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true"><path d="M11.6 6.2A4.7 4.7 0 0 0 3 4.4M2.4 7.8A4.7 4.7 0 0 0 11 9.6M3 1.9v2.6h2.6M11 12.1V9.5H8.4" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" fill="none" /></svg>;
    case 'review': return <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true"><path d="M1.2 7S3.3 3 7 3s5.8 4 5.8 4-2.1 4-5.8 4S1.2 7 1.2 7z" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round" fill="none" /><circle cx="7" cy="7" r="1.8" stroke="currentColor" stroke-width="1.5" fill="none" /></svg>;
    case 'failed': return <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true"><circle cx="7" cy="7" r="5.6" stroke="currentColor" stroke-width="1.5" fill="none" /><path d="M7 4.2v3.4M7 9.6v.2" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" /></svg>;
    case 'checking': return <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"><circle cx="6" cy="6" r="4.4" stroke="currentColor" stroke-width="1.5" fill="none" /></svg>;
  }
};
