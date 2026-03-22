/**
 * QueryGuard
 * Scans raw SQL text for dangerous patterns.
 * Returns null if safe, or a rejection reason if blocked.
 *
 * Blocked:
 *  - DROP TABLE / DROP DATABASE / DROP INDEX / DROP SCHEMA
 *  - TRUNCATE
 *  - DELETE without a WHERE clause
 *  - ALTER TABLE
 */
export class QueryGuard {
  private static readonly RULES: [RegExp, string, string][] = [
    [
      /^\s*drop\s+(table|database|index|schema)\b/i,
      'DROP statements are blocked by Sentinel',
      '42501',
    ],
    [
      /^\s*truncate\b/i,
      'TRUNCATE is blocked by Sentinel',
      '42501',
    ],
    [
      /^\s*alter\s+table\b/i,
      'ALTER TABLE is blocked by Sentinel',
      '42501',
    ],
    [
      /^\s*delete\s+from\b(?![\s\S]*\bwhere\b)/i,
      'Unguarded DELETE (no WHERE clause) is blocked by Sentinel',
      '42501',
    ],
  ];

  public static inspect(sql: string): { reason: string; sqlstate: string } | null {
    for (const [pattern, reason, sqlstate] of this.RULES) {
      if (pattern.test(sql)) {
        return { reason, sqlstate };
      }
    }
    return null;
  }
}