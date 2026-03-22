#!/usr/bin/env bash
set -euo pipefail

DEFAULT_HOST="127.0.0.1"
DEFAULT_PORT="5432"
DEFAULT_DB="postgres"
DEFAULT_USER="postgres"
DEFAULT_TABLE="senitel_bench_data"
DEFAULT_SELECT_QUERIES=100
DEFAULT_RATE_BURST=30
DEFAULT_RATE_EXPECT_BLOCKED=1
DEFAULT_SHARD_HOST=""
DEFAULT_SHARD_PORT="5432"

HOST="$DEFAULT_HOST"
PORT="$DEFAULT_PORT"
DB_NAME="$DEFAULT_DB"
DB_USER="$DEFAULT_USER"
DB_PASSWORD=""
TABLE_NAME="$DEFAULT_TABLE"
SELECT_QUERIES=$DEFAULT_SELECT_QUERIES
RATE_BURST=$DEFAULT_RATE_BURST
RATE_EXPECT_BLOCKED=$DEFAULT_RATE_EXPECT_BLOCKED
SHARD_HOST="$DEFAULT_SHARD_HOST"
SHARD_PORT="$DEFAULT_SHARD_PORT"
TARGETS=""
MODE="all"
NON_INTERACTIVE=0
REPORT_ONLY=0

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

declare -a REPORT_ROWS=()
SEED_OK=0

print_help() {
  cat <<USAGE
senitel-bench: Sentinel-only benchmark + safety test client

Usage:
  ./senitel-bench.sh [options]

Connection options:
  --host <ip-or-host>         Sentinel host            (default: $DEFAULT_HOST)
  --port <port>               Sentinel port            (default: $DEFAULT_PORT)
  --shard-host <ip-or-host>   Direct shard host for seed (bypasses Sentinel)
  --shard-port <port>         Direct shard port for seed (default: $DEFAULT_SHARD_PORT)
  --db <database>             Database name            (default: $DEFAULT_DB)
  --user <username>           Database user            (default: $DEFAULT_USER)
  --password <password>       Database password (or set PGPASSWORD env)
  --targets <h1:p1,h2:p2>     Sentinel endpoints for multi-shard test

Bench options:
  --table <name>              Bench table name         (default: $DEFAULT_TABLE)
  --select-queries <N>        SELECT benchmark count   (default: $DEFAULT_SELECT_QUERIES)
  --rate-burst <N>            Burst query count        (default: $DEFAULT_RATE_BURST)
  --rate-expect-blocked <N>   Min blocked expected     (default: $DEFAULT_RATE_EXPECT_BLOCKED)

Run mode:
  --mode <all|seed|select|block|rate|multi|report>
  --non-interactive           Do not prompt, fail if required values missing
  -h, --help                  Show this help

Examples:
  ./senitel-bench.sh --host 10.0.0.15 --port 5432 --shard-host db.supabase.co --shard-port 5432 --db postgres --user postgres --password secret --non-interactive
  ./senitel-bench.sh --mode select --select-queries 500 --host 34.x.x.x --port 5432
  ./senitel-bench.sh --targets 10.0.0.21:5432,10.0.0.22:5432 --mode multi
USAGE
}

color_status() {
  local status="$1"
  if [[ "$status" == "PASS" ]]; then
    printf "${GREEN}%s${NC}" "$status"
  elif [[ "$status" == "FAIL" ]]; then
    printf "${RED}%s${NC}" "$status"
  else
    printf "${YELLOW}%s${NC}" "$status"
  fi
}

add_report_row() {
  local test_name="$1"
  local status="$2"
  local details="$3"
  REPORT_ROWS+=("$test_name|$status|$details")
}

print_report() {
  echo
  echo "================== Senitel Bench Report =================="
  printf "%-22s | %-8s | %s\n" "Test" "Status" "Details"
  printf "%-22s-+-%-8s-+-%s\n" "----------------------" "--------" "-----------------------------------------------"
  for row in "${REPORT_ROWS[@]}"; do
    IFS='|' read -r test_name status details <<< "$row"
    local colored_status
    colored_status=$(color_status "$status")
    printf "%-22s | %-17b | %s\n" "$test_name" "$colored_status" "$details"
  done
  echo "=========================================================="
}

require_cmd() {
  local cmd="$1"
  if ! command -v "$cmd" >/dev/null 2>&1; then
    echo "Missing required command: $cmd"
    exit 1
  fi
}

