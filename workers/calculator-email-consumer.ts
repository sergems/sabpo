import { sendLeadEmail, type CalculatorEmailEnvironment, type CalculatorLead, type CalculatorSelection } from "../shared/calculator-intake";

type D1DatabaseLike = {
  prepare: (query: string) => { bind: (...values: unknown[]) => { run: () => Promise<unknown>; all: <T>() => Promise<{ results: T[] }> } };
};

type WorkerEnv = CalculatorEmailEnvironment & { DB: D1DatabaseLike };
type QueueMessage = { submissionId: string };
type QueueBatch = { messages: Array<{ body: QueueMessage; ack: () => void; retry: () => void }> };

type StoredPayload = {
  submissionId: string;
  lead: CalculatorLead;
  calculator: CalculatorSelection | null;
  sendCopyToCustomer: boolean;
};

type StoredRow = { payload: string; status: string };

export default {
  async queue(batch: QueueBatch, env: WorkerEnv): Promise<void> {
    for (const message of batch.messages) {
      const { submissionId } = message.body;
      try {
        const result = await env.DB.prepare("SELECT payload, status FROM calculator_submissions WHERE id = ?")
          .bind(submissionId).all<StoredRow>();
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
};
