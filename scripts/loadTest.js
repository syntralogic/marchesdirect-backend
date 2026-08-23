/**
 * scripts/loadTest.js
 *
 * Hits the search endpoint against a REAL, already-running instance of this
 * API (local, staging, or production) and reports latency/throughput.
 *
 * This is only useful once:
 *   1. The target instance is actually running (npm start / deployed), and
 *   2. scripts/generateSyntheticListings.js has populated it with the
 *      ~1,000,000-row test dataset the Technical Requirements ask for.
 *
 * It does not start a server or generate data itself - it is the measurement
 * step only, kept separate on purpose so dataset generation (slow, one-time)
 * and repeated performance runs (fast, iterative) aren't coupled together.
 *
 * Usage:
 *   BASE_URL=http://localhost:3000 npm run loadtest:run
 *   BASE_URL=https://api.yourdomain.fr npm run loadtest:run
 */

const autocannon = require("autocannon");

const BASE_URL = process.env.BASE_URL || "http://localhost:3000";
const DURATION_SEC = parseInt(process.env.LOADTEST_DURATION || "30", 10);
const CONNECTIONS = parseInt(process.env.LOADTEST_CONNECTIONS || "20", 10);

// A representative mix of the search route's real query patterns: plain
// listing, keyword search, trade filter, and a filtered+paginated combo -
// not just one best-case query.
const REQUESTS = [
  { method: "GET", path: "/api/opportunities?limit=20" },
  { method: "GET", path: "/api/opportunities?q=renovation&limit=20" },
  { method: "GET", path: "/api/opportunities?limit=20&offset=500" },
];

async function run() {
  console.log(`Load testing ${BASE_URL} for ${DURATION_SEC}s with ${CONNECTIONS} connections...`);
  console.log("Make sure scripts/generateSyntheticListings.js has already been run against this instance's database.");

  const result = await autocannon({
    url: BASE_URL,
    connections: CONNECTIONS,
    duration: DURATION_SEC,
    requests: REQUESTS,
  });

  console.log("\n=== Results ===");
  console.log(`Requests/sec: ${result.requests.average}`);
  console.log(`Latency p50: ${result.latency.p50}ms  p95: ${result.latency.p95}ms  p99: ${result.latency.p99}ms`);
  console.log(`2xx: ${result["2xx"]}  Errors: ${result.errors}  Timeouts: ${result.timeouts}`);

  if (result.errors > 0 || result.timeouts > 0) {
    console.log("\nNon-zero errors/timeouts - investigate before treating this run as a pass.");
    process.exitCode = 1;
  }
}

run().catch((err) => {
  console.error("Load test failed:", err.message);
  process.exitCode = 1;
});
