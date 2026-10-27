import {
  MAX_BODY_LENGTH,
  processCalculatorIntake,
  validateCalculatorIntake,
  type CalculatorEmailEnvironment,
} from "../../shared/calculator-intake";

type D1DatabaseLike = {
  prepare: (query: string) => { bind: (...values: unknown[]) => { run: () => Promise<{ meta?: { changes?: number } }> } };
};
type QueueLike = { send: (message: unknown) => Promise<void> };
type PagesContext = {
  request: Request;
  env: CalculatorEmailEnvironment & { DB?: D1DatabaseLike; CALCULATOR_EMAIL_QUEUE?: QueueLike };
};

function jsonResponse(body: unknown, status: number, additionalHeaders: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      ...additionalHeaders,
    },
  });
}

export async function onRequest({ request, env }: PagesContext): Promise<Response> {
  if (request.method !== "POST") {
    return jsonResponse({ error: "Method not allowed." }, 405, { Allow: "POST" });
  }

  const contentType = request.headers.get("content-type")?.split(";")[0].trim().toLowerCase();
  if (contentType !== "application/json" && contentType !== "text/plain") return jsonResponse({ error: "Expected a JSON request." }, 415);

  const declaredLength = Number(request.headers.get("content-length") ?? 0);
  if (declaredLength > MAX_BODY_LENGTH) {
    return jsonResponse({ error: "Request is too large." }, 413);
  }

  let rawBody: string;
  try {
    rawBody = await request.text();
  } catch {
    return jsonResponse({ error: "Unable to read the request." }, 400);
  }

  if (rawBody.length > MAX_BODY_LENGTH) {
    return jsonResponse({ error: "Request is too large." }, 413);
  }

  let body: unknown;
  try {
    body = JSON.parse(rawBody);
  } catch {
    return jsonResponse({ error: "Invalid JSON request." }, 400);
  }

  if (!env.DB || !env.CALCULATOR_EMAIL_QUEUE) {
    const clientAddress = request.headers.get("CF-Connecting-IP") ?? "unknown";
    const result = await processCalculatorIntake(body, env, clientAddress);
    return jsonResponse(result.body, result.status);
  }

  if (typeof body !== "object" || body === null || Array.isArray(body)) return jsonResponse({ error: "Check your details and consent, then try again." }, 400);
  const record = body as Record<string, unknown>;
  if (typeof record.website === "string" && record.website.trim()) return jsonResponse({ ok: true }, 202);
  const validated = validateCalculatorIntake(body);
  if (!validated) return jsonResponse({ error: "Check your details and consent, then try again." }, 400);

  const submissionId = typeof record.submissionId === "string" && /^[a-zA-Z0-9_-]{12,100}$/.test(record.submissionId)
    ? record.submissionId
    : crypto.randomUUID();
  const payload = { submissionId, lead: validated.lead, calculator: validated.calculator ?? null, sendCopyToCustomer: validated.sendCopyToCustomer };
  try {
    const inserted = await env.DB.prepare(
      "INSERT OR IGNORE INTO calculator_submissions (id, payload, status, attempts, created_at) VALUES (?, ?, 'queued', 0, ?)",
    ).bind(submissionId, JSON.stringify(payload), Date.now()).run();
    if ((inserted.meta?.changes ?? 0) === 0) return jsonResponse({ ok: true, duplicate: true }, 200);
    await env.CALCULATOR_EMAIL_QUEUE.send({ submissionId });
    return jsonResponse({ ok: true, queued: true }, 202);
  } catch {
    try {
      await env.DB.prepare("UPDATE calculator_submissions SET status = 'failed', last_error = ? WHERE id = ?")
        .bind("Unable to queue calculator email", submissionId).run();
    } catch { /* Keep provider and storage details out of the response. */ }
    return jsonResponse({ error: "We couldn't queue your details just now. Please try again shortly." }, 502);
  }
}
