// Processo filho do teste automacoes-sigkill-do-processo-node: roda completeSend de verdade
// (outro processo Node, outro socket) e é morto com SIGKILL pelo pai no meio da transação.
import pg from "pg";

import { PgExecutionJournal } from "@/lib/followup/execution-journal-pg";
import { createPgAdminClient } from "@/lib/followup/turn-bridge";

const { DB_PORT, ORG, ENROLLMENT, JOB, CLAIM_WORKER, CLAIM_AT } = process.env;
const pool = new pg.Pool({
  connectionString: `postgresql://postgres:postgres@127.0.0.1:${Number(DB_PORT)}/postgres`,
  max: 2,
});
pool.on("error", () => {});
pool.on("connect", (c) => c.on("error", () => {}));
async function main() {
  const scope = (await createPgAdminClient(pool).loadEnrollmentById(ORG!, ENROLLMENT!))!;

  const out = await new PgExecutionJournal(pool).completeSend(scope, JOB!, {
    worker_id: CLAIM_WORKER!,
    acquired_at: CLAIM_AT!,
  });
  console.log("DONE " + JSON.stringify({ reused: out.reused }));
  await pool.end();
}
main().catch((e) => {
  console.error(String(e));
  process.exit(2);
});
