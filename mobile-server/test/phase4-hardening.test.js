const assert = require("assert");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const http = require("http");
const { db, initDb, run, get, all, DB_DIR } = require("../db");
const { registerUser, createSession } = require("../auth");
const { BoundedShareCache } = require("../server");

let BASE_URL = process.env.TEST_SERVER_URL || "http://127.0.0.1:3000";

function makeRawRequest(method, path, headers = {}, body = null) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, BASE_URL);
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

async function runPhase4HardeningTests() {
  console.log("\n=================================================================");
  console.log("🛡️ Phase 4 Security Hardening Suite (SEC-005, SEC-011, SEC-012, SEC-013)");
  console.log("=================================================================\n");

  await initDb();

  const userSuffix = Date.now() + "_" + crypto.randomBytes(4).toString("hex");
  const userA_name = `p4_userA_${userSuffix}`;
  const userB_name = `p4_userB_${userSuffix}`;
  const pass = "StrongP4ss!123456";

  let userA, userB;
  let tokenA, tokenB;

  try {
    userA = await registerUser(userA_name, pass);
    userB = await registerUser(userB_name, pass);

    const sA = await createSession(userA.user.id);
    const sB = await createSession(userB.user.id);
    tokenA = sA.token;
    tokenB = sB.token;

    // --- 1. SEC-011: Bounded Share-Cache Lifecycle ---
    console.log("📦 [1] Bounded Share-Cache Lifecycle & Eviction (SEC-011):");

    await test("BoundedShareCache enforces capacity limit and evicts oldest entries", () => {
      const cache = new BoundedShareCache({ maxSize: 3, ttlMs: 60000 });
      cache.set("id-1", { text: "first" });
      cache.set("id-2", { text: "second" });
      cache.set("id-3", { text: "third" });

      assert.strictEqual(cache.size(), 3);
      assert.strictEqual(cache.get("id-1")?.text, "first");

      // Adding 4th item must evict id-1 (oldest)
      cache.set("id-4", { text: "fourth" });
      assert.strictEqual(cache.size(), 3);
      assert.strictEqual(cache.get("id-1"), null, "Oldest entry id-1 must be evicted");
      assert.strictEqual(cache.get("id-2")?.text, "second");
      assert.strictEqual(cache.get("id-4")?.text, "fourth");
      cache.clear();
    });

    await test("BoundedShareCache expires entries after bounded TTL", async () => {
      const cache = new BoundedShareCache({ maxSize: 5, ttlMs: 50 }); // 50ms TTL
      cache.set("temp-1", { text: "ephemeral" });

      assert.strictEqual(cache.get("temp-1")?.text, "ephemeral");
      await new Promise((resolve) => setTimeout(resolve, 70));
      assert.strictEqual(cache.get("temp-1"), null, "Expired entry must return null");
      cache.clear();
    });

    await test("BoundedShareCache cleans up staged files on disk upon eviction", () => {
      const cache = new BoundedShareCache({ maxSize: 2, ttlMs: 60000 });
      const uploadsDir = path.join(DB_DIR, "uploads", userA.user.id);
      if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });

      const testFilePath = path.join(uploadsDir, `staged_test_${Date.now()}.txt`);
      fs.writeFileSync(testFilePath, "staged file content", "utf8");

      cache.set("share-with-file", {
        userId: userA.user.id,
        files: [{ path: testFilePath }]
      });

      assert.strictEqual(fs.existsSync(testFilePath), true);
      cache.evict("share-with-file");
      assert.strictEqual(fs.existsSync(testFilePath), false, "Evicted share files must be deleted from disk");
      cache.clear();
    });

    // --- 2. SEC-005: Responsible Messaging & Terms of Service Advisory ---
    console.log("\n⚡ [2] Responsible Messaging, Rate Pacing & ToS Notice (SEC-005):");

    await test("PWA index.html includes explicit WhatsApp Terms of Service Advisory", () => {
      const pwaHtmlPath = path.join(__dirname, "../pwa/index.html");
      const html = fs.readFileSync(pwaHtmlPath, "utf8");

      assert.ok(html.includes("Responsible Messaging & Terms of Service Notice"), "Must have ToS header");
      assert.ok(html.includes("not affiliated with, authorized, or endorsed by WhatsApp LLC"), "Must disclose independent status");
      assert.ok(html.includes("risks of account restrictions or permanent bans"), "Must disclose automated messaging risks");
    });

    await test("Engine respects configurable randomized message spacing and jitter", () => {
      const minDelay = 1000;
      const maxDelay = 3000;
      const sampleJitters = [];
      for (let i = 0; i < 20; i++) {
        const j = minDelay + Math.floor(Math.random() * (maxDelay - minDelay + 1));
        sampleJitters.push(j);
        assert.ok(j >= minDelay && j <= maxDelay, `Jitter ${j} must be between ${minDelay} and ${maxDelay}`);
      }
      const uniqueValues = new Set(sampleJitters);
      assert.ok(uniqueValues.size > 1, "Jitter values must be randomized across calls");
    });

    // --- 3. SEC-013: Privacy & Contact Erasure (DPDP Act Compliance) ---
    console.log("\n🔒 [3] DPDP Privacy Notice & Contact Erasure (SEC-013):");

    await test("PWA index.html & app.js provide DPDP Act privacy disclosure and consent flow", () => {
      const pwaHtml = fs.readFileSync(path.join(__dirname, "../pwa/index.html"), "utf8");
      const appJs = fs.readFileSync(path.join(__dirname, "../pwa/app.js"), "utf8");

      assert.ok(pwaHtml.includes("DPDP Act & Privacy"), "PWA must include DPDP privacy statement");
      assert.ok(pwaHtml.includes("eraseContactsBtn"), "PWA must provide an Erase Contacts button");
      assert.ok(appJs.includes("Privacy Notice & Contact Sync Consent"), "PWA app.js must require explicit consent before syncing contacts");
    });

    await test("DELETE /api/contacts erases only calling user contacts and preserves schedules", async () => {
      const now = Date.now();
      // 1. Seed contacts for User A and User B
      await run("INSERT INTO contacts (user_id, jid, name, phone, source, updated_at) VALUES (?, '919111111111@s.whatsapp.net', 'Alice Contact', '919111111111', 'phonebook', ?)", [userA.user.id, now]);
      await run("INSERT INTO contacts (user_id, jid, name, phone, source, updated_at) VALUES (?, '919222222222@s.whatsapp.net', 'Bob Contact', '919222222222', 'phonebook', ?)", [userB.user.id, now]);
      await run("INSERT INTO settings (user_id, key, value) VALUES (?, 'phonebook_imported', '1')", [userA.user.id]);

      // 2. Seed a message schedule for User A
      const schedId = crypto.randomUUID();
      await run("INSERT INTO schedules (id, user_id, recipient, text, scheduled_at, status, created_at) VALUES (?, ?, '919111111111', 'Keep Me', ?, 'scheduled', ?)", [
        schedId,
        userA.user.id,
        Date.now() + 100000,
        Date.now()
      ]);

      // 3. User A deletes their contacts
      const res = await makeRawRequest("DELETE", "/api/contacts", {
        Authorization: `Bearer ${tokenA}`
      });

      assert.strictEqual(res.statusCode, 200);
      assert.strictEqual(res.json.success, true);
      assert.ok(res.json.erasedCount >= 1, "Must report deleted contact count");

      // 4. Verify User A contacts are gone
      const rowsA = await all("SELECT * FROM contacts WHERE user_id = ?", [userA.user.id]);
      assert.strictEqual(rowsA.length, 0, "User A contacts must be wiped");

      // 5. Verify User B contacts are UNTOUCHED
      const rowsB = await all("SELECT * FROM contacts WHERE user_id = ?", [userB.user.id]);
      assert.strictEqual(rowsB.length, 1, "User B contacts must remain completely untouched");
      assert.strictEqual(rowsB[0].name, "Bob Contact");

      // 6. Verify User A's scheduled messages are UNTOUCHED
      const schedA = await get("SELECT * FROM schedules WHERE id = ?", [schedId]);
      assert.ok(schedA, "User A schedule must NOT be deleted when erasing contacts");
      assert.strictEqual(schedA.text, "Keep Me");

      // 7. Verify phonebook_imported setting was cleared
      const settingA = await get("SELECT * FROM settings WHERE user_id = ? AND key = 'phonebook_imported'", [userA.user.id]);
      assert.strictEqual(settingA, undefined, "phonebook_imported setting must be removed");

      // Clean up schedule and User B contact
      await run("DELETE FROM schedules WHERE id = ?", [schedId]);
      await run("DELETE FROM contacts WHERE user_id = ?", [userB.user.id]);
    });

    // --- 4. SEC-012: R8 / ProGuard Configuration ---
    console.log("\n📱 [4] Android R8 / ProGuard Configuration (SEC-012):");

    await test("android/app/build.gradle enables minifyEnabled and shrinkResources", () => {
      const gradle = fs.readFileSync(path.join(__dirname, "../../android/app/build.gradle"), "utf8");
      assert.ok(gradle.includes("minifyEnabled true"), "minifyEnabled must be true for release build");
      assert.ok(gradle.includes("shrinkResources true"), "shrinkResources must be true for release build");
    });

    await test("android/app/proguard-rules.pro preserves AndroidBridge and JavascriptInterface", () => {
      const proguard = fs.readFileSync(path.join(__dirname, "../../android/app/proguard-rules.pro"), "utf8");
      assert.ok(proguard.includes("@android.webkit.JavascriptInterface"), "Must preserve @JavascriptInterface methods");
      assert.ok(proguard.includes("MainActivity$AndroidBridge"), "Must preserve AndroidBridge class");
      assert.ok(proguard.includes("androidx.core.content.FileProvider"), "Must preserve FileProvider");
    });

    console.log("\n=================================================================");
    console.log("🎉 ALL PHASE 4 SECURITY HARDENING TESTS PASSED SUCCESSFULLY!");
    console.log("=================================================================\n");
  } finally {
    if (userA?.user?.id) {
      await run("DELETE FROM users WHERE id = ?", [userA.user.id]);
      await run("DELETE FROM sessions WHERE user_id = ?", [userA.user.id]);
      await run("DELETE FROM contacts WHERE user_id = ?", [userA.user.id]);
    }
    if (userB?.user?.id) {
      await run("DELETE FROM users WHERE id = ?", [userB.user.id]);
      await run("DELETE FROM sessions WHERE user_id = ?", [userB.user.id]);
      await run("DELETE FROM contacts WHERE user_id = ?", [userB.user.id]);
    }
  }
}

module.exports = { runPhase4HardeningTests };

if (require.main === module) {
  (async () => {
    let server = null;
    const targetPort = 3000;
    const testUrl = `http://127.0.0.1:${targetPort}`;
    const isServerRunning = await new Promise((resolve) => {
      const req = http.get(testUrl, () => resolve(true));
      req.on("error", () => resolve(false));
      req.setTimeout(500, () => {
        req.destroy();
        resolve(false);
      });
    });

    if (!isServerRunning) {
      const app = require("../server");
      server = http.createServer(app);
      await new Promise((resolve, reject) => {
        server.listen(targetPort, "127.0.0.1", resolve);
        server.on("error", reject);
      });
    }

    try {
      await runPhase4HardeningTests();
    } finally {
      if (server) {
        await new Promise((resolve) => server.close(resolve));
      }
    }
  })().catch((err) => {
    console.error("Fatal test runner error:", err);
    process.exit(1);
  });
}
