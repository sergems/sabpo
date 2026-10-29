import { calculateBpoEstimate, MONTHLY_HOURS, serviceOptions, type Currency } from "./bpo-estimate";

export type CalculatorLead = {
  firstName: string;
  surname: string;
  company: string;
  position: string;
  email: string;
  telephone: string;
};

export type CalculatorSelection = {
  serviceId: string;
  currency: Currency;
  advisorCount: number;
  moreThanThirty: boolean;
};

export type CalculatorEmailEnvironment = {
  RESEND_API_KEY?: string;
};

export type CalculatorIntakeResult = {
  status: number;
  body: { ok: true } | { error: string };
};

type RateWindow = { startedAt: number; count: number };
type ResendApiResponse = { id?: string };

const RECIPIENT = "partnerships@sa-bpo.co.za";
const SENDER = "SA-BPO Calculator <calculator@notifications.sa-bpo.com>";
const RATE_WINDOW_MS = 15 * 60 * 1000;
const RATE_WINDOW_MAX = 5;
const MAX_BODY_LENGTH = 12 * 1024;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PHONE_PATTERN = /^[+()\d\s.-]{7,30}$/;
const rateWindows = new Map<string, RateWindow>();

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readLead(body: unknown): CalculatorLead | null {
  if (!isRecord(body)) return null;

  const limits = {
    firstName: 80,
    surname: 80,
    company: 120,
    position: 100,
    email: 254,
    telephone: 30,
  } as const;

  const lead: CalculatorLead = {
    firstName: typeof body.firstName === "string" ? body.firstName.trim() : "",
    surname: typeof body.surname === "string" ? body.surname.trim() : "",
    company: typeof body.company === "string" ? body.company.trim() : "",
    position: typeof body.position === "string" ? body.position.trim() : "",
    email: typeof body.email === "string" ? body.email.trim().toLowerCase() : "",
    telephone: typeof body.telephone === "string" ? body.telephone.trim() : "",
  };

  if (
    !lead.firstName ||
    !lead.surname ||
    !lead.company ||
    !lead.position ||
    !lead.email ||
    lead.firstName.length > limits.firstName ||
    lead.surname.length > limits.surname ||
    lead.company.length > limits.company ||
    lead.position.length > limits.position ||
    lead.email.length > limits.email ||
    lead.telephone.length > limits.telephone ||
    !EMAIL_PATTERN.test(lead.email) ||
    (lead.telephone.length > 0 && !PHONE_PATTERN.test(lead.telephone))
  ) {
    return null;
  }

  const phoneDigits = lead.telephone.replace(/\D/g, "");
  return !lead.telephone || (phoneDigits.length >= 7 && phoneDigits.length <= 15) ? lead : null;
}

function readCalculatorSelection(value: unknown): CalculatorSelection | null {
  if (!isRecord(value)) return null;
  const { serviceId, currency, advisorCount, moreThanThirty } = value;
  if (
    typeof serviceId !== "string" ||
    !serviceOptions.some((service) => service.id === serviceId) ||
    (currency !== "USD" && currency !== "GBP") ||
    typeof advisorCount !== "number" ||
    !Number.isInteger(advisorCount) ||
    typeof moreThanThirty !== "boolean" ||
    (moreThanThirty && (advisorCount < 31 || advisorCount > 1000)) ||
    (!moreThanThirty && (advisorCount < 1 || advisorCount > 30))
  ) {
    return null;
  }

  return { serviceId, currency, advisorCount, moreThanThirty };
}

function isRateLimited(clientAddress: string): boolean {
  const now = Date.now();
  const key = clientAddress || "unknown";
  const current = rateWindows.get(key);

  if (!current || now - current.startedAt >= RATE_WINDOW_MS) {
    rateWindows.set(key, { startedAt: now, count: 1 });
    if (rateWindows.size > 2_000) {
      rateWindows.forEach((window, address) => {
        if (now - window.startedAt >= RATE_WINDOW_MS) rateWindows.delete(address);
      });
    }
    return false;
  }

  current.count += 1;
  return current.count > RATE_WINDOW_MAX;
}

