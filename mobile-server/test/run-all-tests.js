process.env.NODE_ENV = process.env.NODE_ENV || "test";
process.env.TEST_PORT = process.env.TEST_PORT || "3001";
process.env.TEST_SERVER_URL = process.env.TEST_SERVER_URL || `http://127.0.0.1:${process.env.TEST_PORT}`;
const http = require("http");
const app = require("../server");
const { runSecurityPhase1Tests } = require("./security-phase1.test");
const { runSecurityPhase2Tests } = require("./security-phase2.test");
const { runSecurityPhase3Tests } = require("./security-phase3.test");
const { runSecurityPhase4Tests } = require("./security-phase4.test");
const { runPhase4HardeningTests } = require("./phase4-hardening.test");
const { runMultiUserRegressionTests } = require("./multi-user-isolation.test");
const { runAuditVerificationTests } = require("./audit-verification.test");
const { runAuditFixesTests } = require("./audit-fixes.test");
const { runSessionEncryptionTests } = require("./session-encryption.test");
const { runAuthCookieTests } = require("./auth-cookies.test");

async function main() {
  console.log("=================================================================");
  console.log("🚀 Running Complete WhatsApp Scheduler Security & Multi-User Test Suite");
  console.log("=================================================================\n");

  let server = null;
  const targetPort = process.env.TEST_PORT || 3001;
  const testUrl = `http://127.0.0.1:${targetPort}`;
  process.env.TEST_SERVER_URL = testUrl;

  // Check if a server is already listening on port 3000
  const isServerRunning = await new Promise((resolve) => {
    const req = http.get(testUrl, () => resolve(true));
    req.on("error", () => resolve(false));
    req.setTimeout(500, () => {
      req.destroy();
      resolve(false);
    });
  });

  if (!isServerRunning) {
    server = http.createServer(app);
    await new Promise((resolve, reject) => {
      server.listen(targetPort, "127.0.0.1", () => {
        console.log(`[Test Harness] Spun up test server on ${testUrl}\n`);
        resolve();
      });
      server.on("error", reject);
    });
  } else {
    console.log(`[Test Harness] Connecting to existing test server on ${testUrl}\n`);
  }

  process.env.TEST_SERVER_URL = testUrl;

  const { loginLimiterInstance, registerLimiterInstance, pairingLimiterInstance } = require("../rateLimiter");
  if (loginLimiterInstance) loginLimiterInstance.reset();
  if (registerLimiterInstance) registerLimiterInstance.reset();
  if (pairingLimiterInstance) pairingLimiterInstance.reset();

  try {
    console.log("\n▶️ RUNNING PHASE 1 SUITE...");
    await runSecurityPhase1Tests();

    console.log("\n▶️ RUNNING PHASE 2 SUITE...");
    await runSecurityPhase2Tests();

    console.log("\n▶️ RUNNING PHASE 3 SUITE...");
    await runSecurityPhase3Tests();

    console.log("\n▶️ RUNNING PHASE 4 SUITE...");
    await runSecurityPhase4Tests();

    console.log("\n▶️ RUNNING PHASE 4 SECURITY HARDENING SUITE (SEC-005, SEC-011, SEC-012, SEC-013)...");
    await runPhase4HardeningTests();

    console.log("\n▶️ RUNNING MULTI-USER REGRESSION SUITE...");
    await runMultiUserRegressionTests();

    console.log("\n▶️ RUNNING REQUIREMENT C AUDIT VERIFICATION SUITE...");
    await runAuditVerificationTests();

    console.log("\n▶️ RUNNING AUDIT FIXES & ADMIN PANEL SUITE...");
    await runAuditFixesTests();

    console.log("\n▶️ RUNNING SESSION ENCRYPTION SUITE (SEC-004)...");
    await runSessionEncryptionTests();

    console.log("\n▶️ RUNNING AUTH COOKIES & CSRF SUITE (SEC-009)...");
    await runAuthCookieTests();

    console.log("\n=================================================================");
    console.log("🎉 ALL TEST SUITES COMPLETED WITH 100% SUCCESS!");
    console.log("=================================================================\n");
  } catch (err) {
    console.error("\n❌ Test suite failed with error:", err);
    process.exitCode = 1;
  } finally {
    if (server) {
      await new Promise((resolve) => server.close(resolve));
      console.log("[Test Harness] Test server gracefully stopped.");
    }
  }
  process.exit(process.exitCode || 0);
}

main().catch((err) => {
  console.error("Fatal test runner error:", err);
  process.exit(1);
});
