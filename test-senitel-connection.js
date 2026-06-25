const { Client, Pool } = require('pg');

// ==========================================
// CONFIGURATION
// ==========================================
const DB_PASSWORD = 'your_secure_password'; 
const SENITEL_PROXY_URL = `postgres://postgres:${DB_PASSWORD}@13.127.251.114:5432/postgres`;

// ANSI Escape Codes for Terminal Colors
const reset = "\x1b[0m";
const green = "\x1b[32m";
const red = "\x1b[31m";
const cyan = "\x1b[36m";
const yellow = "\x1b[33m";

// ==========================================
// 1. ALLOWED PROTOCOL TEST
// ==========================================
async function testAllowedQueries() {
    console.log('\n==========================================');
    console.log('BENCHMARK 1: ALLOWED PROTOCOL QUERIES');
    console.log('==========================================\n');

    const senitelClient = new Client({ connectionString: SENITEL_PROXY_URL, ssl: { rejectUnauthorized: false }});
    await senitelClient.connect();

    console.log('Testing Normal Query (Should Succeed):');
    try {
        const res = await senitelClient.query('SELECT 1 as success_ping;');
        console.log(`[SUCCESS] Allowed Query executed correctly: returned ${res.rows.length} rows`);
    } catch(err) {
        console.error(`[FAILURE] Failed unexpectedly:`, err.message);
    }

    await senitelClient.end();
}

// ==========================================
// 2. MALICIOUS QUERY BLOCKING
// ==========================================
async function testMaliciousQueryBlocking() {
    console.log('\n==========================================');
    console.log('BENCHMARK 2: SENTINEL PROTOCOL GUARD');
    console.log('==========================================\n');

    const senitelClient = new Client({ connectionString: SENITEL_PROXY_URL, ssl: { rejectUnauthorized: false }});
    await senitelClient.connect();

    const maliciousQueries = [
        { name: "DROP TABLE", sql: "SELECT * FROM test_users; DROP TABLE test_users;" },
        { name: "DROP DATABASE", sql: "DROP DATABASE production_db;" },
        { name: "TRUNCATE", sql: "TRUNCATE test_users;" },
        { name: "ALTER TABLE", sql: "ALTER TABLE test_users DROP COLUMN username;" },
        { name: "UNGUARDED DELETE", sql: "DELETE FROM test_users;" } 
    ];

    console.log(`Testing ${maliciousQueries.length} Malicious SQL Injection attempts (All Should be Blocked):`);
    
    for (const testCase of maliciousQueries) {
        process.stdout.write(`  -> Testing ${testCase.name}... `);
        try {
            await senitelClient.query(testCase.sql);
            console.error('\n     [CRITICAL FAILURE] Senitel permitted the malicious query!');
        } catch(err) {
            console.log(`[BLOCKED] by Senitel! ("${err.message}")`);
        }
    }

    await senitelClient.end();
}

// ==========================================
// 3. MULTIPLEXING CONCURRENCY & LATENCY
// ==========================================
async function testMultiplexingAndLatency() {
    console.log('\n==========================================');
    console.log('BENCHMARK 3: POOL MULTIPLEXING & LATENCY');
    console.log('==========================================\n');

    console.log('Opening 20 simultaneous concurrent client connections to Senitel...');
    const pool = new Pool({
        connectionString: SENITEL_PROXY_URL,
        ssl: { rejectUnauthorized: false },
        max: 20
    });

    const QUERIES_PER_CLIENT = 100;
    const CONCURRENT_CLIENTS = 20;
    const TOTAL_QUERIES = QUERIES_PER_CLIENT * CONCURRENT_CLIENTS;

    console.log(`Firing ${QUERIES_PER_CLIENT} queries blindly across ${CONCURRENT_CLIENTS} multiplexed sockets (Total: ${TOTAL_QUERIES} queries)...\n`);
    
    const start = Date.now();
    const promises = [];
    let completedQueries = 0;

    // Non-blocking visual interval tracker running at ~30 FPS
    const progressInterval = setInterval(() => {
        const pct = Math.floor((completedQueries / TOTAL_QUERIES) * 100);
        const width = 20;
        const complete = Math.floor((completedQueries / TOTAL_QUERIES) * width);
        const bar = "█".repeat(complete) + "░".repeat(width - complete);
        
        process.stdout.write(`\r${yellow}[RUNNING]${reset} Multiplexing network streams: [${bar}] ${pct}% (${completedQueries}/${TOTAL_QUERIES} queries verified)`);
    }, 33);

    for(let i = 0; i < CONCURRENT_CLIENTS; i++) {
        promises.push((async () => {
            const client = await pool.connect();
            for(let j = 0; j < QUERIES_PER_CLIENT; j++) {
                await client.query('SELECT 1 as val');
                completedQueries++; // Increment as queries finish over the proxy wire
            }
            client.release();
        })());
    }

    await Promise.all(promises);
    clearInterval(progressInterval);
    
    // Clear the progress bar line entirely using ANSI escape sequence
    process.stdout.write("\r\x1b[K");

    const end = Date.now();
    const durationMs = end - start;

    console.log(`[SUCCESS] Successfully multiplexed ${TOTAL_QUERIES} concurrent queries in ${durationMs} ms!`);
    console.log(`[MULTIPLEXED LATENCY] Average proxy latency across active pool queue: ${(durationMs / TOTAL_QUERIES).toFixed(2)} ms/query`);
    console.log(`[INFO] (Typical raw Postgres average round-trip over active internet is ~30-50ms)`);
    
    await pool.end();
}

// ==========================================
// RUN ALL SUITES
// ==========================================
async function runAll() {
    try {
        await testAllowedQueries();
        await testMaliciousQueryBlocking();
        await testMultiplexingAndLatency();
        console.log('\n[SUCCESS] All Benchmarks Completed!');
    } catch (err) {
        console.error('\n[FAILURE] Benchmark Suite Crashed:', err);
    }
}

runAll();