const formatCurrency = (amount: number, currency: Currency) => new Intl.NumberFormat(
  currency === "USD" ? "en-US" : "en-GB",
  { style: "currency", currency, minimumFractionDigits: 2, maximumFractionDigits: 2 },
).format(amount);

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[character] ?? character);
}

function emailDetailRow(label: string, value: string): string {
  return `<tr>
    <td style="padding:11px 14px;border-bottom:1px solid #e8e7e1;color:#686963;font-size:13px;line-height:19px;vertical-align:top;width:38%;">${escapeHtml(label)}</td>
    <td style="padding:11px 14px;border-bottom:1px solid #e8e7e1;color:#0c0c0b;font-size:14px;line-height:20px;font-weight:600;vertical-align:top;word-break:break-word;">${escapeHtml(value)}</td>
  </tr>`;
}

export type ValidatedCalculatorIntake = {
  lead: CalculatorLead;
  calculator?: CalculatorSelection;
  sendCopyToCustomer: boolean;
};

export function validateCalculatorIntake(body: unknown): ValidatedCalculatorIntake | null {
  if (!isRecord(body) || body.consent !== true) return null;
  const lead = readLead(body);
  if (!lead) return null;
  const hasCalculatorSelection = Object.prototype.hasOwnProperty.call(body, "calculator");
  const calculator = hasCalculatorSelection ? readCalculatorSelection(body.calculator) : undefined;
  if (calculator === null) return null;
  const sendCopyToCustomer = body.sendCopyToCustomer === true;
  if (
    (Object.prototype.hasOwnProperty.call(body, "sendCopyToCustomer") && typeof body.sendCopyToCustomer !== "boolean") ||
    (sendCopyToCustomer && !calculator)
  ) return null;
  return { lead, calculator, sendCopyToCustomer };
}

