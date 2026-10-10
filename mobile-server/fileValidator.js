const fs = require("fs");
const path = require("path");

const ALLOWED_EXTENSIONS = new Set([
  // Images
  ".jpg", ".jpeg", ".png", ".webp", ".gif",
  // Videos
  ".mp4", ".3gp", ".mov",
  // Audio
  ".mp3", ".ogg", ".wav", ".m4a", ".aac",
  // Documents
  ".pdf", ".doc", ".docx", ".txt", ".zip"
]);

const ALLOWED_MIME_TYPES = new Set([
  "image/jpeg", "image/png", "image/webp", "image/gif",
  "video/mp4", "video/3gpp", "video/quicktime",
  "audio/mpeg", "audio/ogg", "audio/wav", "audio/mp4", "audio/aac", "audio/x-m4a",
  "application/pdf",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/zip",
  "text/plain",
  "application/octet-stream"
]);

const DANGEROUS_EXTENSIONS = new Set([
  ".exe", ".dll", ".bat", ".cmd", ".sh", ".bash", ".bin", ".elf",
  ".php", ".phtml", ".php3", ".php4", ".php5", ".php7", ".phps",
  ".js", ".mjs", ".cjs", ".ts", ".py", ".pyc", ".pl", ".cgi",
  ".html", ".htm", ".xhtml", ".svg", ".xml", ".jsp", ".asp", ".aspx"
]);

function sanitizeFilename(originalName) {
  if (!originalName || typeof originalName !== "string") return "attachment";
  const base = path.basename(originalName);
  const ext = path.extname(base).toLowerCase();
  const nameWithoutExt = base.slice(0, base.length - ext.length);
  const cleanName = nameWithoutExt.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 80);
  return (cleanName || "attachment") + ext;
}

function checkMagicBytes(buffer, ext) {
  if (!buffer || buffer.length === 0) return false;

  // Immediate rejection of known binary executable signatures
  if (buffer.length >= 2 && buffer[0] === 0x4D && buffer[1] === 0x5A) {
    // Windows PE EXE / DLL (MZ)
    return false;
  }
  if (buffer.length >= 4 && buffer[0] === 0x7F && buffer[1] === 0x45 && buffer[2] === 0x4C && buffer[3] === 0x46) {
    // Linux ELF (\x7fELF)
    return false;
  }
  if (buffer.length >= 4 && buffer[0] === 0xCA && buffer[1] === 0xFE && buffer[2] === 0xBA && buffer[3] === 0xBE) {
    // Java Class bytecode
    return false;
  }

  // Check script tags or PHP tags in first 512 bytes
  const headerText = buffer.slice(0, Math.min(buffer.length, 512)).toString("latin1").toLowerCase();
  if (headerText.includes("<?php") || headerText.includes("<script") || headerText.startsWith("#!/")) {
    return false;
  }

  switch (ext) {
    case ".jpg":
    case ".jpeg":
      return buffer.length >= 3 && buffer[0] === 0xFF && buffer[1] === 0xD8 && buffer[2] === 0xFF;

    case ".png":
      return buffer.length >= 8 &&
        buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4E && buffer[3] === 0x47 &&
        buffer[4] === 0x0D && buffer[5] === 0x0A && buffer[6] === 0x1A && buffer[7] === 0x0A;

    case ".gif":
      return buffer.length >= 4 &&
        buffer[0] === 0x47 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x38;

    case ".webp":
      return buffer.length >= 12 &&
        buffer[0] === 0x52 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x46 &&
        buffer[8] === 0x57 && buffer[9] === 0x45 && buffer[10] === 0x42 && buffer[11] === 0x50;

    case ".pdf":
      return buffer.length >= 4 &&
        buffer[0] === 0x25 && buffer[1] === 0x50 && buffer[2] === 0x44 && buffer[3] === 0x46; // %PDF

    case ".zip":
    case ".docx":
      return buffer.length >= 4 &&
        buffer[0] === 0x50 && buffer[1] === 0x4B &&
        (buffer[2] === 0x03 || buffer[2] === 0x05 || buffer[2] === 0x07) &&
        (buffer[3] === 0x04 || buffer[3] === 0x06 || buffer[3] === 0x08);

    case ".mp4":
    case ".3gp":
    case ".mov":
    case ".m4a":
      if (buffer.length < 8) return false;
      const ftyp = buffer.slice(4, 8).toString("latin1");
      return ftyp === "ftyp" || ftyp === "moov" || buffer[0] === 0x00;

    case ".ogg":
      return buffer.length >= 4 &&
        buffer[0] === 0x4F && buffer[1] === 0x67 && buffer[2] === 0x67 && buffer[3] === 0x53; // OggS

    case ".wav":
      return buffer.length >= 12 &&
        buffer[0] === 0x52 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x46 &&
        buffer[8] === 0x57 && buffer[9] === 0x41 && buffer[10] === 0x56 && buffer[11] === 0x45; // RIFF....WAVE

    case ".mp3":
      if (buffer.length >= 3 && buffer[0] === 0x49 && buffer[1] === 0x44 && buffer[2] === 0x33) return true; // ID3
      if (buffer.length >= 2 && buffer[0] === 0xFF && (buffer[1] & 0xE0) === 0xE0) return true; // Sync word
      return false;

    case ".txt":
      // Text file: ensure no embedded NULL bytes in first 512 bytes
      for (let i = 0; i < Math.min(buffer.length, 512); i++) {
        if (buffer[i] === 0x00) return false;
      }
      return true;

    case ".doc":
      // OLE Compound File Header D0 CF 11 E0 A1 B1 1A E1
      return buffer.length >= 8 &&
        buffer[0] === 0xD0 && buffer[1] === 0xCF && buffer[2] === 0x11 && buffer[3] === 0xE0;

    default:
      return false;
  }
}

function validateUploadedFile(file) {
  if (!file || !file.path) {
    throw new Error("Invalid file upload structure");
  }

  const ext = path.extname(file.originalname || file.name || "").toLowerCase();
  if (!ext || !ALLOWED_EXTENSIONS.has(ext)) {
    throw new Error(`File extension '${ext || "unknown"}' is not permitted.`);
  }

  if (DANGEROUS_EXTENSIONS.has(ext)) {
    throw new Error(`Potentially dangerous file type '${ext}' rejected.`);
  }

  if (file.mimetype && !ALLOWED_MIME_TYPES.has(file.mimetype)) {
    throw new Error(`Declared MIME type '${file.mimetype}' is not permitted.`);
  }

  if (file.size > 25 * 1024 * 1024) {
    throw new Error("File size exceeds the 25MB limit.");
  }

  // Read first 512 bytes for magic number verification
  const fd = fs.openSync(file.path, "r");
  const buffer = Buffer.alloc(512);
  const bytesRead = fs.readSync(fd, buffer, 0, 512, 0);
  fs.closeSync(fd);

  const header = buffer.slice(0, bytesRead);
  const isValidSignature = checkMagicBytes(header, ext);

  if (!isValidSignature) {
    throw new Error(`File content signature does not match declared extension '${ext}'.`);
  }

  return true;
}

module.exports = {
  validateUploadedFile,
  sanitizeFilename,
  checkMagicBytes,
  ALLOWED_EXTENSIONS,
  ALLOWED_MIME_TYPES
};
