# Cloudflare calculator delivery setup

This implementation protects calculator submissions when a visitor closes the browser. The browser stores a consented submission in a short-lived local outbox and attempts `sendBeacon()` on page exit. Cloudflare Pages stores the submission in D1, uses the submission ID for duplicate protection, and sends email through a Queue consumer and Resend.

## Architecture

```text
Browser -> Pages Function /api/calculator-intake -> D1 -> Cloudflare Queue -> Worker -> Resend
```

The Pages Function accepts both ordinary JSON requests and `sendBeacon()` requests (`text/plain`). The local outbox expires after 24 hours and is deleted after a successful API response. It is used only after calculator consent is given. The consumer Worker also runs a free daily Cron fallback at 23:00 South Africa time. It groups older submissions still marked `queued` into one browser-close report email and marks them `sent` after Resend accepts the report.

## 1. Create the D1 database

Install and authenticate Wrangler if needed:

```bash
pnpm add -D wrangler
npx wrangler login
```

Create the database:

```bash
npx wrangler d1 create sa-bpo-calculator
```

Copy the returned `database_id` into `wrangler.email-consumer.toml`, replacing:

```toml
database_id = "REPLACE_WITH_D1_DATABASE_ID"
```

Apply the schema remotely:

```bash
npx wrangler d1 migrations apply sa-bpo-calculator --remote --config wrangler.email-consumer.toml
```

## 2. Create the Queue

```bash
npx wrangler queues create sa-bpo-calculator-emails
```

The queue name must be exactly:

```text
sa-bpo-calculator-emails
```

## 3. Deploy the email consumer Worker

Set the Resend API key as an encrypted Worker secret:

```bash
npx wrangler secret put RESEND_API_KEY --config wrangler.email-consumer.toml
```

Paste the Resend key when prompted. Then deploy:

```bash
npx wrangler deploy --config wrangler.email-consumer.toml
```

The Worker uses:

```text
From: SA-BPO Calculator <calculator@notifications.sa-bpo.com>
To: partnerships@sa-bpo.co.za
```

The daily fallback report is sent by the same Worker at 21:00 UTC (23:00 SAST). It covers consented submissions that reached D1 but were not processed by the Queue consumer. It waits one hour before including a row, which prevents a normal Queue delivery and the daily fallback from racing each other.

## 4. Configure Cloudflare Pages bindings

In Cloudflare Dashboard:

1. Open **Workers & Pages**.
2. Select the Pages project connected to `sergems/sabpo`.
3. Open **Settings → Functions → Bindings**.
4. Add a **D1 database binding**:
   - Variable name: `DB`
   - Database: `sa-bpo-calculator`
5. Add a **Queue producer binding**:
   - Variable name: `CALCULATOR_EMAIL_QUEUE`
   - Queue: `sa-bpo-calculator-emails`
6. Save the bindings.
7. Trigger a new Pages deployment from `main`.

The Pages project does not need the Resend API key when the Queue consumer is configured. Keep `RESEND_API_KEY` only as a secret on the email consumer Worker. The existing local Express fallback still uses `RESEND_API_KEY` for local or non-Cloudflare development.

## 5. Configure Pages build settings

In **Pages → Settings → Builds & deployments**, use:

```text
Production branch: main
Build command: pnpm install --frozen-lockfile && pnpm build:pages
Build output directory: dist/public
Node version: 20
Package manager: pnpm
```

If the project is already connected to GitHub, pushing to `main` will trigger a deployment after the bindings are saved.

## 6. Test delivery

Test in this order:

1. Open the production site.
2. Open the BPO calculator.
3. Complete the required details and give calculator consent.
4. Close the calculator normally; an email should arrive at Partnerships.
5. Repeat, then close the browser or mobile tab while valid details are present.
6. Reopen the site. The outbox retry runs on app startup and should queue the submission.
7. Repeat the same close action several times. D1 should keep one record for the same `submissionId`, not multiple records.
8. Check **Workers & Pages → D1 → Browse** and confirm the row becomes `sent`.
9. Check the Queue and Worker logs if the row remains `failed`.

A browser-close send cannot be guaranteed by browser APIs alone. The combination of durable local outbox, `sendBeacon()`, D1 persistence, Queue retries, and submission IDs is the reliable production design.

## Files added or changed

- `client/src/lib/calculator-outbox.ts` — 24-hour consent-scoped browser outbox and `sendBeacon()`.
- `client/src/components/BpoCalculatorModal.tsx` — queues submissions, uses keepalive requests, and sends on `pagehide`.
- `client/src/App.tsx` — retries the outbox on every visit.
- `functions/api/calculator-intake.ts` — Cloudflare Pages Function with D1 and Queue support.
- `migrations/0001_calculator_submissions.sql` — D1 schema and status index.
- `workers/calculator-email-consumer.ts` — Queue consumer that sends through Resend.
- `wrangler.email-consumer.toml` — Worker, D1, Queue, and daily Cron configuration.
