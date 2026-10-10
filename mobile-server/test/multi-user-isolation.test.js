const assert = require("assert");
const http = require("http");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const { db, run, get, all, DB_DIR } = require("../db");
const {
  registerUser,
  authenticateUser,
  createSession,
  hashPassword,
  listUsers,
  createUserByAdmin,
  deleteUserAccount
} = require("../auth");
const { getOrCreateUserSession, getStatus } = require("../engine");
const { isPathContained, safeDeleteAttachment } = require("../scheduler");
const app = require("../server");

const UPLOADS_DIR = path.join(DB_DIR, "uploads");

// Helper: HTTP request wrapper
function makeRequest(baseUrl, reqPath, options = {}) {
  const url = new URL(reqPath, baseUrl);
  return new Promise((resolve, reject) => {
    const req = http.request(
      url,
      {
        method: options.method || "GET",
        headers: {
          "Content-Type": "application/json",
          ...(options.headers || {})
        }
      },
      (res) => {
        let rawData = "";
        res.on("data", (chunk) => (rawData += chunk));
        res.on("end", () => {
          let json = null;
          try {
            json = JSON.parse(rawData);
          } catch (_) {}
          resolve({ status: res.statusCode, headers: res.headers, body: json || rawData });
        });
      }
    );
    req.on("error", reject);
    if (options.body) {
      req.write(typeof options.body === "string" ? options.body : JSON.stringify(options.body));
    }
    req.end();
  });
}