parse_args() {
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --host)             HOST="$2";                  shift 2 ;;
      --port)             PORT="$2";                  shift 2 ;;
      --shard-host)       SHARD_HOST="$2";            shift 2 ;;
      --shard-port)       SHARD_PORT="$2";            shift 2 ;;
      --db)               DB_NAME="$2";               shift 2 ;;
      --user)             DB_USER="$2";               shift 2 ;;
      --password)         DB_PASSWORD="$2";           shift 2 ;;
      --table)            TABLE_NAME="$2";            shift 2 ;;
      --select-queries)   SELECT_QUERIES="$2";        shift 2 ;;
      --rate-burst)       RATE_BURST="$2";            shift 2 ;;
      --rate-expect-blocked) RATE_EXPECT_BLOCKED="$2"; shift 2 ;;
      --targets)          TARGETS="$2";               shift 2 ;;
      --mode)             MODE="$2";                  shift 2 ;;
      --non-interactive)  NON_INTERACTIVE=1;          shift ;;
      -h|--help)          print_help; exit 0 ;;
      *)
        echo "Unknown option: $1"
        print_help
        exit 1 ;;
    esac
  done
}

prompt_if_needed() {
  if [[ "$NON_INTERACTIVE" -eq 1 ]]; then
    return
  fi

  echo "Enter Sentinel connection details"

  read -r -p "Sentinel host [$HOST]: " input_host
  HOST="${input_host:-$HOST}"

  read -r -p "Sentinel port [$PORT]: " input_port
  PORT="${input_port:-$PORT}"

  read -r -p "DB name [$DB_NAME]: " input_db
  DB_NAME="${input_db:-$DB_NAME}"

  read -r -p "DB user [$DB_USER]: " input_user
  DB_USER="${input_user:-$DB_USER}"

  if [[ -z "$DB_PASSWORD" && -z "${PGPASSWORD:-}" ]]; then
    read -r -s -p "DB password (hidden, optional): " input_pw
    echo
    DB_PASSWORD="$input_pw"
  fi

  if [[ -z "$SHARD_HOST" ]]; then
    read -r -p "Direct shard host for seeding (leave blank to seed through Sentinel): " input_shard_host
    SHARD_HOST="${input_shard_host:-}"
  fi

  if [[ -n "$SHARD_HOST" ]]; then
    read -r -p "Direct shard port [$SHARD_PORT]: " input_shard_port
    SHARD_PORT="${input_shard_port:-$SHARD_PORT}"
  fi

  if [[ "$MODE" == "all" ]]; then
    echo
    echo "Run mode:"
    echo "  1) all tests"
    echo "  2) seed only"
    echo "  3) select only"
    echo "  4) block only"
    echo "  5) rate only"
    echo "  6) multi only"
    read -r -p "Choose [1]: " mode_choice
    case "${mode_choice:-1}" in
      1) MODE="all" ;;
      2) MODE="seed" ;;
      3) MODE="select" ;;
      4) MODE="block" ;;
      5) MODE="rate" ;;
      6) MODE="multi" ;;
      *) echo "Invalid, using all" ;;
    esac
  fi
}

# Build psql connection args for a given host/port
psql_exec() {
  local target_host="$1"
  local target_port="$2"
  local sql="$3"

  if [[ -n "$DB_PASSWORD" ]]; then
    PGPASSWORD="$DB_PASSWORD" psql \
      -h "$target_host" -p "$target_port" \
      -d "$DB_NAME" -U "$DB_USER" \
      -X -v ON_ERROR_STOP=1 -v VERBOSITY=verbose -At \
      -c "$sql"
  else
    psql \
      -h "$target_host" -p "$target_port" \
      -d "$DB_NAME" -U "$DB_USER" \
      -X -v ON_ERROR_STOP=1 -v VERBOSITY=verbose -At \
      -c "$sql"
  fi
}

psql_exec_file() {
  local target_host="$1"
  local target_port="$2"
  local file_path="$3"

  if [[ -n "$DB_PASSWORD" ]]; then
    PGPASSWORD="$DB_PASSWORD" psql \
      -h "$target_host" -p "$target_port" \
      -d "$DB_NAME" -U "$DB_USER" \
      -X -v VERBOSITY=verbose \
      -f "$file_path"
  else
    psql \
      -h "$target_host" -p "$target_port" \
      -d "$DB_NAME" -U "$DB_USER" \
      -X -v VERBOSITY=verbose \
      -f "$file_path"
  fi
}

extract_sqlstate() {
  local output="$1"
  # try "SQL state: XXXXX" format first, then "(SQLSTATE XXXXX)"
  local code
  code=$(printf "%s" "$output" | grep -oP '(?<=SQL state: )[0-9A-Z]{5}' | tail -n 1 || true)
  if [[ -z "$code" ]]; then
    code=$(printf "%s" "$output" | grep -oP '(?<=SQLSTATE )[0-9A-Z]{5}' | tail -n 1 || true)
  fi
  printf "%s" "$code"
}

