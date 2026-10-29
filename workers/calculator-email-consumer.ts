import {
  sendCalculatorDigestEmail,
  sendLeadEmail,
  type CalculatorEmailEnvironment,
  type CalculatorDigestItem,
  type CalculatorLead,
  type CalculatorSelection,
} from "../shared/calculator-intake";

type D1Result = { meta?: { changes?: number } };
type D1DatabaseLike = {
  prepare: (query: string) => { bind: (...values: unknown[]) => { run: () => Promise<D1Result>; all: <T>() => Promise<{ results: T[] }> } };
};

type WorkerEnv = CalculatorEmailEnvironment & { DB: D1DatabaseLike; DIGEST_TRIGGER_TOKEN?: string };
type QueueMessage = { submissionId: string };
type QueueBatch = { messages: Array<{ body: QueueMessage; ack: () => void; retry: () => void }> };
type ScheduledContext = { waitUntil: (promise: Promise<unknown>) => void };

type StoredPayload = {
  submissionId: string;
  lead: CalculatorLead;
  calculator: CalculatorSelection | null;
  sendCopyToCustomer: boolean;
};
type StoredRow = { id: string; payload: string; status: string; created_at: number };

async function sendQueuedBrowserCloseDigest(env: WorkerEnv): Promise<number> {
  const cutoff = Date.now() - 60 * 60 * 1000;
  const result = await env.DB.prepare(
    "SELECT id, payload, status, created_at FROM calculator_submissions WHERE status = 'queued' AND created_at < ? ORDER BY created_at ASC LIMIT 100",
  ).bind(cutoff).all<StoredRow>();
  if (result.results.length === 0) return 0;

  const claimed: Array<{ row: StoredRow; item: CalculatorDigestItem }> = [];
  for (const row of result.results) {
    const update = await env.DB.prepare(
      "UPDATE calculator_submissions SET status = 'processing', attempts = attempts + 1 WHERE id = ? AND status = 'queued'",
    ).bind(row.id).run();
    if ((update.meta?.changes ?? 0) === 0) continue;
    const payload = JSON.parse(row.payload) as StoredPayload;
    claimed.push({
      row,
      item: {
        submissionId: payload.submissionId,
        lead: payload.lead,
        calculator: payload.calculator ?? undefined,
        createdAt: row.created_at,
      },
    });
  }
  if (claimed.length === 0) return 0;

  try {
    await sendCalculatorDigestEmail(claimed.map(({ item }) => item), env);
    for (const { row } of claimed) {
      await env.DB.prepare("UPDATE calculator_submissions SET status = 'sent', processed_at = ?, last_error = NULL WHERE id = ?")
        .bind(Date.now(), row.id).run();
    }
  } catch {
    for (const { row } of claimed) {
      await env.DB.prepare("UPDATE calculator_submissions SET status = 'queued', last_error = ? WHERE id = ?")
        .bind("Daily browser-close digest delivery failed; will retry", row.id).run();
    }
    throw new Error("Daily browser-close digest delivery failed");
  }
  return claimed.length;
}

export default {
  async fetch(request: Request, env: WorkerEnv): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname !== "/admin/send-browser-close-digest" || request.method !== "POST") {
      return new Response("Not found", { status: 404 });
    }
    const expectedToken = env.DIGEST_TRIGGER_TOKEN?.trim();
    const suppliedToken = request.headers.get("X-Digest-Trigger-Token")?.trim();
    if (!expectedToken || !suppliedToken || suppliedToken !== expectedToken) {
      return new Response("Unauthorized", { status: 401 });
    }
    try {
      const count = await sendQueuedBrowserCloseDigest(env);
      return new Response(JSON.stringify({ ok: true, sent: count }), {
        headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
      });
    } catch {
      return new Response(JSON.stringify({ ok: false, error: "Digest delivery failed" }), {
        status: 502,
        headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
      });
    }
  },

  async queue(batch: QueueBatch, env: WorkerEnv): Promise<void> {
    for (const message of batch.messages) {
      const { submissionId } = message.body;
      try {
        const result = await env.DB.prepare("SELECT payload, status FROM calculator_submissions WHERE id = ?")
          .bind(submissionId).all<{ payload: string; status: string }>();
        const row = result.results[0];
        if (!row || row.status === "sent") {
          message.ack();
          continue;
        }

        await env.DB.prepare("UPDATE calculator_submissions SET status = 'processing', attempts = attempts + 1 WHERE id = ?")
          .bind(submissionId).run();
        const payload = JSON.parse(row.payload) as StoredPayload;
        await sendLeadEmail(payload.lead, env, payload.calculator ?? undefined, payload.sendCopyToCustomer);
        await env.DB.prepare("UPDATE calculator_submissions SET status = 'sent', processed_at = ?, last_error = NULL WHERE id = ?")
          .bind(Date.now(), submissionId).run();
        message.ack();
      } catch {
        await env.DB.prepare("UPDATE calculator_submissions SET status = 'failed', last_error = ? WHERE id = ?")
          .bind("Email delivery failed; the queue will retry", submissionId).run();
        message.retry();
      }
    }
  },

  async scheduled(_event: unknown, env: WorkerEnv, context: ScheduledContext): Promise<void> {
    context.waitUntil(sendQueuedBrowserCloseDigest(env));
  },
};
