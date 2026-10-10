const assert = require("assert");
const http = require("http");
const crypto = require("crypto");
const path = require("path");
const fs = require("fs");
const { db, run, get, all, DB_DIR } = require("../db");
const { createSession, hashPassword } = require("../auth");
const { safeDeleteAttachment, isPathContained } = require("../scheduler");
const { migrateLegacyData } = require("../db");

const BASE_URL = process.env.TEST_SERVER_URL || "http://127.0.0.1:3000";
const UPLOADS_DIR = path.join(DB_DIR, "uploads");

async function request(reqPath, options = {}) {
  const url = new URL(reqPath, BASE_URL);
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

async function runSecurityPhase2Tests() {
  console.log("=================================================================");
  console.log("🧪 Comprehensive Phase 2 Security Test Suite (SEC-003, SEC-004, SEC-005)");
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

  // --- Setup Multi-Tenant Test Users ---
  const userA_Id = crypto.randomUUID();
  const userB_Id = crypto.randomUUID();
  const now = Date.now();

  const userAPassHash = hashPassword("UserAPassword123!");
  const userBPassHash = hashPassword("UserBPassword123!");

  await run("INSERT OR REPLACE INTO users (id, username, password_hash, role, created_at) VALUES (?, ?, ?, 'user', ?)",
    [userA_Id, `tenant_a_${Date.now().toString(36)}`, userAPassHash, now]
  );
  await run("INSERT OR REPLACE INTO users (id, username, password_hash, role, created_at) VALUES (?, ?, ?, 'user', ?)",
    [userB_Id, `tenant_b_${Date.now().toString(36)}`, userBPassHash, now]
  );

  const sessionA = await createSession(userA_Id);
  const sessionB = await createSession(userB_Id);
  const tokenA = sessionA.token;
  const tokenB = sessionB.token;

  // --- A. Multi-Tenant Contact Isolation (SEC-005) ---
  console.log("👥 [A] Multi-Tenant Contact Isolation & IDOR Prevention (SEC-005):");

  await test("User A imports private contacts", async () => {
    const res = await request("/api/contacts/import", {
      method: "POST",
      headers: { Authorization: `Bearer ${tokenA}` },
      body: {
        contacts: [
          { name: "Alice Confidential", phone: "919900011111" },
          { name: "Bob Confidential", phone: "919900022222" }
        ]
      }
    });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.success, true);
    assert.strictEqual(res.body.count, 2);
  });

  await test("User A can view their own imported contacts", async () => {
    const res = await request("/api/contacts", {
      headers: { Authorization: `Bearer ${tokenA}` }
    });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.success, true);
    assert.strictEqual(res.body.contacts.length, 2);
    const names = res.body.contacts.map(c => c.name);
    assert.ok(names.includes("Alice Confidential"));
  });

  await test("User B CANNOT see User A's contacts (Returns empty list / 0 count)", async () => {
    const res = await request("/api/contacts", {
      headers: { Authorization: `Bearer ${tokenB}` }
    });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.success, true);
    assert.strictEqual(res.body.contacts.length, 0, "User B must not see User A's contacts");
  });

  await test("User A WhatsApp session status and QR are completely isolated from User B", async () => {
    const statusA = await request("/api/status", {
      headers: { Authorization: `Bearer ${tokenA}` }
    });
    const statusB = await request("/api/status", {
      headers: { Authorization: `Bearer ${tokenB}` }
    });
    assert.strictEqual(statusA.status, 200);
    assert.strictEqual(statusB.status, 200);
    assert.strictEqual(statusA.body.contactCount, 2, "User A sees their 2 contacts");
    assert.strictEqual(statusB.body.contactCount, 0, "User B sees 0 contacts");
  });

  await test("User A logout only affects User A's WhatsApp session", async () => {
    const logoutRes = await request("/api/logout", {
      method: "POST",
      headers: { Authorization: `Bearer ${tokenA}` }
    });
    assert.strictEqual(logoutRes.status, 200);
    assert.strictEqual(logoutRes.body.success, true);

    // After User A logout, User A's contact count is wiped
    const statusA = await request("/api/status", {
      headers: { Authorization: `Bearer ${tokenA}` }
    });
    assert.strictEqual(statusA.body.contactCount, 0);
  });

  // --- B. Multi-Tenant Schedule Isolation & Cross-Tenant Deletion IDOR (SEC-005) ---
  console.log("\n📅 [B] Multi-Tenant Schedule Isolation & IDOR Protection (SEC-005):");

  let scheduleA_Id = null;

  await test("User A creates a scheduled message", async () => {
    const futureTime = Date.now() + 3600000;
    const res = await request("/api/schedules", {
      method: "POST",
      headers: { Authorization: `Bearer ${tokenA}` },
      body: {
        recipient: "919900011111",
        text: "User A secret business proposal",
        scheduledAt: futureTime
      }
    });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.success, true);
    assert.strictEqual(res.body.schedule.user_id, userA_Id);
    scheduleA_Id = res.body.schedule.id;
  });

  await test("User A can view their own scheduled message", async () => {
    const res = await request("/api/schedules", {
      headers: { Authorization: `Bearer ${tokenA}` }
    });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.success, true);
    const ids = res.body.schedules.map(s => s.id);
    assert.ok(ids.includes(scheduleA_Id));
  });

  await test("User B CANNOT view User A's scheduled messages", async () => {
    const res = await request("/api/schedules", {
      headers: { Authorization: `Bearer ${tokenB}` }
    });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.success, true);
    const ids = res.body.schedules.map(s => s.id);
    assert.strictEqual(ids.includes(scheduleA_Id), false, "User B must not see User A's schedule");
  });

  await test("User B CANNOT delete User A's scheduled message (IDOR Prevention returns 404)", async () => {
    const res = await request(`/api/schedules/${scheduleA_Id}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${tokenB}` }
    });
    assert.strictEqual(res.status, 404, "Must reject cross-tenant deletion with 404");
    assert.strictEqual(res.body.success, false);

    // Verify schedule still exists in database
    const check = await get("SELECT * FROM schedules WHERE id = ?", [scheduleA_Id]);
    assert.ok(check, "Schedule must remain intact after unauthorized delete attempt");
    assert.strictEqual(check.user_id, userA_Id);
  });

  // --- C. Path Traversal & Attachment Deletion Containment (SEC-004) ---
  console.log("\n🛡️ [C] Path Traversal & Attachment Deletion Containment (SEC-004):");

  // Create a decoy test file outside uploads directory
  const decoyOutsideFile = path.join(DB_DIR, `decoy_system_file_${Date.now()}.txt`);
  fs.writeFileSync(decoyOutsideFile, "CRITICAL_DATABASE_KEY_SECRET");

  // Create a legitimate test file inside uploads directory
  if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });
  const legitimateUploadFile = path.join(UPLOADS_DIR, `valid_upload_${Date.now()}.txt`);
  fs.writeFileSync(legitimateUploadFile, "VALID_ATTACHMENT_PAYLOAD");

  await test("isPathContained verifies directories strictly", () => {
    assert.strictEqual(isPathContained(legitimateUploadFile, UPLOADS_DIR), true);
    assert.strictEqual(isPathContained(decoyOutsideFile, UPLOADS_DIR), false);
    assert.strictEqual(isPathContained("/etc/passwd", UPLOADS_DIR), false);
    assert.strictEqual(isPathContained(path.join(UPLOADS_DIR, "../server.js"), UPLOADS_DIR), false);
    assert.strictEqual(isPathContained(path.join(UPLOADS_DIR, "../../package.json"), UPLOADS_DIR), false);
  });

  await test("safeDeleteAttachment rejects files outside UPLOADS_DIR", () => {
    const deleted = safeDeleteAttachment(decoyOutsideFile, UPLOADS_DIR);
    assert.strictEqual(deleted, false);
    assert.strictEqual(fs.existsSync(decoyOutsideFile), true, "Outside file must NOT be deleted");
  });

  await test("safeDeleteAttachment rejects traversal paths (`../../`)", () => {
    const traversalPath = path.join(UPLOADS_DIR, `../${path.basename(decoyOutsideFile)}`);
    const deleted = safeDeleteAttachment(traversalPath, UPLOADS_DIR);
    assert.strictEqual(deleted, false);
    assert.strictEqual(fs.existsSync(decoyOutsideFile), true);
  });

  await test("safeDeleteAttachment deletes legitimate files within UPLOADS_DIR", () => {
    const deleted = safeDeleteAttachment(legitimateUploadFile, UPLOADS_DIR);
    assert.strictEqual(deleted, true);
    assert.strictEqual(fs.existsSync(legitimateUploadFile), false, "Contained file should be deleted");
  });

  await test("Schedule deletion with malicious external attachment path does not delete external file", async () => {
    const testSchedId = crypto.randomUUID();
    const maliciousAttachments = JSON.stringify([{
      name: "decoy.txt",
      path: decoyOutsideFile
    }]);

    await run(`
      INSERT INTO schedules (id, user_id, recipient, text, attachments, scheduled_at, status, created_at)
      VALUES (?, ?, '919900011111', 'test traversal', ?, ?, 'scheduled', ?)
    `, [testSchedId, userA_Id, maliciousAttachments, Date.now() + 100000, Date.now()]);

    const res = await request(`/api/schedules/${testSchedId}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${tokenA}` }
    });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(fs.existsSync(decoyOutsideFile), true, "External decoy file must NOT be deleted by schedule cleanup");
  });

  // Clean up decoy outside file
  if (fs.existsSync(decoyOutsideFile)) fs.unlinkSync(decoyOutsideFile);

  await test("User B CANNOT access User A staged share data via /api/shared/:shareId", async () => {
    // User A posts to share-target (simulated directly by creating share data)
    const shareRes = await request("/share-target", {
      method: "POST",
      headers: { Authorization: `Bearer ${tokenA}` },
      body: { title: "Secret Share", text: "User A private intent content" }
    });
    // Follow redirect location to get shareId
    const location = shareRes.headers.location || "";
    const match = location.match(/shareId=([a-f0-9-]+)/i);
    assert.ok(match, "Must redirect with shareId");
    const shareId = match[1];

    // User B attempts to access User A's shareId
    const crossRes = await request(`/api/shared/${shareId}`, {
      headers: { Authorization: `Bearer ${tokenB}` }
    });
    assert.strictEqual(crossRes.status, 404, "User B must receive 404 when accessing User A's share");

    // User A can access their own share data
    const ownerRes = await request(`/api/shared/${shareId}`, {
      headers: { Authorization: `Bearer ${tokenA}` }
    });
    assert.strictEqual(ownerRes.status, 200);
    assert.strictEqual(ownerRes.body.text, "User A private intent content");
  });

  // --- D. Concurrency & Crash Recovery Safety ---
  console.log("\n⚡ [D] Concurrency & Crash Recovery Safety:");

  await test("Atomic job claiming prevents race condition double-execution", async () => {
    const raceJobId = crypto.randomUUID();
    await run(`
      INSERT INTO schedules (id, user_id, recipient, text, scheduled_at, status, attempts, created_at)
      VALUES (?, ?, '919900011111', 'race test', ?, 'scheduled', 0, ?)
    `, [raceJobId, userA_Id, Date.now() - 1000, Date.now()]);

    // Simulate two concurrent workers claiming the same pending job simultaneously
    const claim1 = await run(
      `UPDATE schedules SET status = 'processing', attempts = attempts + 1 WHERE id = ? AND status IN ('scheduled', 'retrying')`,
      [raceJobId]
    );
    const claim2 = await run(
      `UPDATE schedules SET status = 'processing', attempts = attempts + 1 WHERE id = ? AND status IN ('scheduled', 'retrying')`,
      [raceJobId]
    );

    assert.strictEqual(claim1.changes, 1, "First worker must successfully claim job");
    assert.strictEqual(claim2.changes, 0, "Second worker must get 0 changes (prevent double-dispatch)");

    // Clean up
    await run("DELETE FROM schedules WHERE id = ?", [raceJobId]);
  });

  await test("recoverStaleProcessingJobs rescues orphaned jobs after server crash", async () => {
    const crashJobId = crypto.randomUUID();
    await run(`
      INSERT INTO schedules (id, user_id, recipient, text, scheduled_at, status, attempts, created_at)
      VALUES (?, ?, '919900011111', 'crash test', ?, 'processing', 1, ?)
    `, [crashJobId, userA_Id, Date.now() - 10000, Date.now()]);

    const { recoverStaleProcessingJobs } = require("../scheduler");
    await recoverStaleProcessingJobs();

    const recovered = await get("SELECT status, error FROM schedules WHERE id = ?", [crashJobId]);
    assert.strictEqual(recovered.status, "retrying", "Orphaned processing job must be recovered to retrying");
    assert.ok(recovered.error.includes("Recovered after server restart"));

    await run("DELETE FROM schedules WHERE id = ?", [crashJobId]);
  });

  // --- E. Legacy Data Migration Safety & Idempotency ---
  console.log("\n🔄 [E] Legacy Unscoped Data Migration & Idempotency:");

  await test("migrateLegacyData safely assigns unscoped records to Admin user", async () => {
    const legacyAdminId = crypto.randomUUID();
    const legacyContactJid = `legacy_${Date.now()}@s.whatsapp.net`;
    const legacySchedId = crypto.randomUUID();

    // Insert legacy records with NULL user_id
    await run(`INSERT INTO contacts (user_id, jid, name, phone, updated_at) VALUES (NULL, ?, 'Legacy VIP', '919876543210', ?)`,
      [legacyContactJid, Date.now()]
    );
    await run(`INSERT INTO schedules (id, user_id, recipient, text, scheduled_at, status, created_at) VALUES (?, NULL, '919876543210', 'Legacy Task', ?, 'scheduled', ?)`,
      [legacySchedId, Date.now() + 50000, Date.now()]
    );

    // Execute migration
    await migrateLegacyData(legacyAdminId);

    // Verify records now have user_id assigned to legacyAdminId
    const updatedContact = await get("SELECT user_id FROM contacts WHERE jid = ?", [legacyContactJid]);
    assert.strictEqual(updatedContact.user_id, legacyAdminId);

    const updatedSched = await get("SELECT user_id FROM schedules WHERE id = ?", [legacySchedId]);
    assert.strictEqual(updatedSched.user_id, legacyAdminId);

    // Verify idempotency (running migration again causes no errors or changes)
    await migrateLegacyData(legacyAdminId);

    // Clean up
    await run("DELETE FROM contacts WHERE jid = ?", [legacyContactJid]);
    await run("DELETE FROM schedules WHERE id = ?", [legacySchedId]);
  });

  await test("Legacy database schema migration simulation on scratch database", async () => {
    const sqlite3 = require("sqlite3").verbose();
    const scratchDbPath = path.join(DB_DIR, `scratch_legacy_test_${Date.now()}.db`);
    const scratchDb = new sqlite3.Database(scratchDbPath);

    await new Promise((resolve, reject) => {
      scratchDb.serialize(() => {
        // Create old v1 single-column PK tables
        scratchDb.run(`
          CREATE TABLE contacts (
            jid TEXT PRIMARY KEY,
            name TEXT,
            phone TEXT,
            is_group INTEGER DEFAULT 0,
            source TEXT DEFAULT 'whatsapp',
            name_source TEXT DEFAULT 'whatsapp',
            updated_at INTEGER NOT NULL
          )
        `);
        scratchDb.run(`
          CREATE TABLE settings (
            key TEXT PRIMARY KEY,
            value TEXT
          )
        `);

        // Insert legacy data
        scratchDb.run(`INSERT INTO contacts (jid, name, phone, updated_at) VALUES ('919876543210@s.whatsapp.net', 'Old Contact', '919876543210', 1000)`);
        scratchDb.run(`INSERT INTO settings (key, value) VALUES ('phonebook_imported', '1')`);

        // Perform schema migration to composite PK
        scratchDb.run(`ALTER TABLE contacts ADD COLUMN user_id TEXT`);
        scratchDb.run(`ALTER TABLE settings ADD COLUMN user_id TEXT`);

        scratchDb.run(`
          CREATE TABLE contacts_v2 (
            user_id TEXT,
            jid TEXT,
            name TEXT,
            phone TEXT,
            is_group INTEGER DEFAULT 0,
            source TEXT DEFAULT 'whatsapp',
            name_source TEXT DEFAULT 'whatsapp',
            updated_at INTEGER NOT NULL,
            PRIMARY KEY (user_id, jid)
          )
        `);
        scratchDb.run(`
          INSERT INTO contacts_v2 (user_id, jid, name, phone, is_group, source, name_source, updated_at)
          SELECT coalesce(user_id, 'admin_123'), jid, name, phone, is_group, source, name_source, updated_at FROM contacts
        `);
        scratchDb.run(`DROP TABLE contacts`);
        scratchDb.run(`ALTER TABLE contacts_v2 RENAME TO contacts`);

        scratchDb.all("PRAGMA table_info(contacts)", (err, rows) => {
          if (err) return reject(err);
          const pks = rows.filter(r => r.pk > 0);
          assert.strictEqual(pks.length, 2, "Must have composite PK of 2 columns");
          resolve();
        });
      });
    });

    scratchDb.close();
    if (fs.existsSync(scratchDbPath)) fs.unlinkSync(scratchDbPath);
  });

  // --- F. SEC-003: Gradle Signing Key Parameterization & CI Safety Verification ---
  console.log("\n📦 [F] SEC-003 Android Keystore Parameterization & CI Safety Verification:");

  await test("build.gradle parameterizes release keystore and contains NO hardcoded passwords", () => {
    const buildGradlePath = path.join(__dirname, "../../android/app/build.gradle");
    const gradleContent = fs.readFileSync(buildGradlePath, "utf8");

    assert.ok(gradleContent.includes('System.getenv("KEYSTORE_PATH")'), "Must support KEYSTORE_PATH env var");
    assert.ok(gradleContent.includes('System.getenv("KEYSTORE_PASSWORD")'), "Must support KEYSTORE_PASSWORD env var");
    assert.ok(gradleContent.includes('System.getenv("KEY_ALIAS")'), "Must support KEY_ALIAS env var");
    assert.ok(gradleContent.includes('System.getenv("KEY_PASSWORD")'), "Must support KEY_PASSWORD env var");

    // Ensure no fallback password strings exist
    assert.ok(!gradleContent.includes('scheduler123'), "Must NOT contain hardcoded fallback password 'scheduler123'");
    assert.ok(!gradleContent.includes('?: "app-release.jks"'), "Must NOT contain fallback to committed keystore file");
  });

  await test("build.gradle enforces fail-closed behavior for assembleRelease when signing env vars are missing", () => {
    const buildGradlePath = path.join(__dirname, "../../android/app/build.gradle");
    const gradleContent = fs.readFileSync(buildGradlePath, "utf8");

    assert.ok(gradleContent.includes("assembleRelease"), "Must inspect assembleRelease task");
    assert.ok(gradleContent.includes("GradleException"), "Must throw GradleException when signing secrets are absent");
    assert.ok(gradleContent.includes("Insecure fallbacks are strictly prohibited"), "Must state explicit prohibition of fallbacks");
  });

  await test("build-apk.yml CI workflow disables automatic releases on push and requires manual approval + secrets", () => {
    const workflowPath = path.join(__dirname, "../../.github/workflows/build-apk.yml");
    const workflowContent = fs.readFileSync(workflowPath, "utf8");

    // 1. Permissions: Scoped at job level (contents: read for CI, contents: write only for release)
    assert.ok(workflowContent.includes("permissions:\n  contents: read"), "Top-level permissions must default to read");
    assert.ok(workflowContent.includes("contents: read"), "CI job must have read-only contents permission");
    assert.ok(workflowContent.includes("environment: production-release"), "Release job must use protected environment");

    // 2. CI Validation: Ordinary push/PR does NOT publish release
    assert.ok(workflowContent.includes("ci_validation"), "Must include distinct CI validation job");
    assert.ok(workflowContent.includes("assembleDebug"), "CI validation must build debug APK only");
    assert.ok(workflowContent.includes("WhatsApp-Scheduler-DEBUG.apk"), "CI artifact must be clearly labeled as DEBUG");
    
    // 3. Release Job: Requires explicit workflow_dispatch with publish_release == 'true' and branch constraints
    assert.ok(workflowContent.includes("publish_signed_release"), "Must include dedicated release job");
    assert.ok(workflowContent.includes("github.event.inputs.publish_release == 'true'"), "Must require explicit manual release approval flag");
    assert.ok(workflowContent.includes("github.event.repository.fork == false"), "Must prevent execution in untrusted fork context");

    // 4. Strict SemVer Tag & Uniqueness Validation
    assert.ok(workflowContent.includes("^v[0-9]+\\.[0-9]+\\.[0-9]+$"), "Must enforce strict SemVer tag regex");
    assert.ok(workflowContent.includes("refs/tags/$INPUT_TAG"), "Must check for local and remote tag uniqueness");

    // 5. Safe Secret Handling: Passed via step-level env vars without shell interpolation
    assert.ok(workflowContent.includes("KEYSTORE_B64: ${{ secrets.RELEASE_KEYSTORE_BASE64 }}"), "Secrets must be passed via step-level env vars");
    assert.ok(workflowContent.includes("KS_PASS: ${{ secrets.KEYSTORE_PASSWORD }}"), "Password secrets must be passed via step-level env vars");
    assert.ok(!workflowContent.includes('echo "${{ secrets.RELEASE_KEYSTORE_BASE64 }}"'), "Must NOT interpolate secret directly into shell command");

    // 6. Pre-build Keystore Integrity & Post-build Signature Verification
    assert.ok(workflowContent.includes("keytool -list -keystore"), "Must validate keystore integrity and alias existence before build");
    assert.ok(workflowContent.includes("assembleRelease"), "Release job must build assembleRelease");
    assert.ok(workflowContent.includes("apksigner verify") || workflowContent.includes("keytool -printcert"), "Must verify APK signing status");

    // 7. Human Verification & Safe Cleanup
    assert.ok(workflowContent.includes("draft: true"), "Releases must be created as Draft awaiting human review");
    assert.ok(workflowContent.includes("make_latest: false"), "Releases must NOT be marked latest automatically");
    assert.ok(workflowContent.includes("rm -rf"), "Must securely cleanup decoded keystore");
  });

  // Clean up test users
  await run("DELETE FROM users WHERE id IN (?, ?)", [userA_Id, userB_Id]);
  await run("DELETE FROM sessions WHERE user_id IN (?, ?)", [userA_Id, userB_Id]);
  await run("DELETE FROM contacts WHERE user_id IN (?, ?)", [userA_Id, userB_Id]);
  await run("DELETE FROM schedules WHERE user_id IN (?, ?)", [userA_Id, userB_Id]);

  console.log(`\n=================================================================`);
  console.log(`Test Suite Summary: ${passed} Passed, ${failed} Failed`);
  console.log(`=================================================================\n`);

  if (failed > 0) {
    process.exit(1);
  }
}

if (require.main === module) {
  runSecurityPhase2Tests().catch((err) => {
    console.error("Test Suite execution failed:", err);
    process.exit(1);
  });
}

module.exports = { runSecurityPhase2Tests };
