#!/usr/bin/env node
/**
 * Standalone Administrator Account Creator / Promotor
 * 
 * Usage:
 *   node create-admin.js <username> <password>
 * 
 * Example:
 *   node create-admin.js myadmin SecurePass123!
 */

const crypto = require("crypto");
const { initDb, run, get } = require("./db");
const { hashPasswordAsync } = require("./auth");

async function main() {
  const args = process.argv.slice(2);
  const username = (args[0] || process.env.ADMIN_USERNAME || "").trim().toLowerCase();
  const password = (args[1] || process.env.ADMIN_PASSWORD || "").trim();

  if (!username || !password) {
    console.error("\n❌ Usage: node create-admin.js <username> <password>\n");
    console.error("Alternatively, set ADMIN_USERNAME and ADMIN_PASSWORD environment variables.\n");
    process.exit(1);
  }

  if (password.length < 8) {
    console.error("\n❌ Password must be at least 8 characters long.\n");
    process.exit(1);
  }

  try {
    await initDb();

    const existing = await get("SELECT id, username, role FROM users WHERE lower(username) = lower(?)", [username]);
    const passwordHash = await hashPasswordAsync(password);

    if (existing) {
      await run("UPDATE users SET password_hash = ?, role = 'admin' WHERE id = ?", [passwordHash, existing.id]);
      console.log(`\n✅ Success! User "${existing.username}" has been updated and promoted to administrator.`);
    } else {
      const id = crypto.randomUUID();
      const now = Date.now();
      await run(
        "INSERT INTO users (id, username, password_hash, role, created_at) VALUES (?, ?, ?, 'admin', ?)",
        [id, username, passwordHash, now]
      );
      console.log(`\n✅ Success! Dedicated administrator "${username}" created successfully.`);
    }

    console.log(`You can now sign in with username "${username}" on the dashboard.\n`);
    process.exit(0);
  } catch (err) {
    console.error("\n❌ Failed to create administrator:", err.message);
    process.exit(1);
  }
}

main();
