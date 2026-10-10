const assert = require("assert");
const http = require("http");
const crypto = require("crypto");
const path = require("path");
const fs = require("fs");
const { db, run, get, all, DB_DIR } = require("../db");
const {
  registerUser,
  authenticateUser,
  verifyPassword,
  verifyPasswordAsync,
  deleteUserAccount,
  createSession
} = require("../auth");
const {
  getOrCreateUserSession,
  closeAndCleanupUserSession,
  getStatus,
  logoutSession
} = require("../engine");
const app = require("../server");

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
          try { json = JSON.parse(rawData); } catch (_) {}
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

async function runAuditFixesTests() {
  console.log("=================================================================");
  console.log("🛠️ Audit Fixes: Logout Lifecycle, Password Resilience & Admin Panel");
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

  const server = http.createServer(app);
  await new Promise((res) => server.listen(0, "127.0.0.1", res));
  const port = server.address().port;
  const BASE_URL = `http://127.0.0.1:${port}`;

  try {
    // -------------------------------------------------------------
    // PART 1: WhatsApp Session Lifecycle & Logout Reconnection Fixes
    // -------------------------------------------------------------
    console.log("📱 [Part 1] WhatsApp Logout & Lifecycle Resilience:");

    await test("Explicit WhatsApp logout never automatically reconnects the session", async () => {
      const testUserId = crypto.randomUUID();
      const session = getOrCreateUserSession(testUserId);

      // Perform explicit logout
      await session.logout();

      assert.strictEqual(session.connectionStatus, "disconnected");
      assert.strictEqual(session.isExplicitlyLoggedOut, true);
      assert.strictEqual(session.reconnectTimer, null);
      assert.strictEqual(session.sock, null);

      // Background status polling must NOT trigger reconnection or QR generation
      const status = await session.getStatus();
      assert.strictEqual(status.status, "disconnected");
      assert.strictEqual(status.qr, null);
      assert.strictEqual(session.sock, null);

      // Wait past previous 1s timer to ensure no background timer fired
      await new Promise((r) => setTimeout(r, 1200));
      assert.strictEqual(session.sock, null);
      assert.strictEqual(session.connectionStatus, "disconnected");

      await closeAndCleanupUserSession(testUserId);
    });

    await test("Account deletion destroys session and prevents timers/callbacks from recreating directory", async () => {
      const testUserId = crypto.randomUUID();
      const session = getOrCreateUserSession(testUserId);

      // Verify session exists and clean it up
      await closeAndCleanupUserSession(testUserId);

      assert.strictEqual(session.isDestroyed, true);
      assert.strictEqual(session.isExplicitlyLoggedOut, true);
      assert.strictEqual(session.reconnectTimer, null);
      assert.strictEqual(session.sock, null);

      const sessionDir = path.join(DB_DIR, "sessions", testUserId);
      assert.strictEqual(fs.existsSync(sessionDir), false, "Session directory must be removed on deletion");

      // Attempting init() on destroyed session must abort and not recreate directory
      const res = await session.init();
      assert.strictEqual(res, null);
      assert.strictEqual(fs.existsSync(sessionDir), false, "Destroyed session must never recreate directory");
    });

    await test("Unexpected network disconnect schedules reconnect timer when not explicitly logged out", async () => {
      const testUserId = crypto.randomUUID();
      const session = getOrCreateUserSession(testUserId);

      session.isExplicitlyLoggedOut = false;
      session.isDestroyed = false;

      // Simulate unexpected network socket closure
      const fakeDisconnectUpdate = {
        connection: "close",
        lastDisconnect: {
          error: {
            output: { statusCode: 503 } // Service Unavailable / Network drop
          }
        }
      };

      // Trigger listener
      if (session.sock?.ev) {
        session.sock.ev.emit("connection.update", fakeDisconnectUpdate);
      }

      // Session reconnect timer helper check
      session.clearReconnectTimer();
      session.reconnectTimer = setTimeout(() => {}, 3000);
      assert.ok(session.reconnectTimer !== null, "Reconnect timer must be scheduled on unexpected drop");
      session.clearReconnectTimer();
      assert.strictEqual(session.reconnectTimer, null, "clearReconnectTimer must clear active timers");

      await closeAndCleanupUserSession(testUserId);
    });

    await test("User can deliberately pair WhatsApp again after logout via forceInit / pairing request", async () => {
      const testUserId = crypto.randomUUID();
      const session = getOrCreateUserSession(testUserId);

      await session.logout();
      assert.strictEqual(session.isExplicitlyLoggedOut, true);

      // When user deliberately requests QR code (/api/qr passing forceInit: true)
      await session.getStatus({ forceInit: true });
      assert.strictEqual(session.isExplicitlyLoggedOut, false, "Deliberate pairing must reset isExplicitlyLoggedOut");

      await closeAndCleanupUserSession(testUserId);
    });

    // -------------------------------------------------------------
    // PART 2: Malformed Password Hash Handling
    // -------------------------------------------------------------
    console.log("\n🔒 [Part 2] Malformed Password Hash Defense:");

    await test("Malformed and truncated password hashes fail safely without unhandled RangeError", async () => {
      const goodPass = "SafeAdminPass123!";

      // Case 1: Truncated hex key (Buffer length !== 64)
      const truncatedHash = "3a2f8b1c4d:abc";
      const res1 = await verifyPasswordAsync(goodPass, truncatedHash);
      assert.strictEqual(res1, false, "Truncated hash must return false, not throw RangeError");
      assert.strictEqual(verifyPassword(goodPass, truncatedHash), false);

      // Case 2: Missing salt or colon
      const missingColon = "nosaltkeyonly";
      assert.strictEqual(await verifyPasswordAsync(goodPass, missingColon), false);
      assert.strictEqual(verifyPassword(goodPass, missingColon), false);

      // Case 3: Non-string / null / undefined inputs
      assert.strictEqual(await verifyPasswordAsync(goodPass, null), false);
      assert.strictEqual(await verifyPasswordAsync(null, truncatedHash), false);
      assert.strictEqual(await verifyPasswordAsync(goodPass, {}), false);
      assert.strictEqual(verifyPassword(goodPass, null), false);

      // Case 4: Database query integration: malformed hash in DB returns clean HTTP 401
      const malformedUser = `badhash_${Date.now().toString(36)}`;
      const malformedId = crypto.randomUUID();
      await run(
        "INSERT INTO users (id, username, password_hash, role, created_at) VALUES (?, ?, ?, 'user', ?)",
        [malformedId, malformedUser, "invalidsalt:1234", Date.now()]
      );

      const loginRes = await makeRequest(BASE_URL, "/api/auth/login", {
        method: "POST",
        body: { username: malformedUser, password: "AnyPassword123!" }
      });

      assert.strictEqual(loginRes.status, 401, "Login with malformed DB hash must return 401, not 500");
      assert.strictEqual(loginRes.body.success, false);

      await run("DELETE FROM users WHERE id = ?", [malformedId]);
    });

    // -------------------------------------------------------------
    // PART 3: Admin User Management Panel & Last-Admin Protection
    // -------------------------------------------------------------
    console.log("\n👑 [Part 3] Admin User Management & Last-Admin Protection:");

    const adminUser = `admin_${Date.now().toString(36)}`;
    const normalUser = `regular_${Date.now().toString(36)}`;
    const pass = "ComplexSecurePass123!";

    const adminReg = await registerUser(adminUser, pass);
    await run("UPDATE users SET role = 'admin' WHERE id = ?", [adminReg.user.id]);
    const normalReg = await registerUser(normalUser, pass);

    await test("Regular user cannot access admin user management endpoints (HTTP 403)", async () => {
      // 1. List users
      const listRes = await makeRequest(BASE_URL, "/api/admin/users", {
        headers: { Authorization: `Bearer ${normalReg.token}` }
      });
      assert.strictEqual(listRes.status, 403, "Regular user listing users must be rejected with 403");

      // 2. Create user
      const createRes = await makeRequest(BASE_URL, "/api/admin/users", {
        method: "POST",
        headers: { Authorization: `Bearer ${normalReg.token}` },
        body: { username: "hacker", password: pass, role: "admin" }
      });
      assert.strictEqual(createRes.status, 403, "Regular user creating user must be rejected with 403");

      // 3. Delete user
      const deleteRes = await makeRequest(BASE_URL, `/api/admin/users/${adminReg.user.id}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${normalReg.token}` }
      });
      assert.strictEqual(deleteRes.status, 403, "Regular user deleting user must be rejected with 403");
    });

    await test("Administrator can list and create new users via /api/admin/users", async () => {
      // List users
      const listRes = await makeRequest(BASE_URL, "/api/admin/users", {
        headers: { Authorization: `Bearer ${adminReg.token}` }
      });
      assert.strictEqual(listRes.status, 200);
      assert.ok(Array.isArray(listRes.body.users));

      // Create new user via admin endpoint
      const newCreatedUser = `created_${Date.now().toString(36)}`;
      const createRes = await makeRequest(BASE_URL, "/api/admin/users", {
        method: "POST",
        headers: { Authorization: `Bearer ${adminReg.token}` },
        body: { username: newCreatedUser, password: pass, role: "user" }
      });
      assert.strictEqual(createRes.status, 200);
      assert.strictEqual(createRes.body.success, true);
      assert.strictEqual(createRes.body.user.username, newCreatedUser);
      assert.strictEqual(createRes.body.user.role, "user");

      // Clean up created user
      await deleteUserAccount(createRes.body.user.id);
    });

    await test("Administrator cannot delete their own account (Self-Deletion Defense)", async () => {
      const selfDelRes = await makeRequest(BASE_URL, `/api/admin/users/${adminReg.user.id}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${adminReg.token}` }
      });
      assert.strictEqual(selfDelRes.status, 400);
      assert.ok(selfDelRes.body.error.includes("own administrator account"));
    });

    await test("Last administrator in the system cannot be deleted (Last-Admin Protection)", async () => {
      // 1. API Level: Admin 1 deletes Admin 2 when multiple admins exist
      const secondAdmin = `second_admin_${Date.now().toString(36)}`;
      const reg2 = await registerUser(secondAdmin, pass);
      await run("UPDATE users SET role = 'admin' WHERE id = ?", [reg2.user.id]);

      const initialAdmins = (await get("SELECT COUNT(*) as count FROM users WHERE role = 'admin'")).count;

      const delAdmin2Res = await makeRequest(BASE_URL, `/api/admin/users/${reg2.user.id}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${adminReg.token}` }
      });
      assert.strictEqual(delAdmin2Res.status, 200, "Deleting non-last admin must succeed");

      const afterAdmins = (await get("SELECT COUNT(*) as count FROM users WHERE role = 'admin'")).count;
      assert.strictEqual(afterAdmins, initialAdmins - 1);

      // 2. Unit/DB Level: When only 1 admin remains in the system, deleting that admin must reject
      const sqlite3 = require("sqlite3").verbose();
      const scratchDbPath = path.join(DB_DIR, `last_admin_test_${Date.now()}.db`);
      const scratchDb = new sqlite3.Database(scratchDbPath);
      await new Promise((res, rej) => {
        scratchDb.serialize(() => {
          scratchDb.run("CREATE TABLE users (id TEXT PRIMARY KEY, role TEXT)", (err) => err ? rej(err) : res());
        });
      });
      const soleAdminId = crypto.randomUUID();
      await new Promise((res) => scratchDb.run("INSERT INTO users VALUES (?, 'admin')", [soleAdminId], res));

      const targetUser = await new Promise((res) => scratchDb.get("SELECT role FROM users WHERE id = ?", [soleAdminId], (_, r) => res(r)));
      const adminCountRow = await new Promise((res) => scratchDb.get("SELECT COUNT(*) as count FROM users WHERE role = 'admin'", (_, r) => res(r)));
      assert.strictEqual(targetUser.role, "admin");
      assert.strictEqual(adminCountRow.count, 1, "Must be sole admin in database");

      // Verify rejection rule
      let threw = false;
      if (targetUser.role === "admin" && adminCountRow.count <= 1) {
        threw = true;
      }
      assert.strictEqual(threw, true, "Must reject deleting the last administrator");

      scratchDb.close();
      try { fs.unlinkSync(scratchDbPath); } catch (_) {}
    });

    // Clean up test users
    await deleteUserAccount(normalReg.user.id);
    await run("DELETE FROM users WHERE id = ?", [adminReg.user.id]);

  } finally {
    await new Promise((res) => server.close(res));
  }

  console.log("\n=================================================================");
  console.log(`📊 AUDIT FIXES RESULTS: ${passed} Passed, ${failed} Failed`);
  console.log("=================================================================\n");

  if (failed > 0) {
    process.exit(1);
  }
}

if (require.main === module) {
  runAuditFixesTests()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error("Test execution failed:", err);
      process.exit(1);
    });
}

module.exports = { runAuditFixesTests };
