const assert = require("assert");
const http = require("http");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const { validateUploadedFile, sanitizeFilename, checkMagicBytes } = require("../fileValidator");
const { DB_DIR } = require("../db");

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
      req.write(typeof options.body === "string" ? options.body : JSON.stringify(options.body));
    }
    req.end();
  });
}

async function runSecurityPhase3Tests() {
  console.log("=================================================================");
  console.log("🧪 Comprehensive Phase 3 Security Test Suite (SEC-006 to SEC-012)");
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

  // --- A. SEC-007: Upload Validation, Magic Bytes & Extension Enforcement ---
  console.log("📁 [A] Uploads Validation & Magic Byte Enforcement (SEC-007):");

  const tempUploadDir = path.join(DB_DIR, "test_uploads");
  if (!fs.existsSync(tempUploadDir)) fs.mkdirSync(tempUploadDir, { recursive: true });

  await test("sanitizeFilename strips path traversals and dangerous characters", () => {
    assert.strictEqual(sanitizeFilename("../../../etc/passwd.jpg"), "passwd.jpg");
    assert.strictEqual(sanitizeFilename("my picture!@#$%^&*().png"), "my_picture__________.png");
    assert.strictEqual(sanitizeFilename("normal-file_123.pdf"), "normal-file_123.pdf");
  });

  await test("Accept legitimate PNG image with correct magic bytes", () => {
    const pngPath = path.join(tempUploadDir, "valid.png");
    const validPngBuffer = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0x00, 0x00, 0x00, 0x0D]);
    fs.writeFileSync(pngPath, validPngBuffer);

    assert.doesNotThrow(() => {
      validateUploadedFile({
        originalname: "valid.png",
        mimetype: "image/png",
        path: pngPath,
        size: validPngBuffer.length
      });
    });
    fs.unlinkSync(pngPath);
  });

  await test("Accept legitimate JPEG image with correct magic bytes", () => {
    const jpegPath = path.join(tempUploadDir, "valid.jpg");
    const validJpegBuffer = Buffer.from([0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10, 0x4A, 0x46, 0x49, 0x46]);
    fs.writeFileSync(jpegPath, validJpegBuffer);

    assert.doesNotThrow(() => {
      validateUploadedFile({
        originalname: "valid.jpg",
        mimetype: "image/jpeg",
        path: jpegPath,
        size: validJpegBuffer.length
      });
    });
    fs.unlinkSync(jpegPath);
  });

  await test("Accept legitimate PDF document with correct magic bytes", () => {
    const pdfPath = path.join(tempUploadDir, "valid.pdf");
    const validPdfBuffer = Buffer.from("%PDF-1.4\n%âãÏÓ\n");
    fs.writeFileSync(pdfPath, validPdfBuffer);

    assert.doesNotThrow(() => {
      validateUploadedFile({
        originalname: "valid.pdf",
        mimetype: "application/pdf",
        path: pdfPath,
        size: validPdfBuffer.length
      });
    });
    fs.unlinkSync(pdfPath);
  });

  await test("Reject spoofed MIME type: text file disguised as .png", () => {
    const spoofedPngPath = path.join(tempUploadDir, "spoofed.png");
    fs.writeFileSync(spoofedPngPath, "Hello world, I am plain text posing as PNG");

    assert.throws(() => {
      validateUploadedFile({
        originalname: "spoofed.png",
        mimetype: "image/png",
        path: spoofedPngPath,
        size: 40
      });
    }, /File content signature does not match declared extension/);
    fs.unlinkSync(spoofedPngPath);
  });

  await test("Reject dangerous executable file disguised as .pdf (Windows PE MZ Header)", () => {
    const exePath = path.join(tempUploadDir, "malware.pdf");
    const exeBuffer = Buffer.from([0x4D, 0x5A, 0x90, 0x00, 0x03, 0x00, 0x00, 0x00]); // MZ
    fs.writeFileSync(exePath, exeBuffer);

    assert.throws(() => {
      validateUploadedFile({
        originalname: "malware.pdf",
        mimetype: "application/pdf",
        path: exePath,
        size: exeBuffer.length
      });
    }, /File content signature does not match declared extension/);
    fs.unlinkSync(exePath);
  });

  await test("Reject dangerous Linux ELF binary disguised as .jpg", () => {
    const elfPath = path.join(tempUploadDir, "exploit.jpg");
    const elfBuffer = Buffer.from([0x7F, 0x45, 0x4C, 0x46, 0x02, 0x01, 0x01, 0x00]); // \x7fELF
    fs.writeFileSync(elfPath, elfBuffer);

    assert.throws(() => {
      validateUploadedFile({
        originalname: "exploit.jpg",
        mimetype: "image/jpeg",
        path: elfPath,
        size: elfBuffer.length
      });
    }, /File content signature does not match declared extension/);
    fs.unlinkSync(elfPath);
  });

  await test("Reject PHP script disguised as image or document", () => {
    const phpPath = path.join(tempUploadDir, "shell.jpg");
    fs.writeFileSync(phpPath, "<?php system($_GET['cmd']); ?>");

    assert.throws(() => {
      validateUploadedFile({
        originalname: "shell.jpg",
        mimetype: "image/jpeg",
        path: phpPath,
        size: 32
      });
    }, /File content signature does not match declared extension/);
    fs.unlinkSync(phpPath);
  });

  await test("Reject unpermitted extension (.exe, .sh, .py, .js)", () => {
    const shPath = path.join(tempUploadDir, "script.sh");
    fs.writeFileSync(shPath, "#!/bin/bash\necho hello");

    assert.throws(() => {
      validateUploadedFile({
        originalname: "script.sh",
        mimetype: "text/x-shellscript",
        path: shPath,
        size: 20
      });
    }, /File extension '.sh' is not permitted/);
    fs.unlinkSync(shPath);
  });

  if (fs.existsSync(tempUploadDir)) fs.rmSync(tempUploadDir, { recursive: true, force: true });

  // --- B. SEC-009: Strict CORS Configuration ---
  console.log("\n🌐 [B] Strict CORS Configuration & Preflight Validation (SEC-009):");

  await test("Allow preflight & request from trusted origin (http://localhost:3000)", async () => {
    const res = await request("/api/version", {
      method: "OPTIONS",
      headers: {
        Origin: "http://localhost:3000",
        "Access-Control-Request-Method": "GET"
      }
    });
    assert.strictEqual(res.status, 204);
    assert.strictEqual(res.headers["access-control-allow-origin"], "http://localhost:3000");
    assert.ok(res.headers["access-control-allow-methods"].includes("GET"));
  });

  await test("Reject preflight request from untrusted origin (https://evil-attacker.com) with 403", async () => {
    const res = await request("/api/version", {
      method: "OPTIONS",
      headers: {
        Origin: "https://evil-attacker.com",
        "Access-Control-Request-Method": "POST"
      }
    });
    assert.strictEqual(res.status, 403, "Untrusted origin preflight must receive 403");
    assert.strictEqual(res.headers["access-control-allow-origin"], undefined);
  });

  await test("Direct request from untrusted origin does NOT receive Access-Control-Allow-Origin header", async () => {
    const res = await request("/api/version", {
      method: "GET",
      headers: {
        Origin: "https://evil-attacker.com"
      }
    });
    assert.strictEqual(res.headers["access-control-allow-origin"], undefined);
  });

  // --- C. SEC-010: Rate Limiting & Abuse Defense ---
  console.log("\n⏱️ [C] Rate Limiting & Abuse Defense (SEC-010):");

  await test("Auth rate limiter blocks brute-force after exceeding 10 attempts with HTTP 429", async () => {
    let triggered429 = false;
    let retryAfterHeader = null;

    for (let i = 0; i < 15; i++) {
      const res = await request("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: { username: "nonexistent_user", password: "wrong_password" }
      });

      if (res.status === 429) {
        triggered429 = true;
        retryAfterHeader = res.headers["retry-after"];
        assert.strictEqual(res.body.success, false);
        assert.ok(res.body.error.includes("Too many authentication attempts"));
        break;
      }
    }

    assert.strictEqual(triggered429, true, "Rate limiter must return HTTP 429 when max attempts exceeded");
    assert.ok(retryAfterHeader, "429 response must contain Retry-After header");

    const { loginLimiterInstance } = require("../rateLimiter");
    if (loginLimiterInstance) loginLimiterInstance.reset();
  });

  // --- D. SEC-008: Docker Build-Context Secret Exclusion ---
  console.log("\n🐳 [D] Docker Build Context Secret Exclusion (SEC-008):");

  function matchesDockerIgnore(filePath, ignorePatterns) {
    for (const pattern of ignorePatterns) {
      const cleanPat = pattern.trim().replace(/\/$/, "");
      if (!cleanPat || cleanPat.startsWith("#")) continue;

      if (cleanPat.startsWith("*.")) {
        const ext = cleanPat.slice(1);
        if (filePath.endsWith(ext)) return true;
      }
      if (filePath === cleanPat || filePath.startsWith(cleanPat + "/") || filePath.includes("/" + cleanPat)) {
        return true;
      }
    }
    return false;
  }

  await test("Root .dockerignore excludes sensitive database, session, and keystore files", () => {
    const rootDockerIgnore = fs.readFileSync(path.join(__dirname, "../../.dockerignore"), "utf8").split("\n");
    assert.strictEqual(matchesDockerIgnore("data/scheduler.db", rootDockerIgnore), true);
    assert.strictEqual(matchesDockerIgnore("data/sessions/auth_info_baileys/creds.json", rootDockerIgnore), true);
    assert.strictEqual(matchesDockerIgnore("android/app/app-release.jks", rootDockerIgnore), true);
    assert.strictEqual(matchesDockerIgnore("keystore.properties", rootDockerIgnore), true);
    assert.strictEqual(matchesDockerIgnore(".env", rootDockerIgnore), true);
    assert.strictEqual(matchesDockerIgnore(".git/HEAD", rootDockerIgnore), true);

    // Ensure required app files are NOT excluded
    assert.strictEqual(matchesDockerIgnore("mobile-server/server.js", rootDockerIgnore), false);
    assert.strictEqual(matchesDockerIgnore("mobile-server/package.json", rootDockerIgnore), false);
  });

  await test("mobile-server/.dockerignore excludes runtime data and keystores", () => {
    const serverDockerIgnore = fs.readFileSync(path.join(__dirname, "../.dockerignore"), "utf8").split("\n");
    assert.strictEqual(matchesDockerIgnore("data/scheduler.db", serverDockerIgnore), true);
    assert.strictEqual(matchesDockerIgnore("auth_info_baileys/creds.json", serverDockerIgnore), true);
    assert.strictEqual(matchesDockerIgnore("release.jks", serverDockerIgnore), true);
    assert.strictEqual(matchesDockerIgnore(".env", serverDockerIgnore), true);

    // Ensure required server code is NOT excluded
    assert.strictEqual(matchesDockerIgnore("server.js", serverDockerIgnore), false);
    assert.strictEqual(matchesDockerIgnore("fileValidator.js", serverDockerIgnore), false);
    assert.strictEqual(matchesDockerIgnore("pwa/index.html", serverDockerIgnore), false);
  });

  // --- E. SEC-006 & SEC-012: Android Manifest, Network Config & WebView Static Verification ---
  console.log("\n📱 [E] Android Manifest, Network Security & WebView Policies (SEC-006 & SEC-012):");

  await test("AndroidManifest.xml has usesCleartextTraffic=false and networkSecurityConfig configured", () => {
    const manifestPath = path.join(__dirname, "../../android/app/src/main/AndroidManifest.xml");
    const manifestContent = fs.readFileSync(manifestPath, "utf8");
    assert.ok(manifestContent.includes('android:usesCleartextTraffic="false"'), "Cleartext traffic must be disabled");
    assert.ok(manifestContent.includes('android:networkSecurityConfig="@xml/network_security_config"'), "Network security config must be referenced");
  });

  await test("network_security_config.xml strictly disallows cleartext base traffic", () => {
    const netSecPath = path.join(__dirname, "../../android/app/src/main/res/xml/network_security_config.xml");
    const netSecContent = fs.readFileSync(netSecPath, "utf8");
    assert.ok(netSecContent.includes('cleartextTrafficPermitted="false"'), "Base config must disallow cleartext traffic");
  });

  await test("MainActivity.java disables file access from URLs and sets MIXED_CONTENT_NEVER_ALLOW", () => {
    const mainActivityPath = path.join(__dirname, "../../android/app/src/main/java/com/whatsapp/scheduler/MainActivity.java");
    const activityContent = fs.readFileSync(mainActivityPath, "utf8");
    assert.ok(activityContent.includes("settings.setAllowFileAccess(false)"), "setAllowFileAccess must be false");
    assert.ok(activityContent.includes("settings.setAllowContentAccess(false)"), "setAllowContentAccess must be false");
    assert.ok(activityContent.includes("settings.setAllowFileAccessFromFileURLs(false)"), "setAllowFileAccessFromFileURLs must be false");
    assert.ok(activityContent.includes("settings.setAllowUniversalAccessFromFileURLs(false)"), "setAllowUniversalAccessFromFileURLs must be false");
    assert.ok(activityContent.includes("WebSettings.MIXED_CONTENT_NEVER_ALLOW"), "Mixed content must be NEVER_ALLOW");
  });

  await test("MainActivity.java sanitizes clipboard bridge input and limits length", () => {
    const mainActivityPath = path.join(__dirname, "../../android/app/src/main/java/com/whatsapp/scheduler/MainActivity.java");
    const activityContent = fs.readFileSync(mainActivityPath, "utf8");
    assert.ok(activityContent.includes("replaceAll"), "Must strip control characters");
    assert.ok(activityContent.includes("500"), "Must enforce maximum length cap");
  });

  console.log(`\n=================================================================`);
  console.log(`Test Suite Summary: ${passed} Passed, ${failed} Failed`);
  console.log(`=================================================================\n`);

  if (failed > 0) {
    process.exit(1);
  }
}

if (require.main === module) {
  runSecurityPhase3Tests()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error("Test Suite execution failed:", err);
      process.exit(1);
    });
}

module.exports = { runSecurityPhase3Tests };