export async function sendLeadEmail(
  lead: CalculatorLead,
  env: CalculatorEmailEnvironment,
  calculator?: CalculatorSelection,
  sendCopyToCustomer = false,
): Promise<void> {
  const apiKey = env.RESEND_API_KEY?.trim();

  if (!apiKey) {
    throw new Error("Email service is not configured");
  }

  const safeCompany = lead.company.replace(/[\r\n\t]+/g, " ").replace(/\s+/g, " ").slice(0, 120);
  const receivedAt = new Date();
  const receivedLabel = new Intl.DateTimeFormat("en-ZA", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "Africa/Johannesburg",
  }).format(receivedAt) + " SAST";
  const estimate = calculator
    ? calculateBpoEstimate(calculator.currency, calculator.serviceId, calculator.advisorCount)
    : null;
  const text = [
    calculator ? "Completed BPO calculator estimate submission" : "New BPO calculator access request",
    "",
    `Name: ${lead.firstName} ${lead.surname}`,
    `Company: ${lead.company}`,
    `Position: ${lead.position}`,
    `Company email: ${lead.email}`,
    `Telephone: ${lead.telephone}`,
    ...(calculator && estimate ? [
        "",
        "Calculator selections and indicative estimate:",
        `Service focus: ${estimate.selectedService.label}`,
        `Service option: ${calculator.serviceId}`,
        `Currency: ${calculator.currency}`,
        `Advisor count selected: ${calculator.advisorCount}`,
        `More than 30 advisors selected: ${calculator.moreThanThirty ? "Yes" : "No"}`,
        `Rate tier applied: ${estimate.tierLabel}`,
        `Hourly rate per advisor: ${formatCurrency(estimate.hourlyRate, calculator.currency)}`,
        `Monthly rate per advisor: ${formatCurrency(estimate.monthlyPerAdvisor, calculator.currency)}`,
        `Total indicative monthly invoice: ${formatCurrency(estimate.monthlyTotal, calculator.currency)}`,
        `Working assumptions: 9 hours per day, 45 hours per week, ${MONTHLY_HOURS} working hours per month.`,
      ] : []),
    "",
    `Received: ${receivedAt.toISOString()} (${receivedLabel})`,
    "Consent to process the calculator enquiry: Yes",
  ].join("\n");
  const contactRows = [
    ["Name", `${lead.firstName} ${lead.surname}`],
    ["Company", lead.company],
    ["Position", lead.position],
    ["Company email", lead.email],
    ["Telephone", lead.telephone],
  ].map(([label, value]) => emailDetailRow(label, value)).join("");
  const estimateRows = calculator && estimate ? [
    ["Service focus", estimate.selectedService.label],
    ["Service option", calculator.serviceId],
    ["Currency", calculator.currency],
    ["Advisor count", String(calculator.advisorCount)],
    ["More than 30 advisors", calculator.moreThanThirty ? "Yes" : "No"],
    ["Rate tier", estimate.tierLabel],
    ["Hourly rate per advisor", formatCurrency(estimate.hourlyRate, calculator.currency)],
    ["Monthly rate per advisor", formatCurrency(estimate.monthlyPerAdvisor, calculator.currency)],
  ].map(([label, value]) => emailDetailRow(label, value)).join("") : "";
  const title = calculator ? "Calculator estimate submitted" : "New calculator enquiry";
  const html = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <meta name="color-scheme" content="light">
    <title>${escapeHtml(title)}</title>
  </head>
  <body style="margin:0;padding:0;background-color:#f5f3ee;font-family:Arial,Helvetica,sans-serif;color:#0c0c0b;">
    <div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;">${calculator ? "A completed BPO calculator estimate has been submitted." : "A new BPO calculator enquiry is ready for review."}</div>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;background-color:#f5f3ee;">
      <tr><td align="center" style="padding:28px 14px;">
        <table role="presentation" width="640" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:640px;background-color:#fffdfa;border:1px solid #e2e0d8;border-radius:16px;overflow:hidden;">
          <tr><td height="6" style="height:6px;background-color:#f7b719;font-size:0;line-height:0;">&nbsp;</td></tr>
          <tr><td style="padding:25px 30px 23px;background-color:#005b3a;color:#ffffff;">
            <p style="margin:0;color:#ffffff;font-size:23px;line-height:28px;font-weight:800;letter-spacing:-1.2px;">SA-BPO</p>
            <p style="margin:8px 0 0;color:#f7b719;font-size:10px;line-height:15px;font-weight:700;letter-spacing:2px;text-transform:uppercase;">Calculator enquiry</p>
          </td></tr>
          <tr><td style="padding:30px 30px 12px;">
            <p style="margin:0 0 9px;color:#007a4d;font-size:11px;line-height:16px;font-weight:700;letter-spacing:1.5px;text-transform:uppercase;">${calculator ? "Estimate ready" : "New enquiry"}</p>
            <h1 style="margin:0;color:#0c0c0b;font-size:27px;line-height:34px;font-weight:700;letter-spacing:-0.6px;">${escapeHtml(title)}</h1>
            <p style="margin:12px 0 0;color:#686963;font-size:15px;line-height:23px;">${calculator ? "The completed estimate and contact details are summarised below." : "A visitor has submitted their details through the SA-BPO calculator."}</p>
          </td></tr>
          <tr><td style="padding:20px 30px 8px;">
            <h2 style="margin:0 0 10px;color:#0c0c0b;font-size:15px;line-height:21px;font-weight:700;">Contact details</h2>
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;border:1px solid #e8e7e1;border-radius:10px;border-collapse:separate;border-spacing:0;background-color:#ffffff;">${contactRows}</table>
          </td></tr>
          ${calculator && estimate ? `<tr><td style="padding:22px 30px 8px;">
            <h2 style="margin:0 0 10px;color:#0c0c0b;font-size:15px;line-height:21px;font-weight:700;">Estimate snapshot</h2>
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;border:1px solid #d8e5dc;border-radius:10px;border-collapse:separate;border-spacing:0;background-color:#f7faf7;">${estimateRows}</table>
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;margin-top:12px;background-color:#005b3a;border-radius:10px;">
              <tr><td style="padding:16px 18px 4px;color:#ffffff;font-size:12px;line-height:18px;">Indicative monthly invoice</td></tr>
              <tr><td style="padding:0 18px 15px;color:#f7b719;font-size:27px;line-height:34px;font-weight:700;">${escapeHtml(formatCurrency(estimate.monthlyTotal, calculator.currency))}</td></tr>
            </table>
            <p style="margin:12px 0 0;padding:12px 14px;border-left:3px solid #f7b719;background-color:#f5f3ee;color:#686963;font-size:12px;line-height:19px;">Based on 9 hours per day, 45 hours per week, and ${MONTHLY_HOURS} working hours per month.${calculator.moreThanThirty ? " For teams above 30 advisors, the estimate uses the 25–30 advisor base rate; please follow up to discuss the specific requirement." : ""}</p>
          </td></tr>` : ""}
          <tr><td style="padding:24px 30px 26px;">
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;border-top:1px solid #e8e7e1;">
              <tr><td style="padding:15px 0 0;color:#686963;font-size:12px;line-height:18px;">Received ${escapeHtml(receivedLabel)}<br>Visitor consent recorded: Yes</td></tr>
            </table>
          </td></tr>
          <tr><td style="padding:17px 30px;background-color:#f0eee7;color:#686963;font-size:11px;line-height:17px;">SA-BPO &nbsp;·&nbsp; Automated calculator notification</td></tr>
        </table>
      </td></tr>
    </table>
  </body>
