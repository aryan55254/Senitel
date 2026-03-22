/**
 * SentinelLogger
 * Rolling in-memory log of the last 1000 query decisions.
 * Each entry: timestamp, client addr, action, optional reason, query snippet.
 */
export interface LogEntry {
  ts: string;
  client: string;
  action: 'ALLOWED' | 'BLOCKED' | 'RATE_LIMITED';
  reason?: string;
  query: string;
}

export class SentinelLogger {
  private static readonly MAX_ENTRIES = 1000;
  private log: LogEntry[] = [];

  public record(entry: LogEntry) {
    if (this.log.length >= SentinelLogger.MAX_ENTRIES) {
      this.log.shift();
    }
    this.log.push(entry);
    const snippet = entry.query.slice(0, 80).replace(/\n/g, ' ');
    console.log(
      `[Sentinel] ${entry.ts} | ${entry.action.padEnd(12)} | ${entry.client} | ${snippet}`
    );
  }

  public getLog(): LogEntry[] {
    return [...this.log];
  }
}