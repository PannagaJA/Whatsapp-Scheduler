const assert = require("assert");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const {
  validateKeyFormat,
  getSessionEncryptionKey,
  encryptData,
  decryptData,
  readDecryptedJson,
  writeEncryptedJson,
  migrateSessionDirectory,
  useEncryptedAuthState
} = require("../sessionCrypto");

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

async function runSessionEncryptionTests() {
  console.log("\n=================================================================");
  console.log("🔐 SEC-004: WhatsApp Session Encryption at Rest Test Suite");
  console.log("=================================================================\n");

  const testKeyHex = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
  const testKeyBuf = Buffer.from(testKeyHex, "hex");
  const testDir = path.join(__dirname, "scratch_crypto_" + Date.now());

  try {
    if (!fs.existsSync(testDir)) fs.mkdirSync(testDir, { recursive: true });

    // --- 1. Key Format Validation ---
    console.log("🔑 [1] Key Format & Safety Validation:");

    await test("Accepts valid 64-character hexadecimal key", () => {
      const parsed = validateKeyFormat(testKeyHex);
      assert.strictEqual(parsed.length, 32);
      assert.deepStrictEqual(parsed, testKeyBuf);
    });

    await test("Accepts valid 32-byte raw string and Buffer keys", () => {
      const raw32 = "a".repeat(32);
      const parsedStr = validateKeyFormat(raw32);
      assert.strictEqual(parsedStr.length, 32);

      const parsedBuf = validateKeyFormat(testKeyBuf);
      assert.strictEqual(parsedBuf.length, 32);
    });

    await test("Rejects null, empty, or whitespace keys", () => {
      assert.throws(() => validateKeyFormat(null), /required/);
      assert.throws(() => validateKeyFormat(""), /required/);
      assert.throws(() => validateKeyFormat("   "), /whitespace/);
    });

    await test("Rejects keys with invalid lengths or non-32-byte formats", () => {
      assert.throws(() => validateKeyFormat("too-short"), /format/);
      assert.throws(() => validateKeyFormat("0123456789abcdef"), /format/);
      assert.throws(() => validateKeyFormat(Buffer.from("short")), /length/);
    });

    await test("Fails safely in production when SESSION_ENCRYPTION_KEY is unset", () => {
      const oldEnv = process.env.NODE_ENV;
      const oldKey = process.env.SESSION_ENCRYPTION_KEY;
      try {
        process.env.NODE_ENV = "production";
        delete process.env.SESSION_ENCRYPTION_KEY;
        assert.throws(() => getSessionEncryptionKey(), /SESSION_ENCRYPTION_KEY must be set in production/);
      } finally {
        process.env.NODE_ENV = oldEnv;
        if (oldKey !== undefined) process.env.SESSION_ENCRYPTION_KEY = oldKey;
      }
    });

    // --- 2. AES-256-GCM Round-Trip & Nonce Uniqueness ---
    console.log("\n🛡️ [2] Authenticated Encryption & Nonce Uniqueness:");

    await test("Encrypts and decrypts string data cleanly (round-trip)", () => {
      const plaintext = JSON.stringify({ me: { id: "919999999999@s.whatsapp.net", name: "Alice" } });
      const envelope = encryptData(plaintext, testKeyBuf);

      assert.strictEqual(envelope._enc, 1);
      assert.strictEqual(envelope.alg, "aes-256-gcm");
      assert.ok(envelope.iv && envelope.tag && envelope.data);

      const decrypted = decryptData(envelope, testKeyBuf);
      assert.strictEqual(decrypted, plaintext);
    });

    await test("Generates unique 12-byte nonce for each encryption of identical input", () => {
      const data = "identical-sensitive-creds";
      const enc1 = encryptData(data, testKeyBuf);
      const enc2 = encryptData(data, testKeyBuf);

      assert.notStrictEqual(enc1.iv, enc2.iv, "Nonces must be unique across encryptions");
      assert.notStrictEqual(enc1.data, enc2.data, "Ciphertexts must differ due to unique nonces");
      assert.strictEqual(decryptData(enc1, testKeyBuf), data);
      assert.strictEqual(decryptData(enc2, testKeyBuf), data);
    });

    // --- 3. Tamper Resistance & Authentication Tag Verification ---
    console.log("\n🔒 [3] Tamper Resistance & Authentication Verification:");

    await test("Rejects tampered ciphertext with authentication error", () => {
      const envelope = encryptData("secret-whatsapp-keys", testKeyBuf);
      // Flip a byte in the ciphertext payload
      const tamperedHex = envelope.data.slice(0, -2) + (envelope.data.slice(-2) === "aa" ? "bb" : "aa");
      const tamperedEnv = { ...envelope, data: tamperedHex };

      assert.throws(() => decryptData(tamperedEnv, testKeyBuf), /authentication tag mismatch/);
    });

    await test("Rejects tampered authentication tag", () => {
      const envelope = encryptData("secret-whatsapp-keys", testKeyBuf);
      const tamperedTag = envelope.tag.slice(0, -2) + (envelope.tag.slice(-2) === "00" ? "11" : "00");
      const tamperedEnv = { ...envelope, tag: tamperedTag };

      assert.throws(() => decryptData(tamperedEnv, testKeyBuf), /authentication tag mismatch/);
    });

    await test("Rejects decryption with wrong key", () => {
      const wrongKey = "fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210";
      const envelope = encryptData("secret-whatsapp-keys", testKeyBuf);

      assert.throws(() => decryptData(envelope, wrongKey), /authentication tag mismatch/);
    });

    // --- 4. Plaintext to Encrypted Migration ---
    console.log("\n📦 [4] Safe Plaintext Migration & Verification:");

    await test("Safely migrates plaintext credentials without data loss", () => {
      const sessionDir = path.join(testDir, "migration_session");
      fs.mkdirSync(sessionDir, { recursive: true });

      const sampleCreds = { me: { id: "919876543210@s.whatsapp.net", registered: true } };
      const credsPath = path.join(sessionDir, "creds.json");
      fs.writeFileSync(credsPath, JSON.stringify(sampleCreds), "utf8");

      const sampleKey = { keyId: 1, keyData: "mock-prekey-material" };
      const keyPath = path.join(sessionDir, "pre-key-1.json");
      fs.writeFileSync(keyPath, JSON.stringify(sampleKey), "utf8");

      // Execute migration
      const res = migrateSessionDirectory(sessionDir, testKeyBuf);
      assert.strictEqual(res.migrated, 2);

      // Verify files on disk are no longer raw plaintext
      const credsOnDisk = JSON.parse(fs.readFileSync(credsPath, "utf8"));
      assert.strictEqual(credsOnDisk._enc, 1);
      assert.strictEqual(credsOnDisk.alg, "aes-256-gcm");
      assert.strictEqual(credsOnDisk.me, undefined);

      // Verify transparent read via readDecryptedJson recovers exact plaintext
      const decryptedCreds = readDecryptedJson(credsPath, testKeyBuf);
      assert.deepStrictEqual(decryptedCreds, sampleCreds);

      const decryptedKey = readDecryptedJson(keyPath, testKeyBuf);
      assert.deepStrictEqual(decryptedKey, sampleKey);

      // Second migration run is idempotent
      const secondRun = migrateSessionDirectory(sessionDir, testKeyBuf);
      assert.strictEqual(secondRun.migrated, 0);
      assert.strictEqual(secondRun.skipped, 2);
    });

    // --- 5. Baileys Auth State Provider Round-Trip & Persistence ---
    console.log("\n🔄 [5] Baileys Encrypted Auth State Round-Trip:");

    await test("useEncryptedAuthState persists creds and keys in encrypted format across restarts", async () => {
      const authStateDir = path.join(testDir, "baileys_auth");

      // Instance 1: write credentials and session keys
      const authState1 = await useEncryptedAuthState(authStateDir, testKeyBuf);
      authState1.state.creds.me = { id: "919123456789@s.whatsapp.net", name: "Bob" };
      authState1.state.creds.registered = true;
      await authState1.saveCreds();

      await authState1.state.keys.set({
        "app-state-sync-key": {
          "key-1": { keyData: Buffer.from("sync-key-data-123").toString("base64") }
        }
      });

      // Verify files on disk are encrypted
      const credsRaw = fs.readFileSync(path.join(authStateDir, "creds.json"), "utf8");
      assert.ok(!credsRaw.includes("919123456789"), "Plaintext phone number must NOT appear on disk");
      assert.ok(credsRaw.includes('"_enc": 1'), "Creds file must be wrapped in encrypted envelope");

      // Instance 2 (Simulated restart): read back credentials
      const authState2 = await useEncryptedAuthState(authStateDir, testKeyBuf);
      assert.strictEqual(authState2.state.creds.registered, true);
      assert.strictEqual(authState2.state.creds.me.name, "Bob");

      const loadedKeys = await authState2.state.keys.get("app-state-sync-key", ["key-1"]);
      assert.ok(loadedKeys["key-1"], "Session keys must be restored from encrypted storage");
    });

    console.log("\n=================================================================");
    console.log("🎉 ALL SESSION ENCRYPTION TESTS PASSED SUCCESSFULLY!");
    console.log("=================================================================\n");
  } finally {
    try {
      if (fs.existsSync(testDir)) fs.rmSync(testDir, { recursive: true, force: true });
    } catch (_) {}
  }
}

module.exports = { runSessionEncryptionTests };

if (require.main === module) {
  runSessionEncryptionTests().catch(() => process.exit(1));
}
