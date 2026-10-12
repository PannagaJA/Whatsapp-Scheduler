const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { initAuthCreds, BufferJSON, proto } = require("@whiskeysockets/baileys");

const AAD_IDENTIFIER = Buffer.from("wa-session-v1", "utf8");
const ENVELOPE_MARKER = 1;

let _warnedDevKey = false;
const DEV_FALLBACK_KEY = Buffer.from("0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef", "hex");

/**
 * Validates and parses a 32-byte (256-bit) encryption key from string or Buffer.
 * Supports: 64-character hex string, 32-byte raw string/buffer, or 44-character base64 string.
 */
function validateKeyFormat(keyInput) {
  if (!keyInput) {
    throw new Error("SESSION_ENCRYPTION_KEY is required and cannot be empty");
  }

  if (Buffer.isBuffer(keyInput)) {
    if (keyInput.length !== 32) {
      throw new Error(`Invalid SESSION_ENCRYPTION_KEY length: expected 32 bytes, got ${keyInput.length}`);
    }
    return keyInput;
  }

  if (typeof keyInput !== "string") {
    throw new Error("Invalid SESSION_ENCRYPTION_KEY: expected string or Buffer");
  }

  const trimmed = keyInput.trim();
  if (!trimmed) {
    throw new Error("SESSION_ENCRYPTION_KEY cannot be whitespace");
  }

  // 64-character Hex string
  if (/^[0-9a-fA-F]{64}$/.test(trimmed)) {
    return Buffer.from(trimmed, "hex");
  }

  // 44-character Base64 string
  if (/^[A-Za-z0-9+/]{43}=?$/.test(trimmed)) {
    const buf = Buffer.from(trimmed, "base64");
    if (buf.length === 32) return buf;
  }

  // 32-byte raw string
  const rawBuf = Buffer.from(trimmed, "utf8");
  if (rawBuf.length === 32) {
    return rawBuf;
  }

  throw new Error("Invalid SESSION_ENCRYPTION_KEY format: must be 32 bytes (64 hex characters or 32-byte base64/raw)");
}

/**
 * Retrieves the session encryption key from environment.
 * Fails safely in production if missing or malformed.
 */
function getSessionEncryptionKey() {
  const envKey = process.env.SESSION_ENCRYPTION_KEY;
  if (!envKey) {
    if (process.env.NODE_ENV === "production") {
      throw new Error("PRODUCTION CONFIG ERROR: SESSION_ENCRYPTION_KEY must be set in production");
    }
    if (!_warnedDevKey) {
      console.warn("[SessionCrypto] WARNING: SESSION_ENCRYPTION_KEY not set. Using development key. Configure SESSION_ENCRYPTION_KEY before production.");
      _warnedDevKey = true;
    }
    return DEV_FALLBACK_KEY;
  }
  return validateKeyFormat(envKey);
}

/**
 * Encrypts arbitrary string or Buffer using AES-256-GCM.
 * Generates a unique 12-byte nonce for each operation.
 */
function encryptData(data, key) {
  const parsedKey = validateKeyFormat(key);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", parsedKey, iv);
  cipher.setAAD(AAD_IDENTIFIER);

  const inputBuffer = Buffer.isBuffer(data) ? data : Buffer.from(typeof data === "string" ? data : JSON.stringify(data), "utf8");
  const ciphertext = Buffer.concat([cipher.update(inputBuffer), cipher.final()]);
  const authTag = cipher.getAuthTag();

  return {
    _enc: ENVELOPE_MARKER,
    alg: "aes-256-gcm",
    iv: iv.toString("hex"),
    tag: authTag.toString("hex"),
    data: ciphertext.toString("hex")
  };
}

/**
 * Decrypts an encrypted envelope using AES-256-GCM.
 * Authenticates ciphertext and tag; throws if tampered, corrupted, or invalid key.
 */
