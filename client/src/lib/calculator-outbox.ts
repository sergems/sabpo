const OUTBOX_KEY = "sa_bpo_calculator_outbox";
const MAX_OUTBOX_ITEMS = 10;
const OUTBOX_TTL_MS = 24 * 60 * 60 * 1000;

type OutboxItem = Record<string, unknown> & { submissionId: string; queuedAt: number };

function readItems(): OutboxItem[] {
  try {
    const raw = window.localStorage.getItem(OUTBOX_KEY);
    if (!raw) return [];
    const items = JSON.parse(raw) as unknown;
    if (!Array.isArray(items)) return [];
    const cutoff = Date.now() - OUTBOX_TTL_MS;
    return items.filter((item): item is OutboxItem => Boolean(item && typeof item === "object" && typeof (item as OutboxItem).submissionId === "string" && Number((item as OutboxItem).queuedAt) > cutoff));
  } catch {
    return [];
  }
}

function writeItems(items: OutboxItem[]) {
  try { window.localStorage.setItem(OUTBOX_KEY, JSON.stringify(items.slice(-MAX_OUTBOX_ITEMS))); } catch { /* Browser storage is an optional retry enhancement. */ }
}

function createSubmissionId(): string {
  return window.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

export function enqueueIntake(payload: Record<string, unknown>): OutboxItem {
  const item: OutboxItem = {
    ...payload,
    submissionId: typeof payload.submissionId === "string" ? payload.submissionId : createSubmissionId(),
    queuedAt: Date.now(),
  };
  const items = readItems().filter((existing) => existing.submissionId !== item.submissionId);
  items.push(item);
  writeItems(items);
  return item;
}

export function removeIntake(submissionId: string) {
  writeItems(readItems().filter((item) => item.submissionId !== submissionId));
}

export async function flushIntakeOutbox(): Promise<void> {
  for (const item of readItems()) {
    try {
      const response = await fetch("/api/calculator-intake", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(item),
        keepalive: true,
      });
      if (response.ok) removeIntake(item.submissionId);
    } catch {
      // Keep the item for the next visit or a later network retry.
    }
  }
}

export function beaconIntake(payload: Record<string, unknown>): boolean {
  const item = enqueueIntake(payload);
  if (!navigator.sendBeacon) return false;
  return navigator.sendBeacon(
    "/api/calculator-intake",
    new Blob([JSON.stringify(item)], { type: "application/json" }),
  );
}