# ── TESTS ──────────────────────────────────────────────────────────────────────

seed_test() {
  # Seed goes directly to shard if --shard-host is provided, otherwise through Sentinel
  local seed_host seed_port
  if [[ -n "$SHARD_HOST" ]]; then
    seed_host="$SHARD_HOST"
    seed_port="$SHARD_PORT"
    echo "[Seed] Inserting dummy data directly into shard ${seed_host}:${seed_port} (bypassing Sentinel)"
  else
    seed_host="$HOST"
    seed_port="$PORT"
    echo "[Seed] No --shard-host given, seeding through Sentinel ${seed_host}:${seed_port}"
  fi

  local seed_sql="
DROP TABLE IF EXISTS ${TABLE_NAME};
CREATE TABLE ${TABLE_NAME} (
  id         BIGSERIAL PRIMARY KEY,
  payload    TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
INSERT INTO ${TABLE_NAME}(payload)
SELECT 'dummy-' || g
FROM generate_series(1, 200) AS g;
"

  local out
  if out=$(psql_exec "$seed_host" "$seed_port" "$seed_sql" 2>&1); then
    local count
    count=$(psql_exec "$seed_host" "$seed_port" "SELECT count(*) FROM ${TABLE_NAME};" 2>/dev/null | tr -d '[:space:]' || echo "unknown")
    add_report_row "Seed" "PASS" "table=${TABLE_NAME}, rows=${count}, direct=${SHARD_HOST:-no}"
    SEED_OK=1
  else
    add_report_row "Seed" "FAIL" "${out//$'\n'/ }"
    SEED_OK=0
  fi
}

select_bench_test() {
  echo "[SELECT bench] Running ${SELECT_QUERIES} SELECT queries through Sentinel ${HOST}:${PORT}"

  local i=0
  local total_ms=0
  local min_ms=99999999
  local max_ms=0

  while [[ $i -lt $SELECT_QUERIES ]]; do
    local start_ms end_ms elapsed_ms
    start_ms=$(date +%s%3N)
    if ! psql_exec "$HOST" "$PORT" "SELECT count(*) FROM ${TABLE_NAME};" >/dev/null 2>&1; then
      add_report_row "SELECT bench" "FAIL" "Query failed at iteration $((i+1)). Run seed first."
      return
    fi
    end_ms=$(date +%s%3N)
    elapsed_ms=$((end_ms - start_ms))

    total_ms=$((total_ms + elapsed_ms))
    [[ $elapsed_ms -lt $min_ms ]] && min_ms=$elapsed_ms
    [[ $elapsed_ms -gt $max_ms ]] && max_ms=$elapsed_ms

    i=$((i + 1))
  done

  local avg_ms throughput_qps
  avg_ms=$((total_ms / SELECT_QUERIES))
  throughput_qps=$(awk -v n="$SELECT_QUERIES" -v ms="$total_ms" \
    'BEGIN { if (ms == 0) { print "inf" } else { printf "%.2f", (n*1000)/ms } }')

  add_report_row "SELECT bench" "PASS" \
    "n=${SELECT_QUERIES}, avg=${avg_ms}ms, min=${min_ms}ms, max=${max_ms}ms, throughput=${throughput_qps} qps"
}

block_test() {
  echo "[Block test] Verifying Sentinel blocks destructive statements"

  local failed=0
  local checked=0

  local -a statements=(
    "DROP TABLE IF EXISTS ${TABLE_NAME};"
    "TRUNCATE ${TABLE_NAME};"
    "DELETE FROM ${TABLE_NAME};"
    "ALTER TABLE ${TABLE_NAME} ADD COLUMN should_fail integer;"
    "DROP DATABASE postgres;"
  )

  # These should be ALLOWED — verify they are not incorrectly blocked
  local -a allowed_statements=(
    "SELECT count(*) FROM ${TABLE_NAME};"
    "DELETE FROM ${TABLE_NAME} WHERE id = 999999;"
  )

  echo "  Checking blocked statements..."
  for stmt in "${statements[@]}"; do
    checked=$((checked + 1))
    local out state
    if out=$(psql_exec "$HOST" "$PORT" "$stmt" 2>&1); then
      echo "  FAIL (not blocked): $stmt"
      failed=$((failed + 1))
    else
      state=$(extract_sqlstate "$out")
      if [[ "$state" == "42501" ]]; then
        echo "  OK (blocked 42501): ${stmt:0:60}"
      else
        echo "  FAIL (wrong error $state): ${stmt:0:60}"
        failed=$((failed + 1))
      fi
    fi
  done

  echo "  Checking allowed statements..."
  for stmt in "${allowed_statements[@]}"; do
    checked=$((checked + 1))
    local out
    if out=$(psql_exec "$HOST" "$PORT" "$stmt" 2>&1); then
      echo "  OK (allowed): ${stmt:0:60}"
    else
      echo "  FAIL (incorrectly blocked): ${stmt:0:60}"
      failed=$((failed + 1))
    fi
  done

  if [[ $failed -eq 0 ]]; then
    add_report_row "Block test" "PASS" "${checked}/${checked} statements behaved correctly"
  else
    add_report_row "Block test" "FAIL" "${failed}/${checked} statements behaved incorrectly"
  fi
}

rate_limit_test() {
  echo "[Rate limit] Bursting ${RATE_BURST} queries through Sentinel (expecting >=${RATE_EXPECT_BLOCKED} blocked)"

  local tmp_sql
  tmp_sql=$(mktemp)

  local i=0
  while [[ $i -lt $RATE_BURST ]]; do
    echo "SELECT 1;" >> "$tmp_sql"
    i=$((i + 1))
  done

  local out blocked=0
  out=$(psql_exec_file "$HOST" "$PORT" "$tmp_sql" 2>&1 || true)

  # grep for Sentinel rate limit error — no rg needed
  blocked=$(printf "%s" "$out" | grep -c "53400\|Rate limit exceeded\|slow down your query rate" || true)

  rm -f "$tmp_sql"

  if [[ "$blocked" -ge "$RATE_EXPECT_BLOCKED" ]]; then
    add_report_row "Rate limit" "PASS" "blocked=${blocked} (burst=${RATE_BURST})"
  else
    add_report_row "Rate limit" "FAIL" "blocked=${blocked} (expected >=${RATE_EXPECT_BLOCKED}, burst=${RATE_BURST})"
  fi
}

multi_shard_test() {
  echo "[Multi-shard] Running health query across all Sentinel endpoints"

  if [[ -z "$TARGETS" ]]; then
    add_report_row "Multi-shard" "WARN" "No --targets provided (format: h1:p1,h2:p2)"
    return
  fi

  local failures=0
  local checks=0

  IFS=',' read -r -a endpoint_list <<< "$TARGETS"
  for endpoint in "${endpoint_list[@]}"; do
    local eh ep
    eh="${endpoint%%:*}"
    ep="${endpoint##*:}"
    checks=$((checks + 1))

    local start_ms end_ms elapsed_ms
    start_ms=$(date +%s%3N)
    if psql_exec "$eh" "$ep" "SELECT count(*) FROM ${TABLE_NAME};" >/dev/null 2>&1; then
      end_ms=$(date +%s%3N)
      elapsed_ms=$((end_ms - start_ms))
      add_report_row "Shard $endpoint" "PASS" "latency=${elapsed_ms}ms"
    else
      failures=$((failures + 1))
      add_report_row "Shard $endpoint" "FAIL" "query failed"
    fi
  done

  if [[ $failures -eq 0 ]]; then
    add_report_row "Multi-shard" "PASS" "${checks}/${checks} shards responded"
  else
    add_report_row "Multi-shard" "FAIL" "${failures}/${checks} shards failed"
  fi
}

# ── MAIN ───────────────────────────────────────────────────────────────────────

run_suite() {
  case "$MODE" in
    all)
      seed_test
      select_bench_test
      block_test
      rate_limit_test
      multi_shard_test
      ;;
    seed)    seed_test ;;
    select)  select_bench_test ;;
    block)   block_test ;;
    rate)    rate_limit_test ;;
    multi)   multi_shard_test ;;
    report)
      REPORT_ONLY=1
      add_report_row "Report" "WARN" "No tests run in report-only mode"
      ;;
    *)
      echo "Invalid mode: $MODE"
      print_help
      exit 1 ;;
  esac
}

main() {
  require_cmd psql
  parse_args "$@"
  prompt_if_needed
  run_suite
  print_report

  if [[ "$REPORT_ONLY" -eq 0 ]]; then
    echo
    echo "Sentinel : ${HOST}:${PORT}"
    echo "Shard    : ${SHARD_HOST:-via Sentinel}:${SHARD_PORT}"
    echo "DB       : ${DB_NAME}, User: ${DB_USER}, Table: ${TABLE_NAME}"
  fi
}

main "$@"