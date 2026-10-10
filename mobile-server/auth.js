const crypto = require("crypto");
const { run, get, all } = require("./db");

const util = require("util");
const scryptAsync = util.promisify(crypto.scrypt);

// Cryptographic Password Hashing with Scrypt & Salt (Asynchronous & Non-blocking)
async function hashPasswordAsync(password) {
  if (!password || typeof password !== "string" || password.length < 6) {
    throw new Error("Password must be at least 6 characters long");
  }
  const salt = crypto.randomBytes(16).toString("hex");
  const derivedKey = await scryptAsync(password, salt, 64);
  return `${salt}:${derivedKey.toString("hex")}`;
}

async function verifyPasswordAsync(password, storedHash) {
  if (!password || !storedHash || typeof storedHash !== "string" || !storedHash.includes(":")) {
    return false;
  }
  const [salt, key] = storedHash.split(":");
  if (!salt || !key) {
    return false;
  }
  const keyBuffer = Buffer.from(key, "hex");
  if (keyBuffer.length !== 64) {
    return false;
  }
  try {
    const derivedKey = await scryptAsync(password, salt, 64);
    if (!derivedKey || derivedKey.length !== 64) {
      return false;
    }
    return crypto.timingSafeEqual(keyBuffer, derivedKey);
  } catch (_) {
    return false;
  }
}

// Synchronous Fallbacks for backward compatibility
function hashPassword(password) {
  if (!password || typeof password !== "string" || password.length < 6) {
    throw new Error("Password must be at least 6 characters long");
  }
  const salt = crypto.randomBytes(16).toString("hex");
  const derivedKey = crypto.scryptSync(password, salt, 64);
  return `${salt}:${derivedKey.toString("hex")}`;
}

function verifyPassword(password, storedHash) {
  if (!password || !storedHash || typeof storedHash !== "string" || !storedHash.includes(":")) {
    return false;
  }
  const [salt, key] = storedHash.split(":");
  if (!salt || !key) {
    return false;
  }
  const keyBuffer = Buffer.from(key, "hex");
  if (keyBuffer.length !== 64) {
    return false;
  }
  try {
    const derivedKey = crypto.scryptSync(password, salt, 64);
    if (!derivedKey || derivedKey.length !== 64) {
      return false;
    }
    return crypto.timingSafeEqual(keyBuffer, derivedKey);
  } catch (_) {
    return false;
  }
}

// Session Token Management
async function createSession(userId, ttlMs = 30 * 24 * 60 * 60 * 1000) {
  const token = crypto.randomBytes(32).toString("hex");
  const now = Date.now();
  const expiresAt = now + ttlMs;

  await run(
    "INSERT INTO sessions (token, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)",
    [token, userId, now, expiresAt]
  );

  return { token, expiresAt };
}

async function validateSession(token) {
  if (!token || typeof token !== "string") return null;

  const now = Date.now();
  const session = await get(
    `SELECT s.token, s.user_id, s.expires_at, u.id, u.username, u.role
     FROM sessions s
     JOIN users u ON u.id = s.user_id
     WHERE s.token = ? AND s.expires_at > ?
     LIMIT 1`,
    [token, now]
  );

  if (!session) return null;

  return {
    id: session.id,
    username: session.username,
    role: session.role || "user",
    token: session.token,
    expiresAt: session.expires_at
  };
}

async function deleteSession(token) {
  if (!token) return;
  await run("DELETE FROM sessions WHERE token = ?", [token]);
}

// Authentication Middleware
async function requireAuth(req, res, next) {
  try {
    const authHeader = req.headers.authorization || req.headers["x-auth-token"];
    let token = null;

    if (authHeader) {
      if (authHeader.startsWith("Bearer ")) {
        token = authHeader.slice(7).trim();
      } else {
        token = authHeader.trim();
      }
    }

    if (!token) {
      return res.status(401).json({
        success: false,
        error: "Authentication required. Please provide a valid Authorization token."
      });
    }

    const user = await validateSession(token);
    if (!user) {
      return res.status(401).json({
        success: false,
        error: "Session expired or invalid. Please sign in again."
      });
    }

    req.user = user;
    req.sessionToken = token;
    next();
  } catch (err) {
    res.status(500).json({ success: false, error: "Internal authentication error" });
  }
}

// Multi-User Registration Mode Configuration (Default: enabled)
function isPublicRegistrationAllowed() {
  return process.env.ALLOW_PUBLIC_REGISTRATION !== "false";
}

// User Registration & Login Handlers
async function isSetupRequired() {
  const row = await get("SELECT COUNT(*) as count FROM users");
  return !row || row.count === 0;
}

// Role-Based Access Control Middleware
function requireAdmin(req, res, next) {
  if (!req.user || req.user.role !== "admin") {
    return res.status(403).json({
      success: false,
      error: "Administrator privileges required"
    });
  }
  next();
}

// In-process lock to serialize concurrent registration operations
let registrationLock = Promise.resolve();

