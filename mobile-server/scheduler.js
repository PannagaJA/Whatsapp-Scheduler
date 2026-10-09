const fs = require("fs");
const path = require("path");
const { run, get, all } = require("./db");
const { sendWhatsAppMessage, getStatus } = require("./engine");

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

    const statusObj = await getStatus();
    if (statusObj.status !== "connected") {
      console.log(`[Scheduler] ${pendingJobs.length} jobs pending, but WhatsApp engine is not connected (${statusObj.status}). Waiting...`);
      isProcessing = false;
      return;
    }

    for (const job of pendingJobs) {
      console.log(`[Scheduler] Processing job ${job.id} to "${job.recipient}"...`);
      await run(`UPDATE schedules SET status = 'processing', attempts = attempts + 1 WHERE id = ?`, [job.id]);

      let attachments = [];
      try {
        attachments = job.attachments ? JSON.parse(job.attachments) : [];
      } catch (_) {}

      try {
        const result = await sendWhatsAppMessage(job.recipient, job.text, attachments);

        await run(`
          UPDATE schedules 
          SET status = 'sent', sent_at = ?, jid = coalesce(?, jid), error = NULL 
          WHERE id = ?
        `, [Date.now(), result?.jid || null, job.id]);
        console.log(`[Scheduler] Job ${job.id} sent successfully to ${result?.jid || job.recipient}!`);

        // Clean up temporary attachment files
        for (const file of attachments) {
          if (file.path && fs.existsSync(file.path)) {
            try { fs.unlinkSync(file.path); } catch (_) {}
          }
        }
      } catch (err) {
        console.error(`[Scheduler] Job ${job.id} failed:`, err.message);
        const maxAttempts = 3;
        if (job.attempts + 1 >= maxAttempts) {
          await run(`
            UPDATE schedules 
            SET status = 'failed', error = ? 
            WHERE id = ?
          `, [err.message || String(err), job.id]);
        } else {
          // Retry in 2 minutes
          const retryAt = Date.now() + 2 * 60 * 1000;
          await run(`
            UPDATE schedules 
            SET status = 'retrying', scheduled_at = ?, error = ? 
            WHERE id = ?
          `, [retryAt, err.message || String(err), job.id]);
        }
      }
    }
  } catch (err) {
    console.error("[Scheduler] Error in scheduler loop:", err);
  } finally {
    isProcessing = false;
  }
}

function startScheduler(intervalMs = 5000) {
  console.log("[Scheduler] Background scheduler loop started (interval: 5s).");
  setInterval(checkAndProcessSchedules, intervalMs);
}

module.exports = {
  startScheduler,
  checkAndProcessSchedules
};
