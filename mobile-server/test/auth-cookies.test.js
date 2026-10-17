const assert = require("assert");
const http = require("http");
const crypto = require("crypto");
const { db, initDb, run, get } = require("../db");
const {
  registerUser,
  authenticateUser,
  createSession,
  generateCsrfToken,
  parseCookies
} = require("../auth");

let BASE_URL = process.env.TEST_SERVER_URL || "http://127.0.0.1:3000";

function makeRawRequest(method, path, headers = {}, body = null) {
  return new Promise((resolve, reject) => {
    const activeBase = process.env.TEST_SERVER_URL || BASE_URL;
    const url = new URL(path, activeBase);
    const reqHeaders = { ...headers };
    let reqBody = null;

    if (body) {
      if (typeof body === "object") {
        reqBody = JSON.stringify(body);
        reqHeaders["Content-Type"] = "application/json";
      } else {
        reqBody = String(body);
      }
      reqHeaders["Content-Length"] = Buffer.byteLength(reqBody);
    }

    const options = {
      method,
      hostname: url.hostname,
      port: url.port,
      path: url.pathname + url.search,
      headers: reqHeaders
    };

    const req = http.request(options, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        let json = null;
        try {
          json = JSON.parse(data);
        } catch (_) {}
        resolve({
          statusCode: res.statusCode,
          headers: res.headers,
          rawBody: data,
          json
        });
      });
    });

    req.on("error", reject);
    if (reqBody) req.write(reqBody);
    req.end();
  });
}

function extractCookiesFromHeaders(setCookieHeader) {
  if (!setCookieHeader) return {};
  const cookies = {};
  const headers = Array.isArray(setCookieHeader) ? setCookieHeader : [setCookieHeader];
  for (const h of headers) {
    const parts = h.split(";").map((p) => p.trim());
    const [name, val] = parts[0].split("=");
    cookies[name] = {
      value: val,
      httpOnly: parts.some((p) => p.toLowerCase() === "httponly"),
      sameSite: (parts.find((p) => p.toLowerCase().startsWith("samesite=")) || "").split("=")[1],
      maxAge: (parts.find((p) => p.toLowerCase().startsWith("max-age=")) || "").split("=")[1],
      path: (parts.find((p) => p.toLowerCase().startsWith("path=")) || "").split("=")[1]
    };
  }
  return cookies;
}

async function test(name, fn) {
  try {
    await fn();
    console.log(`  ✅ PASS: ${name}`);
  } catch (err) {
    console.error(`  ❌ FAIL: ${name}`);
    console.error(`     Error: ${err.message}`);
    throw err;
  }
}

