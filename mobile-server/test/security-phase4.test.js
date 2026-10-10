const assert = require("assert");
const http = require("http");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const { db, run, get, all, DB_DIR } = require("../db");
const { createSession, hashPassword } = require("../auth");

const BASE_URL = process.env.TEST_SERVER_URL || "http://127.0.0.1:3000";

async function request(reqPath, options = {}) {
  const url = new URL(reqPath, BASE_URL);
  return new Promise((resolve, reject) => {
    const req = http.request(
      url,
      {
        method: options.method || "GET",
        headers: {
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
      if (Buffer.isBuffer(options.body)) {
        req.write(options.body);
      } else if (typeof options.body === "string") {
        req.write(options.body);
      } else {
        req.write(JSON.stringify(options.body));
      }
    }
    req.end();
  });
}

function buildMultipartFormData(fields, files) {
  const boundary = "----WebKitFormBoundary" + crypto.randomBytes(16).toString("hex");
  const chunks = [];

  for (const [key, value] of Object.entries(fields)) {
    chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${key}"\r\n\r\n${value}\r\n`));
  }

  for (const file of files) {
    chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${file.field}"; filename="${file.filename}"\r\nContent-Type: ${file.mimetype}\r\n\r\n`));
    chunks.push(file.content);
    chunks.push(Buffer.from("\r\n"));
  }

  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return {
    boundary,
    body: Buffer.concat(chunks)
  };
}

async function runSecurityPhase4Tests() {
  console.log("=================================================================");
  console.log("🧪 Comprehensive Phase 4 End-to-End Security & Integration Gate");
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

  // Setup test user
  const testUserId = crypto.randomUUID();
  const testUserPassHash = hashPassword("TestUserPassword123!");
  await run(
    "INSERT OR REPLACE INTO users (id, username, password_hash, role, created_at) VALUES (?, ?, ?, 'user', ?)",
    [testUserId, `e2e_user_${Date.now().toString(36)}`, testUserPassHash, Date.now()]
  );
  const session = await createSession(testUserId);
  const token = session.token;

  // --- A. Real Multipart HTTP Upload & Magic Byte Integration Gate ---
  console.log("📦 [A] End-to-End Multipart Upload & File Validation Integration:");

  await test("Multipart schedule creation with genuine PNG file succeeds (200 OK)", async () => {
    const validPngBuffer = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0x00, 0x00, 0x00, 0x0D]);
    const { boundary, body } = buildMultipartFormData(
      {
        recipient: "919988776655",
        text: "E2E Attachment Test",
        scheduledAt: (Date.now() + 600000).toString()
      },
      [
        {
          field: "attachments",
          filename: "sample_photo.png",
          mimetype: "image/png",
          content: validPngBuffer
        }
      ]
    );

    const res = await request("/api/schedules", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": `multipart/form-data; boundary=${boundary}`
      },
      body
    });

    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.success, true);
    assert.strictEqual(res.body.schedule.attachments.length, 1);
    assert.strictEqual(res.body.schedule.attachments[0].name, "sample_photo.png");

    // Clean up created schedule
    await run("DELETE FROM schedules WHERE id = ?", [res.body.schedule.id]);
  });

  await test("Multipart schedule creation with spoofed executable disguised as .png is rejected (400)", async () => {
    const fakePngBuffer = Buffer.from([0x4D, 0x5A, 0x90, 0x00, 0x03, 0x00]); // Windows MZ
    const { boundary, body } = buildMultipartFormData(
      {
        recipient: "919988776655",
        text: "Malware Attack Attempt",
        scheduledAt: (Date.now() + 600000).toString()
      },
      [
        {
          field: "attachments",
          filename: "innocent.png",
          mimetype: "image/png",
          content: fakePngBuffer
        }
      ]
    );

    const res = await request("/api/schedules", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": `multipart/form-data; boundary=${boundary}`
      },
      body
    });

    assert.strictEqual(res.status, 400, "Must return 400 for disguised executable");
    assert.strictEqual(res.body.success, false);
    assert.ok(res.body.error.includes("Invalid attachment"));
  });

  // --- B. Sensitive Information & Log Sanitization Check ---
  console.log("\n🔒 [B] Sensitive Information & Error Response Sanitization:");

  await test("Error responses do not leak internal paths, stack traces, or DB schemas", async () => {
    const res = await request("/api/schedules/nonexistent-uuid", {
      method: "DELETE",
      headers: { Authorization: `Bearer ${token}` }
    });
    assert.strictEqual(res.status, 404);
    assert.strictEqual(res.body.success, false);
    assert.strictEqual(res.body.error, "Schedule not found");
    assert.strictEqual(res.body.stack, undefined);
  });

  await test("GET /api/auth/me returns safe user object without password_hash", async () => {
    const res = await request("/api/auth/me", {
      headers: { Authorization: `Bearer ${token}` }
    });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.success, true);
    assert.strictEqual(res.body.user.id, testUserId);
    assert.strictEqual(res.body.user.password_hash, undefined, "password_hash must NEVER be exposed in auth responses");
  });

  // --- C. Admin Setup Flow Lockdown Verification ---
  console.log("\n🛡️ [C] First-Admin Setup Flow Lockdown Verification:");

  await test("Setup is marked closed when users exist", async () => {
    const res = await request("/api/auth/setup-status");
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.setupRequired, false, "Setup must not be required when users exist");
  });

  // Clean up test user
  await run("DELETE FROM users WHERE id = ?", [testUserId]);
  await run("DELETE FROM sessions WHERE user_id = ?", [testUserId]);

  console.log(`\n=================================================================`);
  console.log(`Phase 4 Integration Suite: ${passed} Passed, ${failed} Failed`);
  console.log(`=================================================================\n`);

  if (failed > 0) {
    process.exit(1);
  }
}

if (require.main === module) {
  runSecurityPhase4Tests()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error("Test execution failed:", err);
      process.exit(1);
    });
}

module.exports = { runSecurityPhase4Tests };
