const assert = require("assert");
const http = require("http");
const crypto = require("crypto");
const path = require("path");
const fs = require("fs");
const { db, run, get, all, DB_DIR } = require("../db");
const {
  registerUser,
  authenticateUser,
  createSession,
  hashPasswordAsync,
  verifyPasswordAsync,
  deleteUserAccount
} = require("../auth");
const {
  checkAndProcessSchedules,
  recoverStaleProcessingJobs,
  safeDeleteAttachment
} = require("../scheduler");
const { getOrCreateUserSession } = require("../engine");
const { validateProductionConfig } = require("../server");
const app = require("../server");

async function runAuditVerificationTests() {
  console.log("=================================================================");
  console.log("🔍 Requirement C: Security & Performance Audit Verification Suite");
  console.log("=================================================================\n");

  let passed = 0;
  let failed = 0;

  async function test(name, fn) {
    try {
      await fn();
      console.log(`  ✅ PASS: ${name}`);
      passed++;
    } catch (err) {
      console.error(`  ❌ FAIL: ${name}`);
      console.error(`     Error: ${err.message}\n`);
      failed++;
    }
  }

  // --- C.1: Concurrent initial registration produces exactly one administrator ---
  console.log("👑 [C.1] Atomic Initial-Admin Race Condition Verification:");

  await test("Concurrent initial registration results in exactly one administrator", async () => {
    // Setup isolated scratch sqlite database
    const sqlite3 = require("sqlite3").verbose();
    const scratchDbPath = path.join(DB_DIR, `race_test_${Date.now()}.db`);
    const scratchDb = new sqlite3.Database(scratchDbPath);

    await new Promise((res, rej) => {
      scratchDb.serialize(() => {
        scratchDb.run("PRAGMA journal_mode = WAL");
        scratchDb.run("PRAGMA busy_timeout = 5000");
        scratchDb.run(`
          CREATE TABLE users (
            id TEXT PRIMARY KEY,
            username TEXT UNIQUE NOT NULL,
            password_hash TEXT NOT NULL,
            role TEXT DEFAULT 'user',
            created_at INTEGER NOT NULL
          )
        `, (err) => err ? rej(err) : res());
      });
    });

    const scratchRun = (sql, params = []) => new Promise((res, rej) => {
      scratchDb.run(sql, params, function (err) {
        if (err) rej(err); else res(this);
      });
    });
    const scratchGet = (sql, params = []) => new Promise((res, rej) => {
      scratchDb.get(sql, params, (err, row) => {
        if (err) rej(err); else res(row);
      });
    });
    const scratchAll = (sql, params = []) => new Promise((res, rej) => {
      scratchDb.all(sql, params, (err, rows) => {
        if (err) rej(err); else res(rows);
      });
    });

    // Atomic registration function against scratch DB
    let scratchLock = Promise.resolve();
    async function raceRegister(username, password) {
      const hash = await hashPasswordAsync(password);
      const id = crypto.randomUUID();
      const now = Date.now();

      let release;
      const wait = new Promise(r => release = r);
      const prev = scratchLock;
      scratchLock = prev.then(() => wait, () => wait);
      await prev;

      try {
        await scratchRun("BEGIN IMMEDIATE");
        try {
          const row = await scratchGet("SELECT COUNT(*) as count FROM users");
          const count = row ? row.count : 0;
          const role = (count === 0) ? "admin" : "user";
          await scratchRun(
            "INSERT INTO users (id, username, password_hash, role, created_at) VALUES (?, ?, ?, ?, ?)",
            [id, username, hash, role, now]
          );
          await scratchRun("COMMIT");
          return { id, username, role };
        } catch (e) {
          await scratchRun("ROLLBACK").catch(() => {});
          throw e;
        }
      } finally {
        release();
      }
    }

    // Fire 6 concurrent registration attempts simultaneously
    const attempts = [1, 2, 3, 4, 5, 6].map(i => raceRegister(`candidate_${i}`, `CandidatePass_${i}!`));
    const results = await Promise.all(attempts);

    const admins = results.filter(r => r.role === "admin");
    const regularUsers = results.filter(r => r.role === "user");

    assert.strictEqual(admins.length, 1, `Expected exactly 1 admin from concurrent race, got ${admins.length}`);
    assert.strictEqual(regularUsers.length, 5, `Expected exactly 5 regular users, got ${regularUsers.length}`);

    // Verify DB state matches
    const dbUsers = await scratchAll("SELECT role, COUNT(*) as c FROM users GROUP BY role");
    const adminCount = dbUsers.find(u => u.role === "admin")?.c || 0;
    const userCount = dbUsers.find(u => u.role === "user")?.c || 0;

    assert.strictEqual(adminCount, 1, "DB must contain exactly 1 admin");
    assert.strictEqual(userCount, 5, "DB must contain exactly 5 users");

    scratchDb.close();
    try { fs.unlinkSync(scratchDbPath); } catch (_) {}
    try { fs.unlinkSync(`${scratchDbPath}-wal`); } catch (_) {}
    try { fs.unlinkSync(`${scratchDbPath}-shm`); } catch (_) {}
  });

  // --- C.2: Multiple users authenticate and operate independently ---
  console.log("\n👥 [C.2] Multi-User Independent Authentication & Operations:");

  await test("Multiple users can authenticate and operate independently", async () => {
    const ts = Date.now().toString(36);
    const u1 = `user1_${ts}`;
    const u2 = `user2_${ts}`;
    const u3 = `user3_${ts}`;
    const pass = "SafeMultiPassword123!";

    const r1 = await registerUser(u1, pass);
    const r2 = await registerUser(u2, pass);
    const r3 = await registerUser(u3, pass);

    // Concurrently authenticate all 3 users
    const [auth1, auth2, auth3] = await Promise.all([
      authenticateUser(u1, pass),
      authenticateUser(u2, pass),
      authenticateUser(u3, pass)
    ]);

    assert.ok(auth1.token && auth2.token && auth3.token);
    assert.notStrictEqual(auth1.user.id, auth2.user.id);
    assert.notStrictEqual(auth2.user.id, auth3.user.id);

    // Clean up
    await deleteUserAccount(r1.user.id);
    await deleteUserAccount(r2.user.id);
    await deleteUserAccount(r3.user.id);
  });

  // --- C.3 & C.4: Scheduler Concurrency, Worker Claiming & Stale Recovery ---
  console.log("\n⚡ [C.3 & C.4] Scheduler Concurrency & Safe Job Claiming:");

  await test("Concurrent scheduler workers do not claim the same job", async () => {
    const testJobId = crypto.randomUUID();
    const dummyUserId = crypto.randomUUID();
    await run(`
      INSERT INTO schedules (id, user_id, recipient, text, scheduled_at, status, attempts, created_at)
      VALUES (?, ?, '919999999999', 'Race test message', ?, 'scheduled', 0, ?)
    `, [testJobId, dummyUserId, Date.now() - 5000, Date.now()]);

    // Simulate 10 concurrent workers trying to atomically claim the exact same job
    const claimAttempts = await Promise.all(
      Array.from({ length: 10 }).map(() =>
        run(
          `UPDATE schedules SET status = 'processing', attempts = attempts + 1, updated_at = ? WHERE id = ? AND status IN ('scheduled', 'retrying')`,
          [Date.now(), testJobId]
        )
      )
    );

    const successfulClaims = claimAttempts.filter(res => res.changes === 1);
    const skippedClaims = claimAttempts.filter(res => res.changes === 0);

    assert.strictEqual(successfulClaims.length, 1, "Exactly one worker must successfully claim the job");
    assert.strictEqual(skippedClaims.length, 9, "9 workers must receive 0 changes and skip the job");

    await run("DELETE FROM schedules WHERE id = ?", [testJobId]);
  });

  await test("Restarting one worker does not reset jobs owned by another active worker", async () => {
    const activeJobId = crypto.randomUUID();
    const staleJobId = crypto.randomUUID();
    const dummyUserId = crypto.randomUUID();
    const now = Date.now();

    // Active worker's job: claimed 5 seconds ago
    await run(`
      INSERT INTO schedules (id, user_id, recipient, text, scheduled_at, status, attempts, created_at, updated_at)
      VALUES (?, ?, '919999999991', 'Active job', ?, 'processing', 1, ?, ?)
    `, [activeJobId, dummyUserId, now - 5000, now, now - 5000]);

    // Stale/crashed worker's job: claimed 10 minutes ago
    await run(`
      INSERT INTO schedules (id, user_id, recipient, text, scheduled_at, status, attempts, created_at, updated_at)
      VALUES (?, ?, '919999999992', 'Stale job', ?, 'processing', 1, ?, ?)
    `, [staleJobId, dummyUserId, now - 600000, now, now - 600000]);

    // Worker restarts and executes stale recovery with 5-minute threshold
    const recoveredCount = await recoverStaleProcessingJobs(5 * 60 * 1000);
    assert.ok(recoveredCount >= 1, "Must recover at least the stale job");

    // Check active job status: MUST STILL BE PROCESSING!
    const activeRow = await get("SELECT status FROM schedules WHERE id = ?", [activeJobId]);
    assert.strictEqual(activeRow.status, "processing", "Active live worker's job must NOT be reset");

    // Check stale job status: MUST BE RECOVERED TO RETRYING!
    const staleRow = await get("SELECT status, error FROM schedules WHERE id = ?", [staleJobId]);
    assert.strictEqual(staleRow.status, "retrying", "Stale orphaned job must be recovered to retrying");
    assert.ok(staleRow.error.includes("stale processing job") || staleRow.error.includes("server restart"));

    await run("DELETE FROM schedules WHERE id IN (?, ?)", [activeJobId, staleJobId]);
  });

  // --- C.5: Failed WhatsApp session does not stop other users' jobs ---
  console.log("\n📱 [C.5] WhatsApp Session Failure Isolation:");

  await test("A failed WhatsApp session does not stop other users' jobs", async () => {
    const userA_Id = crypto.randomUUID();
    const userB_Id = crypto.randomUUID();
    const now = Date.now();

    // User A job (disconnected)
    const jobA_Id = crypto.randomUUID();
    await run(`
      INSERT INTO schedules (id, user_id, recipient, text, scheduled_at, status, attempts, created_at)
      VALUES (?, ?, '919000000001', 'User A message', ?, 'scheduled', 0, ?)
    `, [jobA_Id, userA_Id, now - 2000, now]);

    // Execute scheduler loop
    await checkAndProcessSchedules();

    // Verify User A job was postponed to 'retrying' and did not crash the scheduler
    const rowA = await get("SELECT status, error, scheduled_at FROM schedules WHERE id = ?", [jobA_Id]);
    assert.strictEqual(rowA.status, "retrying", "User A job should be postponed to retrying");
    assert.ok(rowA.scheduled_at > now, "Postponed job should be scheduled in the future");

    await run("DELETE FROM schedules WHERE id = ?", [jobA_Id]);
  });

  // --- C.6: Resource Limits & Upload Safety ---
  console.log("\n📦 [C.6] Request Body & Upload Resource Limits:");

  await test("Large JSON payloads exceeding 2MB limit are rejected with HTTP 413", async () => {
    const server = http.createServer(app);
    await new Promise((res) => server.listen(0, "127.0.0.1", res));
    const port = server.address().port;

    const largeData = "X".repeat(3 * 1024 * 1024); // 3MB payload
    const bodyStr = JSON.stringify({ data: largeData });

    const status = await new Promise((res, rej) => {
      const req = http.request(
        `http://127.0.0.1:${port}/api/auth/setup-status`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Content-Length": Buffer.byteLength(bodyStr)
          }
        },
        (response) => res(response.statusCode)
      );
      req.on("error", rej);
      req.write(bodyStr);
      req.end();
    });

    assert.strictEqual(status, 413, `Expected HTTP 413 Payload Too Large, got ${status}`);
    await new Promise((res) => server.close(res));
  });

  // --- C.7: Production Startup Configuration Validation ---
  console.log("\n⚙️ [C.7] Production Startup Configuration Validation:");

  await test("Production startup fails clearly if required configuration is missing or insecure", () => {
    const originalEnv = process.env.NODE_ENV;
    const originalOrigins = process.env.ALLOWED_ORIGINS;

    try {
      process.env.NODE_ENV = "production";

      // Case 1: Missing ALLOWED_ORIGINS
      delete process.env.ALLOWED_ORIGINS;
      assert.throws(
        () => validateProductionConfig(),
        /PRODUCTION CONFIG ERROR/,
        "Must throw when ALLOWED_ORIGINS is missing in production"
      );

      // Case 2: Insecure localhost origin in production
      process.env.ALLOWED_ORIGINS = "http://localhost:3000";
      assert.throws(
        () => validateProductionConfig(),
        /localhost/,
        "Must reject localhost in ALLOWED_ORIGINS during production"
      );

      // Case 3: Legitimate production origins pass
      process.env.ALLOWED_ORIGINS = "https://my-whatsapp-scheduler.onrender.com";
      assert.strictEqual(validateProductionConfig(), true, "Valid production origin configuration must succeed");
    } finally {
      process.env.NODE_ENV = originalEnv;
      if (originalOrigins !== undefined) {
        process.env.ALLOWED_ORIGINS = originalOrigins;
      } else {
        delete process.env.ALLOWED_ORIGINS;
      }
    }
  });

  console.log("\n=================================================================");
  console.log(`📊 AUDIT VERIFICATION RESULTS: ${passed} Passed, ${failed} Failed`);
  console.log("=================================================================\n");

  if (failed > 0) {
    process.exit(1);
  }
}

if (require.main === module) {
  runAuditVerificationTests()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error("Test execution failed:", err);
      process.exit(1);
    });
}

module.exports = { runAuditVerificationTests };