async function runAuthCookieTests() {
  console.log("\n=================================================================");
  console.log("🍪 SEC-009: Secure Authentication Cookies & CSRF Protection Test Suite");
  console.log("=================================================================\n");

  await initDb();

  const userSuffix = Date.now() + "_" + crypto.randomBytes(4).toString("hex");
  const testUser = `cookie_user_${userSuffix}`;
  const testPass = "CookiePass!123456";
  const adminUser = `cookie_admin_${userSuffix}`;
  const adminPass = "CookieAdmin!123456";

  let normalReg;
  let adminReg;

  try {
    const { loginLimiterInstance } = require("../rateLimiter");
    if (loginLimiterInstance) loginLimiterInstance.reset();

    normalReg = await registerUser(testUser, testPass);
    adminReg = await registerUser(adminUser, adminPass);
    await run("UPDATE users SET role = 'admin' WHERE id = ?", [adminReg.user.id]);

    // --- 1. Login Sets HttpOnly and CSRF Cookies ---
    console.log("🔐 [1] Login Cookie Issuance & Flags:");

    let loginCookies = {};
    let sessionToken = "";
    let csrfToken = "";

    await test("Login endpoint issues HttpOnly wa_session cookie and wa_csrf cookie", async () => {
      const res = await makeRawRequest("POST", "/api/auth/login", {}, {
        username: testUser,
        password: testPass
      });

      assert.strictEqual(res.statusCode, 200);
      assert.strictEqual(res.json.success, true);
      assert.ok(res.json.csrfToken, "Login response must provide csrfToken");

      csrfToken = res.json.csrfToken;
      sessionToken = res.json.token;

      loginCookies = extractCookiesFromHeaders(res.headers["set-cookie"]);

      assert.ok(loginCookies.wa_session, "Must set wa_session cookie");
      assert.strictEqual(loginCookies.wa_session.httpOnly, true, "wa_session must have HttpOnly flag");
      assert.strictEqual(loginCookies.wa_session.sameSite?.toLowerCase(), "lax", "wa_session must have SameSite=Lax");
      assert.strictEqual(loginCookies.wa_session.path, "/", "wa_session must have Path=/");

      assert.ok(loginCookies.wa_csrf, "Must set wa_csrf cookie");
      assert.strictEqual(loginCookies.wa_csrf.httpOnly, false, "wa_csrf must NOT be HttpOnly so client JS can read it");
      assert.strictEqual(loginCookies.wa_csrf.sameSite?.toLowerCase(), "lax", "wa_csrf must have SameSite=Lax");
    });

    // --- 2. Authenticated Cookie Requests ---
    console.log("\n🍪 [2] Authenticated Cookie Requests & Me Endpoint:");

    await test("GET /api/auth/me succeeds using Cookie header", async () => {
      const res = await makeRawRequest("GET", "/api/auth/me", {
        Cookie: `wa_session=${loginCookies.wa_session.value}`
      });

      assert.strictEqual(res.statusCode, 200);
      assert.strictEqual(res.json.success, true);
      assert.strictEqual(res.json.user.username, testUser);
      assert.strictEqual(res.json.csrfToken, csrfToken);
    });

    // --- 3. CSRF Protection on State-Changing Requests ---
    console.log("\n🛡️ [3] CSRF Defenses on State-Changing Requests:");

    await test("Cookie-authenticated POST fails with 403 when X-CSRF-Token is missing", async () => {
      const res = await makeRawRequest("POST", "/api/schedules", {
        Cookie: `wa_session=${loginCookies.wa_session.value}`
      }, {
        recipient: "919999999999",
        text: "CSRF probe without token",
        scheduledAt: Date.now() + 60000
      });

      assert.strictEqual(res.statusCode, 403);
      assert.strictEqual(res.json.success, false);
      assert.ok(res.json.error.includes("CSRF validation failed"), "Must report CSRF failure");
    });

    await test("Cookie-authenticated POST fails with 403 when X-CSRF-Token is invalid/tampered", async () => {
      const res = await makeRawRequest("POST", "/api/schedules", {
        Cookie: `wa_session=${loginCookies.wa_session.value}`,
        "X-CSRF-Token": "tampered_fake_csrf_token_1234567890abcdef"
      }, {
        recipient: "919999999999",
        text: "CSRF probe with invalid token",
        scheduledAt: Date.now() + 60000
      });

      assert.strictEqual(res.statusCode, 403);
      assert.strictEqual(res.json.success, false);
      assert.ok(res.json.error.includes("CSRF validation failed"), "Must reject invalid CSRF token");
    });

    await test("Cookie-authenticated POST succeeds when valid X-CSRF-Token is supplied", async () => {
      const res = await makeRawRequest("POST", "/api/schedules", {
        Cookie: `wa_session=${loginCookies.wa_session.value}`,
        "X-CSRF-Token": csrfToken
      }, {
        recipient: "919999999999",
        text: "Legitimate schedule with CSRF token",
        scheduledAt: Date.now() + 60000
      });

      assert.strictEqual(res.statusCode, 200);
      assert.strictEqual(res.json.success, true);
      const scheduleId = res.json.schedule?.id || res.json.id;
      assert.ok(scheduleId, "Must return created schedule id");

      // Clean up schedule
      await run("DELETE FROM schedules WHERE id = ?", [scheduleId]);
    });

    // --- 4. Dual-Stack Support (Bearer Token Requests) ---
    console.log("\n🔄 [4] Dual-Stack API / Mobile Compatibility:");

    await test("Authorization: Bearer <token> requests succeed without requiring CSRF header", async () => {
      const res = await makeRawRequest("POST", "/api/schedules", {
        Authorization: `Bearer ${sessionToken}`
      }, {
        recipient: "919999999999",
        text: "Bearer token schedule without CSRF token",
        scheduledAt: Date.now() + 60000
      });

      assert.strictEqual(res.statusCode, 200);
      assert.strictEqual(res.json.success, true);
      const scheduleId = res.json.schedule?.id || res.json.id;
      assert.ok(scheduleId, "Must return created schedule id");
      await run("DELETE FROM schedules WHERE id = ?", [scheduleId]);
    });

    // --- 5. Role-Based Permissions Over Cookies ---
    console.log("\n👑 [5] Role-Based Access Control via Cookies:");

    await test("Regular user cookie accessing /api/admin/users is rejected with 403", async () => {
      const res = await makeRawRequest("GET", "/api/admin/users", {
        Cookie: `wa_session=${loginCookies.wa_session.value}`
      });

      assert.strictEqual(res.statusCode, 403);
      assert.strictEqual(res.json.success, false);
      assert.ok(res.json.error.includes("Administrator privileges required"));
    });

    await test("Admin user cookie accessing /api/admin/users succeeds with 200", async () => {
      const adminLogin = await makeRawRequest("POST", "/api/auth/login", {}, {
        username: adminUser,
        password: adminPass
      });
      const adminCookies = extractCookiesFromHeaders(adminLogin.headers["set-cookie"]);

      const res = await makeRawRequest("GET", "/api/admin/users", {
        Cookie: `wa_session=${adminCookies.wa_session.value}`
      });

      assert.strictEqual(res.statusCode, 200);
      assert.strictEqual(res.json.success, true);
      assert.ok(Array.isArray(res.json.users));
    });

    // --- 6. Logout and Expiry ---
    console.log("\n🚪 [6] Logout & Cookie Invalidation:");

    await test("Logout with cookie clears wa_session and wa_csrf cookies with Max-Age=0", async () => {
      const logoutRes = await makeRawRequest("POST", "/api/auth/logout", {
        Cookie: `wa_session=${loginCookies.wa_session.value}`,
        "X-CSRF-Token": csrfToken
      });

      assert.strictEqual(logoutRes.statusCode, 200);
      assert.strictEqual(logoutRes.json.success, true);

      const logoutCookies = extractCookiesFromHeaders(logoutRes.headers["set-cookie"]);
      assert.ok(logoutCookies.wa_session);
      assert.strictEqual(logoutCookies.wa_session.maxAge, "0", "wa_session must be cleared with Max-Age=0");
      assert.ok(logoutCookies.wa_csrf);
      assert.strictEqual(logoutCookies.wa_csrf.maxAge, "0", "wa_csrf must be cleared with Max-Age=0");

      // Verify old cookie returns 401
      const meAfterLogout = await makeRawRequest("GET", "/api/auth/me", {
        Cookie: `wa_session=${loginCookies.wa_session.value}`
      });
      assert.strictEqual(meAfterLogout.statusCode, 401);
    });

    await test("Expired session cookie returns HTTP 401", async () => {
      // Create deliberately expired session in database
      const expiredToken = crypto.randomBytes(32).toString("hex");
      const pastTime = Date.now() - 10000;
      await run("INSERT INTO sessions (token, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)", [
        expiredToken,
        normalReg.user.id,
        pastTime - 10000,
        pastTime
      ]);

      const res = await makeRawRequest("GET", "/api/auth/me", {
        Cookie: `wa_session=${expiredToken}`
      });
      assert.strictEqual(res.statusCode, 401);

      await run("DELETE FROM sessions WHERE token = ?", [expiredToken]);
    });

    // --- 7. CORS & Preflight Credential Headers ---
    console.log("\n🌐 [7] CORS & Preflight Allowed Headers:");

    await test("OPTIONS preflight from allowed origin includes X-CSRF-Token and credentials", async () => {
      const res = await makeRawRequest("OPTIONS", "/api/auth/me", {
        Origin: "http://localhost:3000",
        "Access-Control-Request-Method": "GET",
        "Access-Control-Request-Headers": "authorization, content-type, x-csrf-token"
      });

      assert.strictEqual(res.statusCode, 204);
      assert.strictEqual(res.headers["access-control-allow-origin"], "http://localhost:3000");
      assert.strictEqual(res.headers["access-control-allow-credentials"], "true");
      assert.ok(res.headers["access-control-allow-headers"].includes("X-CSRF-Token"));
    });

    console.log("\n=================================================================");
    console.log("🎉 ALL AUTH COOKIE & CSRF TESTS PASSED SUCCESSFULLY!");
    console.log("=================================================================\n");
  } finally {
    if (normalReg?.user?.id) {
      await run("DELETE FROM users WHERE id = ?", [normalReg.user.id]);
      await run("DELETE FROM sessions WHERE user_id = ?", [normalReg.user.id]);
    }
    if (adminReg?.user?.id) {
      await run("DELETE FROM users WHERE id = ?", [adminReg.user.id]);
      await run("DELETE FROM sessions WHERE user_id = ?", [adminReg.user.id]);
    }
  }
}

module.exports = { runAuthCookieTests };

if (require.main === module) {
  runAuthCookieTests().catch(() => process.exit(1));
}
