const fs = require("fs");
const path = require("path");
const { run, get, all, DB_DIR } = require("./db");
const { sendWhatsAppMessage, getStatus } = require("./engine");

const UPLOADS_DIR = path.join(DB_DIR, "uploads");

function isPathContained(targetPath, baseDir) {
  if (!targetPath || typeof targetPath !== "string") return false;
  const resolvedTarget = path.resolve(targetPath);
  const resolvedBase = path.resolve(baseDir);
  return resolvedTarget.startsWith(resolvedBase + path.sep);
}

function safeDeleteAttachment(filePath, baseDir = UPLOADS_DIR) {
  if (!filePath || !isPathContained(filePath, baseDir)) return false;
  try {
    if (fs.existsSync(filePath)) {
      const stat = fs.lstatSync(filePath);
      if (stat.isFile() && !stat.isSymbolicLink()) {
        fs.unlinkSync(filePath);
        return true;
      }
    }
  } catch (err) {
    console.error(`[Scheduler Attachment Cleanup] Failed to delete ${filePath}:`, err.message);
  }
  return false;
}

let isProcessing = false;

async function checkAndProcessSchedules() {
  if (isProcessing) return;
  isProcessing = true;

  try {
    const now = Date.now();
    const pendingJobs = await all(`
      SELECT * FROM schedules 
      WHERE status IN ('scheduled', 'retrying') 
        AND scheduled_at <= ? 
      ORDER BY scheduled_at ASC
      LIMIT 10
    `, [now]);

    if (!pendingJobs || pendingJobs.length === 0) {
      isProcessing = false;
      return;
    }

    for (const job of pendingJobs) {
      // Atomic claim to prevent double-execution in race conditions / multi-process
      const claimResult = await run(
        `UPDATE schedules SET status = 'processing', attempts = attempts + 1, updated_at = ? WHERE id = ? AND status IN ('scheduled', 'retrying')`,
        [Date.now(), job.id]
      );
      if (claimResult.changes === 0) {
        // Already claimed by another worker or updated
        continue;
      }

      const userId = job.user_id;
      if (!userId) {
        console.error(`[Scheduler] Job ${job.id} has no associated user_id. Marking failed.`);
        await run(`UPDATE schedules SET status = 'failed', error = 'Missing owning user_id', updated_at = ? WHERE id = ?`, [Date.now(), job.id]);
        continue;
      }

      // Check the owning user's WhatsApp connection status
      const statusObj = await getStatus(userId);
      if (statusObj.status !== "connected") {
        console.log(`[Scheduler] User ${userId} WhatsApp is not connected (${statusObj.status}). Postponing job ${job.id}...`);
        const retryAt = Date.now() + 60 * 1000;
        await run(`UPDATE schedules SET status = 'retrying', scheduled_at = ?, error = 'WhatsApp not connected for user', updated_at = ? WHERE id = ?`, [retryAt, Date.now(), job.id]);
        continue;
      }

      console.log(`[Scheduler] Processing job ${job.id} for user ${userId} to "${job.recipient}"...`);

      let attachments = [];
      try {
        attachments = job.attachments ? JSON.parse(job.attachments) : [];
      } catch (_) {}

      try {
        const result = await sendWhatsAppMessage(userId, job.recipient, job.text, attachments);

        await run(`
          UPDATE schedules 
          SET status = 'sent', sent_at = ?, updated_at = ?, jid = coalesce(?, jid), error = NULL 
          WHERE id = ?
        `, [Date.now(), Date.now(), result?.jid || null, job.id]);
        console.log(`[Scheduler] Job ${job.id} sent successfully for user ${userId} to ${result?.jid || job.recipient}!`);

        // Clean up temporary attachment files safely
        for (const file of attachments) {
          if (file.path) {
            safeDeleteAttachment(file.path, path.join(UPLOADS_DIR, userId));
            safeDeleteAttachment(file.path, UPLOADS_DIR);
          }
        }
      } catch (err) {
        console.error(`[Scheduler] Job ${job.id} failed:`, err.message);
        const maxAttempts = 3;
        if (job.attempts + 1 >= maxAttempts) {
          await run(`
            UPDATE schedules 
            SET status = 'failed', error = ?, updated_at = ? 
            WHERE id = ?
          `, [err.message || String(err), Date.now(), job.id]);
        } else {
          // Retry in 2 minutes
          const retryAt = Date.now() + 2 * 60 * 1000;
          await run(`
            UPDATE schedules 
            SET status = 'retrying', scheduled_at = ?, error = ?, updated_at = ? 
            WHERE id = ?
          `, [retryAt, err.message || String(err), Date.now(), job.id]);
        }
      }
    }
  } catch (err) {
    console.error("[Scheduler] Error in scheduler loop:", err);
  } finally {
    isProcessing = false;
  }
}

async function recoverStaleProcessingJobs(staleThresholdMs = 5 * 60 * 1000) {
  try {
    const staleBefore = Date.now() - staleThresholdMs;
    const res = await run(`
      UPDATE schedules 
      SET status = 'retrying', scheduled_at = ?, error = 'Recovered after server restart (stale processing job)', updated_at = ? 
      WHERE status = 'processing' AND (updated_at IS NULL OR updated_at < ?)
    `, [Date.now(), Date.now(), staleBefore]);
    if (res.changes > 0) {
      console.log(`[Scheduler] Recovered ${res.changes} orphaned processing job(s) on boot.`);
    }
    return res.changes;
  } catch (err) {
    console.error("[Scheduler] Error recovering stale jobs:", err.message);
    return 0;
  }
}

function startScheduler(intervalMs = 5000) {
  console.log("[Scheduler] Background scheduler loop started (interval: 5s).");
  recoverStaleProcessingJobs();
  setInterval(checkAndProcessSchedules, intervalMs);
}

module.exports = {
  startScheduler,
  checkAndProcessSchedules,
  recoverStaleProcessingJobs,
  safeDeleteAttachment,
  isPathContained
};