function decryptData(envelope, key) {
  const parsedKey = validateKeyFormat(key);

  if (!envelope || envelope._enc !== ENVELOPE_MARKER || envelope.alg !== "aes-256-gcm") {
    throw new Error("Invalid or unsupported ciphertext envelope");
  }

  if (!envelope.iv || !envelope.tag || !envelope.data) {
    throw new Error("Malformed ciphertext envelope: missing iv, tag, or data");
  }

  const iv = Buffer.from(envelope.iv, "hex");
  const authTag = Buffer.from(envelope.tag, "hex");
  const ciphertext = Buffer.from(envelope.data, "hex");

  if (iv.length !== 12) {
    throw new Error(`Invalid IV length: expected 12 bytes, got ${iv.length}`);
  }
  if (authTag.length !== 16) {
    throw new Error(`Invalid auth tag length: expected 16 bytes, got ${authTag.length}`);
  }

  const decipher = crypto.createDecipheriv("aes-256-gcm", parsedKey, iv);
  decipher.setAAD(AAD_IDENTIFIER);
  decipher.setAuthTag(authTag);

  try {
    const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    return decrypted.toString("utf8");
  } catch (err) {
    throw new Error("Session credential decryption failed: authentication tag mismatch or corrupted data");
  }
}

/**
 * Reads a JSON file, transparently decrypting if encrypted or parsing if legacy plaintext.
 */
function readDecryptedJson(filePath, key, reviver) {
  if (!fs.existsSync(filePath)) return null;

  const rawContent = fs.readFileSync(filePath, "utf8");
  if (!rawContent.trim()) return null;

  let parsed;
  try {
    parsed = JSON.parse(rawContent);
  } catch (err) {
    throw new Error(`Failed to parse session file ${path.basename(filePath)}: ${err.message}`);
  }

  // If already encrypted envelope
  if (parsed && parsed._enc === ENVELOPE_MARKER && parsed.alg === "aes-256-gcm") {
    const plainText = decryptData(parsed, key);
    return JSON.parse(plainText, reviver);
  }

  // Legacy plaintext format
  return JSON.parse(rawContent, reviver);
}

/**
 * Atomically writes data encrypted with AES-256-GCM to a file.
 */
function writeEncryptedJson(filePath, data, key, replacer) {
  const plainText = JSON.stringify(data, replacer);
  const envelope = encryptData(plainText, key);
  const envelopeJson = JSON.stringify(envelope, null, 2);

  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const tempPath = `${filePath}.tmp.${crypto.randomBytes(6).toString("hex")}`;
  fs.writeFileSync(tempPath, envelopeJson, { mode: 0o600 });
  fs.renameSync(tempPath, filePath);
}

/**
 * Safely migrates an existing session directory from plaintext to encrypted.
 * Performs backup and verification before overwriting.
 */
function migrateSessionDirectory(authDir, key) {
  if (!fs.existsSync(authDir)) return { migrated: 0, skipped: 0 };

  const parsedKey = validateKeyFormat(key);
  const files = fs.readdirSync(authDir);
  let migratedCount = 0;
  let skippedCount = 0;

  for (const file of files) {
    if (!file.endsWith(".json") || file.endsWith(".tmp") || file.endsWith(".bak")) {
      continue;
    }

    const fullPath = path.join(authDir, file);
    const content = fs.readFileSync(fullPath, "utf8");
    if (!content.trim()) continue;

    let parsed;
    try {
      parsed = JSON.parse(content);
    } catch (_) {
      continue;
    }

    // Skip already encrypted files
    if (parsed && parsed._enc === ENVELOPE_MARKER && parsed.alg === "aes-256-gcm") {
      skippedCount++;
      continue;
    }

    // Plaintext file: backup, encrypt, verify, then atomic replace
    const backupPath = `${fullPath}.bak`;
    fs.copyFileSync(fullPath, backupPath);

    try {
      const encryptedEnvelope = encryptData(content, parsedKey);
      const tempPath = `${fullPath}.enc.tmp`;
      fs.writeFileSync(tempPath, JSON.stringify(encryptedEnvelope, null, 2), { mode: 0o600 });

      // Verification: read back and decrypt to verify integrity
      const verifyRaw = JSON.parse(fs.readFileSync(tempPath, "utf8"));
      const verifiedPlain = decryptData(verifyRaw, parsedKey);
      if (verifiedPlain !== content) {
        throw new Error("Migration integrity verification failed: round-trip mismatch");
      }

      // Atomic rename
      fs.renameSync(tempPath, fullPath);

      // Clean up backup after verified write
      if (fs.existsSync(backupPath)) {
        fs.unlinkSync(backupPath);
      }
      migratedCount++;
    } catch (err) {
      // Rollback from backup if error occurred
      if (fs.existsSync(backupPath)) {
        fs.copyFileSync(backupPath, fullPath);
        fs.unlinkSync(backupPath);
      }
      throw new Error(`Failed to safely migrate session file ${file}: ${err.message}`);
    }
  }

  return { migrated: migratedCount, skipped: skippedCount };
}