async function registerUser(username, password) {
  const cleanUsername = String(username || "").trim().toLowerCase();
  if (!cleanUsername || cleanUsername.length < 3) {
    throw new Error("Username must be at least 3 characters");
  }

  // Pre-compute password hash asynchronously to minimize lock duration
  const passwordHash = await hashPasswordAsync(password);
  const id = crypto.randomUUID();
  const now = Date.now();

  // Acquire in-process mutex
  let releaseLock;
  const lockWait = new Promise((resolve) => { releaseLock = resolve; });
  const prevLock = registrationLock;
  registrationLock = prevLock.then(() => lockWait, () => lockWait);
  await prevLock;

  try {
    // Atomic SQLite transaction with RESERVED lock
    await run("BEGIN IMMEDIATE");
    try {
      const countRow = await get("SELECT COUNT(*) as count FROM users");
      const userCount = countRow ? countRow.count : 0;
      const isFirst = (userCount === 0);

      if (!isFirst && !isPublicRegistrationAllowed()) {
        throw new Error("Registration is closed. Only the primary administrator account can be created.");
      }

      const existing = await get("SELECT id FROM users WHERE lower(username) = lower(?)", [cleanUsername]);
      if (existing) {
        throw new Error("Username is already taken");
      }

      const role = isFirst ? "admin" : "user";

      await run(
        "INSERT INTO users (id, username, password_hash, role, created_at) VALUES (?, ?, ?, ?, ?)",
        [id, cleanUsername, passwordHash, role, now]
      );

      await run("COMMIT");

      const session = await createSession(id);
      return {
        user: { id, username: cleanUsername, role },
        token: session.token,
        expiresAt: session.expiresAt
      };
    } catch (err) {
      await run("ROLLBACK").catch(() => {});
      throw err;
    }
  } finally {
    releaseLock();
  }
}

async function createUserByAdmin(username, password, role = "user") {
  const cleanUsername = String(username || "").trim().toLowerCase();
  if (!cleanUsername || cleanUsername.length < 3) {
    throw new Error("Username must be at least 3 characters");
  }

  const existing = await get("SELECT id FROM users WHERE lower(username) = lower(?)", [cleanUsername]);
  if (existing) {
    throw new Error("Username is already taken");
  }

  const validRole = (role === "admin") ? "admin" : "user";
  const id = crypto.randomUUID();
  const passwordHash = await hashPasswordAsync(password);
  const now = Date.now();

  await run(
    "INSERT INTO users (id, username, password_hash, role, created_at) VALUES (?, ?, ?, ?, ?)",
    [id, cleanUsername, passwordHash, validRole, now]
  );

  return { id, username: cleanUsername, role: validRole, created_at: now };
}

async function listUsers() {
  return await all("SELECT id, username, role, created_at FROM users ORDER BY created_at ASC");
}

async function deleteUserAccount(userId) {
  if (!userId) throw new Error("User ID is required");

  const targetUser = await get("SELECT id, role FROM users WHERE id = ?", [userId]);
  if (!targetUser) {
    throw new Error("User not found");
  }

  if (targetUser.role === "admin") {
    const adminCountRow = await get("SELECT COUNT(*) as count FROM users WHERE role = 'admin'");
    const adminCount = adminCountRow ? adminCountRow.count : 0;
    if (adminCount <= 1) {
      throw new Error("Cannot delete the last administrator account");
    }
  }

  // Close WhatsApp session & wipe session files/attachments safely
  try {
    const { closeAndCleanupUserSession } = require("./engine");
    if (closeAndCleanupUserSession) {
      await closeAndCleanupUserSession(userId);
    }
  } catch (err) {
    console.error(`[Auth] Error cleaning up WhatsApp session for user ${userId}:`, err.message);
  }

  await run("DELETE FROM sessions WHERE user_id = ?", [userId]);
  await run("DELETE FROM contacts WHERE user_id = ?", [userId]);
  await run("DELETE FROM settings WHERE user_id = ?", [userId]);
  await run("DELETE FROM schedules WHERE user_id = ?", [userId]);
  await run("DELETE FROM users WHERE id = ?", [userId]);
  return { success: true };
}

async function authenticateUser(username, password) {
  const cleanUsername = String(username || "").trim().toLowerCase();
  if (!cleanUsername || !password) {
    throw new Error("Username and password are required");
  }

  const user = await get("SELECT * FROM users WHERE lower(username) = lower(?)", [cleanUsername]);
  if (!user) {
    throw new Error("Invalid username or password");
  }

  const valid = await verifyPasswordAsync(password, user.password_hash);
  if (!valid) {
    throw new Error("Invalid username or password");
  }

  const session = await createSession(user.id);
  return {
    user: { id: user.id, username: user.username, role: user.role || "user" },
    token: session.token,
    expiresAt: session.expiresAt
  };
}

async function bootstrapAdminFromEnv() {
  const adminUser = (process.env.ADMIN_USERNAME || "").trim().toLowerCase();
  const adminPass = (process.env.ADMIN_PASSWORD || "").trim();

  if (!adminUser || !adminPass) return null;

  try {
    const existing = await get("SELECT id, role FROM users WHERE lower(username) = lower(?)", [adminUser]);
    if (existing) {
      if (existing.role !== "admin") {
        await run("UPDATE users SET role = 'admin' WHERE id = ?", [existing.id]);
        console.log(`[Auth] Promoted existing user "${adminUser}" to administrator via environment configuration.`);
      }
      return existing;
    }

    const id = crypto.randomUUID();
    const passwordHash = await hashPasswordAsync(adminPass);
    const now = Date.now();
    await run(
      "INSERT INTO users (id, username, password_hash, role, created_at) VALUES (?, ?, ?, 'admin', ?)",
      [id, adminUser, passwordHash, now]
    );
    console.log(`[Auth] Bootstrapped dedicated administrator account "${adminUser}" from environment configuration.`);
    return { id, username: adminUser, role: "admin" };
  } catch (err) {
    console.error("[Auth] Failed to bootstrap admin from environment:", err.message);
    return null;
  }
}

module.exports = {
  hashPassword,
  verifyPassword,
  hashPasswordAsync,
  verifyPasswordAsync,
  createSession,
  validateSession,
  deleteSession,
  requireAuth,
  requireAdmin,
  isSetupRequired,
  isPublicRegistrationAllowed,
  registerUser,
  createUserByAdmin,
  listUsers,
  deleteUserAccount,
  authenticateUser,
  bootstrapAdminFromEnv
};
