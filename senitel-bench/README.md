# senitel-bench

A Sentinel benchmark and guard validation CLI.

Seed connects directly to the shard. All other tests (SELECT, block, rate limit) go through Sentinel.

## What It Tests

- **Seed** — creates bench table + inserts 200 dummy rows directly into the shard (bypasses Sentinel)
- **SELECT bench** — runs N `SELECT` queries through Sentinel, measures avg/min/max latency + throughput
- **Block test** — sends `DROP`, `TRUNCATE`, unguarded `DELETE`, `ALTER TABLE` through Sentinel — expects `SQLSTATE 42501`. Also verifies safe queries are not incorrectly blocked.
- **Rate limit test** — bursts queries quickly through Sentinel, expects rate-limit blocks (`SQLSTATE 53400`)
- **Multi-shard test** — runs health check against multiple Sentinel endpoints via `--targets`

## Prerequisites

- `psql`

## Usage

Interactive (prompts for all values):
```bash
./senitel-bench.sh
```

Full suite non-interactive:
```bash
./senitel-bench.sh \
  --host <sentinel-ip> \
  --port 5432 \
  --shard-host <postgres-host> \
  --shard-port 5432 \
  --db postgres \
  --user postgres \
  --password <password> \
  --non-interactive
```

Single mode examples:
```bash
# SELECT benchmark only
./senitel-bench.sh --host 34.x.x.x --port 5432 --mode select --select-queries 500 --non-interactive

# Block test only
./senitel-bench.sh --host 34.x.x.x --port 5432 --mode block --non-interactive

# Multi-shard
./senitel-bench.sh --targets 10.0.0.15:5432,10.0.0.16:5432 --mode multi --non-interactive
```

## Defaults

| Option | Default |
|---|---|
| table | `senitel_bench_data` |
| select-queries | `100` |
| rate-burst | `30` |
| rate-expect-blocked | `1` |