</html>`;

  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: SENDER,
      to: [RECIPIENT],
      ...(sendCopyToCustomer && calculator ? { cc: [lead.email] } : {}),
      reply_to: RECIPIENT,
      subject: `${calculator ? "BPO calculator estimate submitted" : "BPO calculator access request"} — ${safeCompany}`,
      text,
      html,
    }),
  });

  const apiResult = (await response.json().catch(() => null)) as ResendApiResponse | null;
  if (!response.ok || !apiResult?.id) {
    throw new Error("Email service did not accept the calculator lead");
  }
}

export type CalculatorDigestItem = {
  submissionId: string;
  lead: CalculatorLead;
  calculator?: CalculatorSelection;
  createdAt: number;
};

export async function sendCalculatorDigestEmail(
  items: CalculatorDigestItem[],
  env: CalculatorEmailEnvironment,
): Promise<void> {
  const apiKey = env.RESEND_API_KEY?.trim();
  if (!apiKey) throw new Error("Email service is not configured");
  const receivedAt = new Intl.DateTimeFormat("en-ZA", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "Africa/Johannesburg",
  });
  const text = [
    `SA-BPO browser-close calculator report — ${items.length} ${items.length === 1 ? "visitor" : "visitors"}`,
    "",
    "These consented calculator enquiries were saved before the visitor closed the browser and are being delivered in the daily fallback report.",
    "",
    ...items.flatMap((item, index) => [
      `${index + 1}. ${item.lead.firstName} ${item.lead.surname} — ${item.lead.company}`,
      `   Position: ${item.lead.position}`,
      `   Company email: ${item.lead.email}`,
      `   Telephone: ${item.lead.telephone || "Not provided"}`,
      ...(item.calculator ? [`   Service: ${serviceOptions.find((service) => service.id === item.calculator?.serviceId)?.label ?? item.calculator.serviceId}`, `   Advisors: ${item.calculator.advisorCount}`, `   Currency: ${item.calculator.currency}`] : ["   Calculator: Not completed"]),
      `   Captured: ${receivedAt.format(new Date(item.createdAt))}`,
      `   Submission ID: ${item.submissionId}`,
      "",
    ]),
  ].join("\n");
  const rows = items.map((item, index) => `<tr>
    <td style="padding:12px 10px;border-bottom:1px solid #e8e7e1;color:#686963;font-size:13px;vertical-align:top;">${index + 1}</td>
    <td style="padding:12px 10px;border-bottom:1px solid #e8e7e1;color:#0c0c0b;font-size:14px;vertical-align:top;"><strong>${escapeHtml(`${item.lead.firstName} ${item.lead.surname}`)}</strong><br>${escapeHtml(item.lead.company)}<br><span style="color:#686963;">${escapeHtml(item.lead.email)}</span></td>
    <td style="padding:12px 10px;border-bottom:1px solid #e8e7e1;color:#0c0c0b;font-size:13px;vertical-align:top;">${escapeHtml(item.calculator ? serviceOptions.find((service) => service.id === item.calculator?.serviceId)?.label ?? item.calculator.serviceId : "Calculator not completed")}<br>${item.calculator ? `${item.calculator.advisorCount} advisors · ${item.calculator.currency}` : "Lead details only"}</td>
    <td style="padding:12px 10px;border-bottom:1px solid #e8e7e1;color:#686963;font-size:12px;vertical-align:top;">${escapeHtml(receivedAt.format(new Date(item.createdAt)))}</td>
  </tr>`).join("");
  const html = `<!doctype html><html lang="en"><body style="margin:0;padding:28px;background:#f5f3ee;font-family:Arial,Helvetica,sans-serif;color:#0c0c0b;"><table role="presentation" width="100%" style="max-width:900px;margin:auto;background:#fffdfa;border:1px solid #e2e0d8;border-radius:16px;border-collapse:separate;overflow:hidden;"><tr><td style="padding:24px 28px;background:#005b3a;color:#fff;"><strong style="font-size:22px;">SA-BPO</strong><div style="margin-top:8px;color:#f7b719;font-size:11px;font-weight:700;letter-spacing:1.5px;text-transform:uppercase;">Browser-close calculator report</div></td></tr><tr><td style="padding:28px;"><h1 style="margin:0 0 10px;font-size:26px;">${items.length} ${items.length === 1 ? "visitor" : "visitors"} captured</h1><p style="margin:0 0 20px;color:#686963;line-height:1.55;">These consented calculator enquiries were saved before the visitor closed the browser.</p><table width="100%" style="border:1px solid #e8e7e1;border-collapse:collapse;"><tr style="background:#f7faf7;"><th style="padding:10px;text-align:left;font-size:12px;">#</th><th style="padding:10px;text-align:left;font-size:12px;">Contact</th><th style="padding:10px;text-align:left;font-size:12px;">Calculator</th><th style="padding:10px;text-align:left;font-size:12px;">Captured</th></tr>${rows}</table></td></tr><tr><td style="padding:16px 28px;background:#f0eee7;color:#686963;font-size:11px;">SA-BPO · Daily fallback delivery</td></tr></table></body></html>`;
  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from: SENDER, to: [RECIPIENT], reply_to: RECIPIENT, subject: `SA-BPO browser-close calculator report — ${items.length} ${items.length === 1 ? "visitor" : "visitors"}`, text, html }),
  });
  const apiResult = (await response.json().catch(() => null)) as ResendApiResponse | null;
  if (!response.ok || !apiResult?.id) throw new Error("Digest email was not accepted");
}

