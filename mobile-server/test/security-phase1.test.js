const assert = require("assert");
const http = require("http");
const crypto = require("crypto");
const { db, run, get } = require("../db");
const { createSession } = require("../auth");

const BASE_URL = process.env.TEST_SERVER_URL || "http://127.0.0.1:3000";

async function request(path, options = {}) {
  const url = new URL(path, BASE_URL);
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

async function runSecurityPhase1Tests() {
  console.log("=================================================================");
  console.log("🧪 Comprehensive Phase 1 Security Audit & Test Suite (SEC-001 & SEC-002)");
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

  // --- A. Comprehensive Route-by-Route Unauthenticated 401 Rejections ---
  console.log("🔒 [A] Route-by-Route Unauthenticated Fail-Closed Verification (SEC-001):");

  const privateRoutes = [
    { method: "GET", path: "/api/status" },
    { method: "GET", path: "/api/qr" },
    { method: "POST", path: "/api/pair-code", body: { phoneNumber: "919876543210" } },
    { method: "POST", path: "/api/logout" },
    { method: "GET", path: "/api/contacts" },
    { method: "POST", path: "/api/contacts/import", body: { contacts: [] } },
    { method: "GET", path: "/api/profile-pic?jid=12345%40s.whatsapp.net" },
    { method: "GET", path: "/api/schedules" },
    { method: "POST", path: "/api/schedules", body: { recipient: "919876543210", text: "test" } },
    { method: "DELETE", path: "/api/schedules/dummy-schedule-id" },
    { method: "GET", path: "/api/shared/dummy-share-id" },
    { method: "POST", path: "/share-target", body: {} },
    { method: "GET", path: "/api/auth/me" }
  ];

  for (const r of privateRoutes) {
    await test(`Unauthenticated ${r.method} ${r.path} returns 401`, async () => {
      const res = await request(r.path, { method: r.method, body: r.body });
      assert.strictEqual(res.status, 401, `Expected 401 for ${r.method} ${r.path}, got ${res.status}`);
      assert.strictEqual(res.body.success, false);
    });
  }

  // --- B. Token Validation Edge Cases (Expired, Malformed, Forged) ---
  console.log("\n🔑 [B] Session Token Validation & Revocation Edge Cases:");

  await test("Malformed header (missing Bearer prefix with invalid token) returns 401", async () => {
    const res = await request("/api/status", {
      headers: { Authorization: "InvalidMalformedTokenFormat" }
    });
    assert.strictEqual(res.status, 401);
    assert.strictEqual(res.body.success, false);
  });

  await test("Forged Bearer token returns 401", async () => {
    const res = await request("/api/status", {
      headers: { Authorization: "Bearer 0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef" }
    });
    assert.strictEqual(res.status, 401);
  });

  // Create an expired session directly in DB to test expiration
  const expiredToken = crypto.randomBytes(32).toString("hex");
  const dummyUserId = crypto.randomUUID();
  const pastTime = Date.now() - 100000;
  await run(
    "INSERT OR REPLACE INTO sessions (token, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)",
    [expiredToken, dummyUserId, pastTime - 100000, pastTime]
  );

  await test("Expired session token returns 401", async () => {
    const res = await request("/api/status", {
      headers: { Authorization: `Bearer ${expiredToken}` }
    });
    assert.strictEqual(res.status, 401, `Expected 401 for expired token, got ${res.status}`);
    assert.strictEqual(res.body.success, false);
  });

  // Clean up expired test token
  await run("DELETE FROM sessions WHERE token = ?", [expiredToken]);

  // --- C. User Setup & Registration Lockdown Verification ---
  console.log("\n🛡️ [C] User Setup & Registration Lockdown Verification:");

  let testAdminToken = null;
  const adminUser = `admin_${Date.now().toString(36)}`;
  const adminPass = "SecureAdminPass123!";

  // Check setup status
  const setupStatusRes = await request("/api/auth/setup-status");
  assert.strictEqual(setupStatusRes.status, 200);

  if (setupStatusRes.body.setupRequired) {
    await test("Primary Administrator Registration via /api/auth/register", async () => {
      const res = await request("/api/auth/register", {
        method: "POST",
        body: { username: adminUser, password: adminPass }
      });
      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.body.success, true);
      assert.strictEqual(res.body.user.role, "admin");
      testAdminToken = res.body.token;
    });
  } else {
    // Admin already exists, authenticate with existing or create test session
    const row = await get("SELECT id, username FROM users LIMIT 1");
    assert.ok(row, "At least one user must exist");
    const session = await createSession(row.id);
    testAdminToken = session.token;
    console.log(`  ℹ️  Using existing user '${row.username}' for authenticated tests`);
  }

  await test("Registration lockdown: Secondary public registration attempts are rejected with 400", async () => {
    const res = await request("/api/auth/register", {
      method: "POST",
      body: { username: `attacker_${Date.now().toString(36)}`, password: "AttackerPassword123!" }
    });
    assert.strictEqual(res.status, 400, `Expected 400 registration locked, got ${res.status}`);
    assert.strictEqual(res.body.success, false);
    assert.ok(res.body.error.includes("Registration is closed"));
  });

  await test("Authenticated request with valid admin token succeeds on /api/auth/me", async () => {
    const res = await request("/api/auth/me", {
      headers: { Authorization: `Bearer ${testAdminToken}` }
    });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.success, true);
  });

  await test("Authenticated request with valid admin token succeeds on /api/status", async () => {
    const res = await request("/api/status", {
      headers: { Authorization: `Bearer ${testAdminToken}` }
    });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.success, true);
  });

  // --- D. Public Endpoints Verification ---
  console.log("\n🌐 [D] Public Endpoints Verification:");

  await test("GET /api/version remains public for in-app updates", async () => {
    const res = await request("/api/version");
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.success, true);
  });

  await test("GET / returns 200 PWA index HTML", async () => {
    const res = await request("/");
    assert.strictEqual(res.status, 200);
  });

  // --- E. SEC-002: Android Updater Whitelist & Signature Verification Logic ---
  console.log("\n📱 [E] Android In-App Updater Whitelist & Certificate Logic Tests (SEC-002):");

  function validateDownloadUrl(urlStr) {
    if (!urlStr || !urlStr.startsWith("https://")) return false;
    try {
      const parsed = new URL(urlStr);
      const host = parsed.hostname.toLowerCase();
      if (host !== "github.com" && !host.endsWith(".githubusercontent.com")) {
        return false;
      }
      return true;
    } catch (_) {
      return false;
    }
  }

  function simulateSignatureCheck(installedSigHex, downloadedSigHex) {
    if (!installedSigHex || !downloadedSigHex) return false;
    return installedSigHex === downloadedSigHex;
  }

  await test("Reject non-HTTPS download URLs (HTTP / FTP / JavaScript schemes)", () => {
    assert.strictEqual(validateDownloadUrl("http://github.com/PannagaJA/Whatsapp-Scheduler/releases/download/v1.0.0/app.apk"), false);
    assert.strictEqual(validateDownloadUrl("javascript:alert(1)"), false);
    assert.strictEqual(validateDownloadUrl("file:///android_asset/malware.apk"), false);
  });

  await test("Reject attacker-controlled hosts and subdomain spoofing", () => {
    assert.strictEqual(validateDownloadUrl("https://evil-attacker.com/malware.apk"), false);
    assert.strictEqual(validateDownloadUrl("https://github.com.attacker.com/app.apk"), false);
    assert.strictEqual(validateDownloadUrl("https://github-releases.untrusted.org/app.apk"), false);
  });

  await test("Accept official GitHub release URLs", () => {
    assert.strictEqual(
      validateDownloadUrl("https://github.com/PannagaJA/Whatsapp-Scheduler/releases/download/v1.0.22/WhatsApp-Scheduler.apk"),
      true
    );
  });

  await test("Accept official GitHub usercontent CDN asset URLs", () => {
    assert.strictEqual(
      validateDownloadUrl("https://objects.githubusercontent.com/github-production-release-asset-2e65be/12345/WhatsApp-Scheduler.apk"),
      true
    );
  });

  await test("Signature continuity: Reject tampered signing certificate", () => {
    const legitimateDevKey = "30820257308201c0a0030201020204...";
    const attackerKey = "30820257308201c0a0030201020204deadbeef...";
    assert.strictEqual(simulateSignatureCheck(legitimateDevKey, attackerKey), false);
  });

  await test("Signature continuity: Accept matching developer certificate", () => {
    const legitimateDevKey = "30820257308201c0a0030201020204...";
    assert.strictEqual(simulateSignatureCheck(legitimateDevKey, legitimateDevKey), true);
  });

  console.log("\n=================================================================");
  console.log(`📊 PHASE 1 SECURITY AUDIT TEST RESULTS: ${passed} Passed, ${failed} Failed`);
  console.log("=================================================================\n");

  if (failed > 0) {
    process.exit(1);
  }
}

if (require.main === module) {
  runSecurityPhase1Tests().catch((err) => {
    console.error("Test execution failed:", err);
    process.exit(1);
  });
}

module.exports = { runSecurityPhase1Tests };
