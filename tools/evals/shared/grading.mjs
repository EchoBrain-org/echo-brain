/**
 * What the Ask writer gate's graders (ask-blocks: grade.mjs and wording.mjs) share: the kinds of item a case may hold,
 * and the words they read. Nothing here imports the code a grader grades.
 */

/** The kinds of item a case may hold. */
export const ITEM_KINDS = new Set(["follow_up", "decision", "ticket"]);

/**
 * A text's words, lower case: runs of letters and digits, joined across an inner hyphen, dot, underscore or apostrophe,
 * so an identifier ("clean-v1-20261026-ask-timeline-aa79d90"), a date and "it's" are one word each, and quotes and
 * punctuation are not words. Any other value is read as its string.
 */
export function words(text) {
  return String(text).normalize("NFC").toLocaleLowerCase("en-US").match(/[\p{L}\p{N}]+(?:['’._-][\p{L}\p{N}]+)*/gu) ?? [];
}
/** Where `phrase` first appears in `text`, as a run of whole words, or -1. */
export function wordIndex(text, phrase) {
  const [haystack, needle] = [words(text), words(phrase)];
  if (needle.length === 0) return -1;
  return haystack.findIndex((_, at) => needle.every((word, offset) => haystack[at + offset] === word));
}
/** Whether `phrase` is a run of whole words in `text`. */
export const says = (text, phrase) => wordIndex(text, phrase) >= 0;
/** Whether `value` is a list of strings, none of them blank. */
export const nonEmptyStrings = (value) => Array.isArray(value) && value.every((entry) => typeof entry === "string" && entry.trim() !== "");