export async function processCalculatorIntake(
  body: unknown,
  env: CalculatorEmailEnvironment,
  clientAddress: string,
): Promise<CalculatorIntakeResult> {
  if (isRecord(body) && typeof body.website === "string" && body.website.trim()) {
    return { status: 202, body: { ok: true } };
  }

  const lead = readLead(body);
  if (!lead || !isRecord(body) || body.consent !== true) {
    return { status: 400, body: { error: "Check your details and consent, then try again." } };
  }

  const hasCalculatorSelection = Object.prototype.hasOwnProperty.call(body, "calculator");
  const calculator = hasCalculatorSelection ? readCalculatorSelection(body.calculator) : undefined;
  if (calculator === null) {
    return { status: 400, body: { error: "Check your calculator selections and try again." } };
  }
  if (
    (Object.prototype.hasOwnProperty.call(body, "sendCopyToCustomer") && typeof body.sendCopyToCustomer !== "boolean") ||
    (body.sendCopyToCustomer === true && !calculator)
  ) {
    return { status: 400, body: { error: "A customer copy is available only for a completed calculator submission." } };
  }

  if (isRateLimited(clientAddress)) {
    return { status: 429, body: { error: "Too many requests. Please wait a few minutes and try again." } };
  }

  if (!env.RESEND_API_KEY?.trim()) {
    return {
      status: 503,
      body: { error: "The secure email service is not configured yet. Please try again later or contact SA-BPO directly." },
    };
  }

  try {
    await sendLeadEmail(lead, env, calculator, body.sendCopyToCustomer === true);
    return { status: 200, body: { ok: true } };
  } catch {
    // Do not log lead data, API credentials, or provider responses.
    return { status: 502, body: { error: "We couldn't send your details just now. Please try again shortly." } };
  }
}

export { MAX_BODY_LENGTH };
