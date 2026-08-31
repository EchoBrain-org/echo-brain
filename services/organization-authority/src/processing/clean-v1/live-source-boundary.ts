/**
 * Provider facts the clean live runtime needs after a meeting source has been
 * admitted. The source adapter id remains persisted data; this boundary owns
 * the provider-specific cursor syntax used to reopen that admission safely.
 */
export interface CleanLiveSourceBoundaryV1 {
  readonly source_adapter_id: string;
  /** Rejects cursors that are not safe for this provider's live-only stream. */
  assert_live_cursor(cursor: string): void;
}
