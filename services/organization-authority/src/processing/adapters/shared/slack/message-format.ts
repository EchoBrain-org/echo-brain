const MAX_SUMMARY_ITEMS = 10;
const MAX_ITEM_CHARS = 240;
const SLACK_SECTION_MAX_CHARS = 3_000;

/** Truncate by Unicode code point so Slack limits do not split surrogate pairs. */
export function truncateSlackText(value: string, maximum: number): string {
  const characters = [...value];
  return characters.length <= maximum
    ? value
    : `${characters.slice(0, maximum - 1).join('')}…`;
}

export function boundedSlackLine(value: string, maximum: number): string {
  return truncateSlackText(value.replace(/\s+/g, ' ').trim(), maximum);
}

export function escapeSlackControlText(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

export function slackSummaryText(
  label: string,
  statements: readonly string[],
): string | undefined {
  if (statements.length === 0) return undefined;
  const shown = statements.slice(0, MAX_SUMMARY_ITEMS);
  const lines = [
    `${label}:`,
    ...shown.map(
      (statement) => `• ${boundedSlackLine(statement, MAX_ITEM_CHARS)}`,
    ),
  ];
  if (statements.length > shown.length) {
    lines.push(`… and ${statements.length - shown.length} more`);
  }
  return truncateSlackText(lines.join('\n'), SLACK_SECTION_MAX_CHARS);
}