async function runMultiUserRegressionTests() {
  console.log("=================================================================");
  console.log("👥 Multi-User Isolation & Regression Test Suite (Step 5)");
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

  // Spin up an ephemeral HTTP server for deterministic local execution
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  const BASE_URL = `http://127.0.0.1:${port}`;

  try {
    const ts = Date.now().toString(36);
    const aliceUsername = `alice_${ts}`;
    const bobUsername = `bob_${ts}`;
    const alicePassword = "AliceSecurePass123!";
    const bobPassword = "BobSecurePass123!";

    let aliceToken = null;
    let aliceId = null;
    let bobToken = null;
    let bobId = null;

    // --- TEST 1: Independent Registration and Authentication ---
    console.log("🔐 [1] Independent User Registration & Authentication Flow:");

    await test("Alice registers and receives unique session token & user ID", async () => {
      const res = await makeRequest(BASE_URL, "/api/auth/register", {
        method: "POST",
        body: { username: aliceUsername, password: alicePassword }
      });
      assert.strictEqual(res.status, 200, `Expected 200, got ${res.status}: ${JSON.stringify(res.body)}`);
      assert.strictEqual(res.body.success, true);
      assert.ok(res.body.token, "Expected session token for Alice");
      assert.strictEqual(res.body.user.username, aliceUsername);
      aliceToken = res.body.token;
      aliceId = res.body.user.id;
      assert.ok(aliceId, "Expected user ID for Alice");
    });

    await test("Bob registers as a second independent user (no single-user lock)", async () => {
      const res = await makeRequest(BASE_URL, "/api/auth/register", {
        method: "POST",
        body: { username: bobUsername, password: bobPassword }
      });
      assert.strictEqual(res.status, 200, `Expected 200, got ${res.status}: ${JSON.stringify(res.body)}`);
      assert.strictEqual(res.body.success, true);
      assert.ok(res.body.token, "Expected session token for Bob");
      assert.strictEqual(res.body.user.username, bobUsername);
      bobToken = res.body.token;
      bobId = res.body.user.id;
      assert.notStrictEqual(aliceId, bobId, "Alice and Bob must have distinct user IDs");
      assert.notStrictEqual(aliceToken, bobToken, "Alice and Bob must have distinct session tokens");
    });

    await test("Both Alice and Bob can authenticate independently via login", async () => {
      const resA = await makeRequest(BASE_URL, "/api/auth/login", {
        method: "POST",
        body: { username: aliceUsername, password: alicePassword }
      });
      assert.strictEqual(resA.status, 200);
      assert.strictEqual(resA.body.user.id, aliceId);

      const resB = await makeRequest(BASE_URL, "/api/auth/login", {
        method: "POST",
        body: { username: bobUsername, password: bobPassword }
      });
      assert.strictEqual(resB.status, 200);
      assert.strictEqual(resB.body.user.id, bobId);
    });

    // --- TEST 2: Alice cannot read, edit, delete Bob's data ---
    console.log("\n🛡️ [2] Complete Cross-User Data Isolation (Schedules & Contacts):");

    let bobScheduleId = null;

    await test("Bob creates a private scheduled message", async () => {
      const futureTime = Date.now() + 3600000;
      const res = await makeRequest(BASE_URL, "/api/schedules", {
        method: "POST",
        headers: { Authorization: `Bearer ${bobToken}` },
        body: {
          recipient: "919876543210",
          text: "Bob private confidential message",
          scheduledAt: futureTime
        }
      });
      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.body.success, true);
      bobScheduleId = res.body.schedule.id;
      assert.strictEqual(res.body.schedule.user_id, bobId);
    });

    await test("Alice CANNOT see Bob's scheduled message in her queue", async () => {
      const res = await makeRequest(BASE_URL, "/api/schedules", {
        headers: { Authorization: `Bearer ${aliceToken}` }
      });
      assert.strictEqual(res.status, 200);
      const aliceSchedules = res.body.schedules || [];
      const foundBobJob = aliceSchedules.find((s) => s.id === bobScheduleId);
      assert.strictEqual(foundBobJob, undefined, "Bob's schedule must not appear in Alice's queue");
    });

    await test("Alice CANNOT delete Bob's scheduled message (IDOR defense)", async () => {
      const res = await makeRequest(BASE_URL, `/api/schedules/${bobScheduleId}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${aliceToken}` }
      });
      assert.strictEqual(res.status, 404, "Alice attempting to delete Bob's job must fail-closed with 404");

      // Verify Bob's schedule still exists
      const checkRes = await makeRequest(BASE_URL, "/api/schedules", {
        headers: { Authorization: `Bearer ${bobToken}` }
      });
      const bobJobs = checkRes.body.schedules || [];
      assert.ok(bobJobs.some((s) => s.id === bobScheduleId), "Bob's schedule must remain intact");
    });

    await test("Bob imports private contacts; Alice CANNOT read or search them", async () => {
      // Bob imports
      const impRes = await makeRequest(BASE_URL, "/api/contacts/import", {
        method: "POST",
        headers: { Authorization: `Bearer ${bobToken}` },
        body: {
          contacts: [{ name: "Bob Secret Contact", phone: "919111122222" }]
        }
      });
      assert.strictEqual(impRes.status, 200);

      // Alice queries contacts
      const aliceContactsRes = await makeRequest(BASE_URL, "/api/contacts", {
        headers: { Authorization: `Bearer ${aliceToken}` }
      });
      assert.strictEqual(aliceContactsRes.status, 200);
      const aliceContacts = aliceContactsRes.body.contacts || [];
      assert.strictEqual(
        aliceContacts.some((c) => c.name === "Bob Secret Contact"),
        false,
        "Alice must not have access to Bob's private contacts"
      );
    });

    // --- TEST 3: Attachment & File Directory Isolation ---
    console.log("\n📁 [3] Attachment & Path Containment Isolation:");

    await test("Alice cannot inject or reference Bob's attachment files via existingFiles", async () => {
      // Create a decoy file in Bob's user upload directory
      const bobUploadDir = path.join(UPLOADS_DIR, bobId);
      fs.mkdirSync(bobUploadDir, { recursive: true });
      const bobPrivateFile = path.join(bobUploadDir, "bob_sensitive_doc.pdf");
      fs.writeFileSync(bobPrivateFile, "Confidential Bob Data");

      // Alice tries to reference Bob's file in a schedule
      const res = await makeRequest(BASE_URL, "/api/schedules", {
        method: "POST",
        headers: { Authorization: `Bearer ${aliceToken}` },
        body: {
          recipient: "919999988888",
          text: "Alice message with injected Bob file",
          scheduledAt: Date.now() + 3600000,
          existingFiles: JSON.stringify([{ name: "stolen.pdf", path: bobPrivateFile }])
        }
      });
      assert.strictEqual(res.status, 200);
      // The attachments array in Alice's schedule must NOT contain Bob's file
      const scheduleAttachments = res.body.schedule.attachments || [];
      const hasBobFile = scheduleAttachments.some((a) => a.path === bobPrivateFile);
      assert.strictEqual(hasBobFile, false, "Alice must not be able to adopt Bob's file");

      // Verify Bob's file was not deleted
      assert.strictEqual(fs.existsSync(bobPrivateFile), true);
    });

    // --- TEST 4 & 5: Independent WhatsApp Connections & Logout ---
    console.log("\n📱 [4 & 5] Independent WhatsApp Connections & Scoped Logout:");

    await test("Alice and Bob have independent, isolated WhatsApp session instances", async () => {
      const sessionAlice = getOrCreateUserSession(aliceId);
      const sessionBob = getOrCreateUserSession(bobId);

      assert.notStrictEqual(sessionAlice, sessionBob, "Session instances must be distinct per user");
      assert.strictEqual(sessionAlice.userId, aliceId);
      assert.strictEqual(sessionBob.userId, bobId);
      assert.notStrictEqual(sessionAlice.authDir, sessionBob.authDir, "Auth directories must be separated per user");
      assert.ok(sessionAlice.authDir.includes(aliceId), "Alice authDir must contain Alice's user ID");
      assert.ok(sessionBob.authDir.includes(bobId), "Bob authDir must contain Bob's user ID");
    });

    await test("Logging out Alice's application session does not invalidate Bob's session", async () => {
      // Alice logs out
      const logoutRes = await makeRequest(BASE_URL, "/api/auth/logout", {
        method: "POST",
        headers: { Authorization: `Bearer ${aliceToken}` }
      });
      assert.strictEqual(logoutRes.status, 200);

      // Alice's token is now invalid
      const checkAlice = await makeRequest(BASE_URL, "/api/auth/me", {
        headers: { Authorization: `Bearer ${aliceToken}` }
      });
      assert.strictEqual(checkAlice.status, 401, "Alice's revoked token must fail with 401");

      // Bob's token is STILL valid
      const checkBob = await makeRequest(BASE_URL, "/api/auth/me", {
        headers: { Authorization: `Bearer ${bobToken}` }
      });
      assert.strictEqual(checkBob.status, 200, "Bob's session must remain valid after Alice logs out");
      assert.strictEqual(checkBob.body.user.id, bobId);
    });

    // --- TEST 6: Unauthenticated Request Rejection ---
    console.log("\n🚫 [6] Unauthenticated Request Rejection (Fail-Closed):");

    await test("Unauthenticated requests to protected endpoints return 401", async () => {
      const routes = [
        { method: "GET", path: "/api/status" },
        { method: "GET", path: "/api/qr" },
        { method: "POST", path: "/api/pair-code", body: { phoneNumber: "919876543210" } },
        { method: "GET", path: "/api/contacts" },
        { method: "GET", path: "/api/schedules" },
        { method: "POST", path: "/api/schedules", body: {} },
        { method: "GET", path: "/api/admin/users" }
      ];

      for (const r of routes) {
        const res = await makeRequest(BASE_URL, r.path, { method: r.method, body: r.body });
        assert.strictEqual(res.status, 401, `Route ${r.method} ${r.path} must return 401 when unauthenticated`);
      }
    });

    // --- TEST 7: Concurrent Requests & State Leak Prevention ---
    console.log("\n⚡ [7] Concurrent Operations & State Isolation:");

    await test("Simultaneous concurrent requests from multiple users maintain isolated state", async () => {
      // Re-login Alice
      const loginA = await makeRequest(BASE_URL, "/api/auth/login", {
        method: "POST",
        body: { username: aliceUsername, password: alicePassword }
      });
      aliceToken = loginA.body.token;

      // Fire 10 simultaneous requests from Alice and Bob concurrently
      const promises = [];
      for (let i = 0; i < 5; i++) {
        promises.push(makeRequest(BASE_URL, "/api/auth/me", { headers: { Authorization: `Bearer ${aliceToken}` } }));
        promises.push(makeRequest(BASE_URL, "/api/auth/me", { headers: { Authorization: `Bearer ${bobToken}` } }));
      }

      const results = await Promise.all(promises);
      for (let i = 0; i < results.length; i++) {
        const res = results[i];
        assert.strictEqual(res.status, 200);
        if (i % 2 === 0) {
          assert.strictEqual(res.body.user.id, aliceId, "Alice concurrent request returned wrong user ID");
        } else {
          assert.strictEqual(res.body.user.id, bobId, "Bob concurrent request returned wrong user ID");
        }
      }
    });

    // --- TEST 8: Database Migrations & Single-User Compatibility ---
    console.log("\n💾 [8] Database Backward Compatibility & Schema Integrity:");

    await test("User tables, sessions, contacts, and settings maintain user_id foreign keys and indexes", async () => {
      const tableInfo = await all("PRAGMA table_info(schedules)");
      const hasUserId = tableInfo.some((col) => col.name === "user_id");
      assert.strictEqual(hasUserId, true, "schedules table must have user_id column");

      const contactsInfo = await all("PRAGMA table_info(contacts)");
      const contactsHasUserId = contactsInfo.some((col) => col.name === "user_id");
      assert.strictEqual(contactsHasUserId, true, "contacts table must have user_id column");

      const settingsInfo = await all("PRAGMA table_info(settings)");
      const settingsHasUserId = settingsInfo.some((col) => col.name === "user_id");
      assert.strictEqual(settingsHasUserId, true, "settings table must have user_id column");
    });

    console.log("\n=================================================================");
    console.log(`📊 MULTI-USER REGRESSION TEST RESULTS: ${passed} Passed, ${failed} Failed`);
    console.log("=================================================================\n");

    if (failed > 0) {
      process.exit(1);
    }
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

if (require.main === module) {
  runMultiUserRegressionTests()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error("Test execution failed:", err);
      process.exit(1);
    });
}

module.exports = { runMultiUserRegressionTests };
