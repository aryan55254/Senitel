# Senitel

A protocol-layer query firewall that intercepts PostgreSQL wire messages to enforce per-client rate limits and block destructive SQL patterns before they reach any Postgres instance.

Senitel sits between your clients and your Postgres instances. It speaks native PostgreSQL wire protocol — any client driver connects to it exactly as it would to a regular Postgres instance. Blocked queries receive a proper PG error response. Nothing reaches your instances that Sentinel does not allow through.

---

## Architecture
![Architecture](./public/image.png)

### Testing Environment
- **2 Backend PostgreSQL Databases** hosted in AWS (EC2/RDS).
- **Senitel Query Firewall** deployed on a centralized AWS EC2 instance inside the VPC.
- **Client Testing/Benchmarking** executed from a local desktop machine testing over the open internet.

**Connection plane** — maintains a warm pool of authenticated SSL connections per instance. Multiplexes thousands of client sessions concurrently across a limited pool of instance connections. Speaks raw PostgreSQL wire protocol on both sides via protocol decoder and encoder.

**Senitel firewall** — intercepts every `Query (Q)` message before it reaches an instance. Applies two checks per query:

1. **SQL Firewall** — Inspects SQL text via `QueryGuard`. Protects against accidental mass-deletions or drops.
2. **Query guard** — blocks `DROP`, `TRUNCATE`, `ALTER TABLE`, and unguarded `DELETE` (no WHERE clause). Returns `SQLSTATE 42501`. Safe queries pass through unchanged.

Blocked queries never reach any instance. The client driver receives a valid PG error frame and has no way to distinguish Sentinel from a native Postgres instance.

---

## What Senitel blocks

| Statement | Blocked |
|---|---|
| `DROP TABLE / DATABASE / INDEX / SCHEMA` | yes |
| `TRUNCATE` | yes |
| `ALTER TABLE` | yes |
| `DELETE FROM table` (no WHERE) | yes |
| `DELETE FROM table WHERE ...` | no |
| `SELECT`, `INSERT`, `UPDATE` | no |

---

## Benchmark Results

![Benchmark Results](./public/image%20copy.png)

The built-in benchmark suite evaluates:
1. **Allowed Protocol Queries**: Validates SSL Handshakes and startup sequence parsing.
2. **Sentinel Protocol Guard**: Validates that Senitel correctly intercepts and blocks SQL Injection patterns (DROP, TRUNCATE) by simulating proper ErrorFrames and synchronization bits.
3. **Pool Multiplexing & Latency**: Tests high-concurrency capability by firing 2,000 queries perfectly distributed globally across 20 concurrent connections in a `pg.Pool`, measuring the **average multiplexed proxy latency** per query (achieving ~14-15ms parsing latency across the stack).

---

## Prerequisites

- Node.js 18+
- `tsx` (installed automatically via npm)
- A host with SSL configured (see SSL section below)
- One or more Postgres instances reachable from the host

---

## Installation
```bash
git clone https://github.com/aryan55254/Senitel.git
cd Senitel
npm install
```

---

## Configuration

Copy the example config and fill in your instance details:
```bash
cp config_examples/sentinel.config.json sentinel.config.json
```

Edit `sentinel.config.json`:
```json
{
  "sentinel": {
    "port": 5432
  },
  "rateLimit": {
    "capacity": 20,
    "refillPerSec": 10
  },
  "instances": [
    {
      "id": "instance_01",
      "host": "your-instance-host",
      "port": 5432
    }
  ]
}
```

- `sentinel.port` — the port Sentinel listens on for incoming clients
- `rateLimit.capacity` — max burst queries per client before rate limiting kicks in
- `rateLimit.refillPerSec` — token refill rate per second per client
- `instances` — list of Postgres instances Sentinel will maintain connection pools to

---

## SSL

Senitel must be hosted on a machine with SSL certificates configured. Clients connect to Senitel over SSL and Senitel connects to your Postgres instances over SSL.

**You are responsible for provisioning and managing your own certificates.** Senitel reads `server-key.pem` and `server-cert.pem` from the project root. Place your certificates there before starting.

For a self-signed cert (testing only):
```bash
openssl req -x509 -newkey rsa:2048 \
  -keyout server-key.pem \
  -out server-cert.pem \
  -days 365 -nodes \
  -subj "/CN=localhost"
```

For production use certificates from your cloud provider or Let's Encrypt.

Your Postgres instances must also have SSL enabled. If you are using a managed Postgres service (Supabase, Cloud SQL, RDS) this is enabled by default.

---

## Running
```bash
npx tsx src/connection_plane/server/SenitelServer.ts
```

Senitel will initialize pools for each instance and start listening:
```
[Sentinel] Pool initialized → instance_01 at 13.201.34.134:5432
[Sentinel] Listening on port 5432
[Sentinel] Guarding 1 instance(s)
```

---

## Connecting a client

You can verify Senitel is working by running the built-in benchmark and security suite!

```bash
node test-senitel-connection.js
```

Or connect via the standard Node.js `pg` driver using a standard connection string:
```javascript
const { Client } = require('pg');

const SENITEL_PROXY_URL = `postgres://user:password@<your-aws-senitel-ip>:5432/dbname`;

const client = new Client({ 
    connectionString: SENITEL_PROXY_URL, 
    ssl: { rejectUnauthorized: false } 
});

await client.connect();
const res = await client.query('SELECT 1 as success_ping;');
console.log(res.rows);
await client.end();
```

The client driver has absolutely no knowledge it is talking to Senitel rather than a direct native Postgres instance.