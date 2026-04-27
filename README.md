# Senitel

A protocol-layer query firewall that intercepts PostgreSQL wire messages to block destructive SQL patterns before they reach any Postgres instance.

Senitel sits between your clients and your Postgres instances. It speaks native PostgreSQL wire protocol , any client driver connects to it exactly as it would to a regular Postgres instance. Blocked queries receive a proper PG error response. Nothing reaches your instances that Sentinel does not allow through.

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
3. **Pool Multiplexing & Latency**: Tests high-concurrency capability by firing 2,000 queries multiplexed efficiently across 20 concurrent connections in a `pg.Pool`, measuring the **average multiplexed proxy latency** per query (achieving ~14-15ms parsing latency across the stack).

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

Copy the example configuration file and fill in your specific PostgreSQL instance details:

```bash
cp config_examples/example.config.json sentinel.config.json
```

### `sentinel.config.json` Structure
Edit the file to include your database credentials and host information:

```json
{
  "sentinel": {
    "port": 5432
  },
  "instances": [
    {
      "id": "instance_01",
      "host": "192.168.1.10",
      "port": 5432,
      "user": "postgres",
      "password": "password",
      "database": "postgres"
    },
    {
      "id": "instance_02",
      "host": "192.168.1.11",
      "port": 5432,
      "user": "postgres",
      "password": "password",
      "database": "postgres"
    }
  ]
}
```

### Field Definitions
* **`sentinel.port`**: The local port Sentinel listens on for incoming client connections.
* **`instances`**: An array of backend PostgreSQL targets.
    * **`id`**: A unique identifier for the instance used in Sentinel's internal logs.
    * **`host` / `port`**: The network address of the destination Postgres server.
    * **`user` / `password` / `database`**: Credentials used by the Connection Plane to maintain the warm connection pool.

---

## SSL

Sentinel requires SSL certificates to be present in the project root. Since Sentinel acts as a "Man-in-the-Middle" security layer, it must encrypt traffic between itself and the client, as well as between itself and the backend instances.

**Certificate Requirements:**
1. Place `server-key.pem` and `server-cert.pem` in the project root directory.
2. For local testing, you can generate a self-signed certificate using OpenSSL:

```bash
openssl req -x509 -newkey rsa:2048 \
  -keyout server-key.pem \
  -out server-cert.pem \
  -days 365 -nodes \
  -subj "/CN=localhost"
```

> **Note:** Ensure your backend Postgres instances (RDS, Supabase, etc.) are configured to allow SSL connections, as Sentinel will attempt to upgrade all backend pool connections to SSL by default.

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
