/**
 * In-memory "needs reinstall" marks, keyed by the connection state hash under
 * which Slack kept rejecting the bot token. Nothing is persisted: a restart
 * forgets the marks, and the next rejected token marks the connection again.
 * A reconnect keeps the state hash, so a successful install calls `clear()`.
 */
export class SlackConnectionHealthV1 {
  private readonly needs_reinstall = new Set<string>();
  private cleared = 0;

  /** Taken before a read whose answer may mark the connection; see `markNeedsReinstall`. */
  generation(): number {
    return this.cleared;
  }

  /** A mark from a read that began before the latest `clear()` is dropped: that install proved the connection since. */
  markNeedsReinstall(stateSha256: string, generation: number = this.cleared): void {
    if (generation === this.cleared) this.needs_reinstall.add(stateSha256);
  }

  clear(): void {
    this.cleared += 1;
    this.needs_reinstall.clear();
  }

  needsReinstall(stateSha256: string | undefined): boolean {
    return stateSha256 !== undefined && this.needs_reinstall.has(stateSha256);
  }
}