/**
 * In-memory mutex for file operations to prevent concurrent write collisions.
 */
const fileLocks = new Map();
function acquireFileLock(filePath) {
  let lockPromise = fileLocks.get(filePath) || Promise.resolve();
  let releaseLock;
  const nextLock = new Promise((resolve) => {
    releaseLock = resolve;
  });
  fileLocks.set(filePath, lockPromise.then(() => nextLock));
  return {
    acquire: () => lockPromise,
    release: () => {
      releaseLock();
      if (fileLocks.get(filePath) === nextLock) {
        fileLocks.delete(filePath);
      }
    }
  };
}

/**
 * Encrypted authentication state provider for Baileys.
 * Drop-in authenticated encrypted replacement for `useMultiFileAuthState`.
 */
async function useEncryptedAuthState(folder, keyInput) {
  const encryptionKey = keyInput ? validateKeyFormat(keyInput) : getSessionEncryptionKey();

  if (!fs.existsSync(folder)) {
    fs.mkdirSync(folder, { recursive: true, mode: 0o700 });
  }

  const fixFileName = (file) => file?.replace(/\//g, "__")?.replace(/:/g, "-");

  const writeData = async (data, file) => {
    const filePath = path.join(folder, fixFileName(file));
    const lock = acquireFileLock(filePath);
    await lock.acquire();
    try {
      writeEncryptedJson(filePath, data, encryptionKey, BufferJSON.replacer);
    } finally {
      lock.release();
    }
  };

  const readData = async (file) => {
    const filePath = path.join(folder, fixFileName(file));
    const lock = acquireFileLock(filePath);
    await lock.acquire();
    try {
      return readDecryptedJson(filePath, encryptionKey, BufferJSON.reviver);
    } catch (err) {
      // Re-throw if authentication/integrity error
      if (err.message && err.message.includes("authentication tag mismatch")) {
        throw err;
      }
      return null;
    } finally {
      lock.release();
    }
  };

  const removeData = async (file) => {
    const filePath = path.join(folder, fixFileName(file));
    const lock = acquireFileLock(filePath);
    await lock.acquire();
    try {
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
      }
    } catch (_) {
    } finally {
      lock.release();
    }
  };

  const creds = (await readData("creds.json")) || initAuthCreds();

  return {
    state: {
      creds,
      keys: {
        get: async (type, ids) => {
          const data = {};
          await Promise.all(
            ids.map(async (id) => {
              let value = await readData(`${type}-${id}.json`);
              if (type === "app-state-sync-key" && value) {
                value = proto.Message.AppStateSyncKeyData.fromObject(value);
              }
              data[id] = value;
            })
          );
          return data;
        },
        set: async (data) => {
          const tasks = [];
          for (const category in data) {
            for (const id in data[category]) {
              const value = data[category][id];
              const file = `${category}-${id}.json`;
              tasks.push(value ? writeData(value, file) : removeData(file));
            }
          }
          await Promise.all(tasks);
        }
      }
    },
    saveCreds: async () => {
      return writeData(creds, "creds.json");
    }
  };
}

module.exports = {
  validateKeyFormat,
  getSessionEncryptionKey,
  encryptData,
  decryptData,
  readDecryptedJson,
  writeEncryptedJson,
  migrateSessionDirectory,
  useEncryptedAuthState
};
