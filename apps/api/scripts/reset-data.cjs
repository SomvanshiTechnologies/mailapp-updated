// Wipe all campaign data and start fresh, keeping configuration.
//
// Removes: campaigns, leads, emails, send attempts, delivery events, model call log, inbound
// messages, campaign access grants, uploaded files (rows only; see reset-prod-data.ps1 for S3),
// audit log, SES snapshots, daily send counters, the suppression list and every queued job.
// Keeps: users (with their sender profiles and IMAP settings), sessions, organisation settings,
// services, instruction documents, the link page and the IMAP polling cursors.
//
// Plain CommonJS so it runs unchanged both locally (`npm run db:reset -w apps/api`) and inside the
// production image via `node -e` (infra/cdk/reset-prod-data.ps1). Needs DATABASE_URL.
const { Client } = require("pg");

const TABLES = [
  "campaigns",
  "leads",
  "emails",
  "send_attempts",
  "email_events",
  "llm_calls",
  "inbound_messages",
  "campaign_access",
  "files",
  "audit_logs",
  "ses_snapshots",
  "daily_send_counters",
  "suppressions",
];

async function main() {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is not set");
  const c = new Client({ connectionString: process.env.DATABASE_URL });
  await c.connect();
  try {
    for (const t of TABLES) {
      const r = await c.query(`select count(*)::int as n from ${t}`);
      console.log(`before ${t}: ${r.rows[0].n}`);
    }
    // The suppression list is the one thing worth keeping a copy of; print it so the log has it.
    const s = await c.query("select email, reason, note, source, created_at from suppressions order by created_at");
    console.log("SUPPRESSIONS_BACKUP " + JSON.stringify(s.rows));
    const j = await c.query("select name, state, count(*)::int as n from pgboss.job group by 1, 2 order by 1, 2");
    console.log("JOBS_BEFORE " + JSON.stringify(j.rows));

    await c.query("begin");
    await c.query(`truncate ${TABLES.join(", ")}`);
    // Queued research/draft/send/follow-up jobs would all point at deleted rows. Cron schedules
    // live in pgboss.schedule and are untouched, so polling and snapshots resume on their own.
    await c.query("delete from pgboss.job");
    await c.query("delete from pgboss.archive");
    await c.query("commit");

    for (const t of TABLES) {
      const r = await c.query(`select count(*)::int as n from ${t}`);
      console.log(`after ${t}: ${r.rows[0].n}`);
    }
    const k = await c.query(
      `select (select count(*)::int from users) as users,
              (select count(*)::int from settings) as settings,
              (select count(*)::int from services) as services,
              (select count(*)::int from instruction_docs) as instructions,
              (select count(*)::int from imap_cursors) as imap_cursors,
              (select count(*)::int from pgboss.job) as jobs`,
    );
    console.log("KEPT " + JSON.stringify(k.rows[0]));
    console.log("RESET DONE");
  } finally {
    await c.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
