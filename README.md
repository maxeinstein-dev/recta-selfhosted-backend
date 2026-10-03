# Recta Backend

Backend for Recta — personal finance app with household collaboration. **Open source & self-hostable.**

## About this project

Recta is an open source personal finance manager. This repository is the public backend: **anyone can self-host it**, fork it, submit pull requests, or build on top of it. Submitting PRs or contributing does **not** guarantee that any feature or change will be incorporated into the hosted product at [recta.app](https://recta.app). The maintainers decide what is merged and what is shipped on recta.app.

This project is maintained by [PrimoDev](https://www.oprimo.dev).

**Other part of the project:** [recta-selfhosted-frontend](https://github.com/oprimodev/recta-selfhosted-frontend) — web app (React/Vite).

## Tech stack

- **Node.js** 20+
- **Fastify** – REST API
- **PostgreSQL** – database
- **Prisma** – ORM
- **Firebase Admin** – auth (Google, Apple, email)
- **Zod** – validation

## Hosting (self-hosted)

You can run this backend on any Node.js host. Some options:

- **[Railway](https://railway.app)** – simple deploy, PostgreSQL add-on, cron support
- **[Render](https://render.com)** – free tier, PostgreSQL, background workers
- **[Fly.io](https://fly.io)** – global regions, PostgreSQL via Supabase or external
- **[DigitalOcean App Platform](https://www.digitalocean.com/products/app-platform)** – managed app + DB
- **VPS** (Hetzner, Linode, etc.) – run `npm run start` behind Nginx and use a managed PostgreSQL (e.g. Supabase, Neon, or self-hosted)

Set `DATABASE_URL`, pick an [auth mode](#auth-mode) and, in production, `ALLOWED_ORIGINS` and optionally `SWAGGER_USERNAME`/`SWAGGER_PASSWORD`. For recurring transactions, schedule `npm run cron:process-recurrences` once per day (cron job or Railway cron).

You don't need Firebase to run a working instance — `local` auth mode plus PostgreSQL is enough.

## How to run

### Prerequisites

- Node.js 20+
- PostgreSQL 16+
- Firebase project with Authentication enabled

### 1. Install dependencies

```bash
npm install
```

### 2. Environment variables

```bash
cp env.example .env
```

Edit `.env`:

| Variable | Required | Description |
|----------|----------|-------------|
| `DATABASE_URL` | Yes | PostgreSQL URL, e.g. `postgresql://user:password@localhost:5432/recta` |
| `AUTH_MODE` | Yes | `local` (no Firebase) or `firebase` (default). See below. |

#### Auth mode

Choose how users sign in via `AUTH_MODE`:

- **`local`** (recommended for self-host) — no third-party auth. The backend issues and verifies its
  own JWTs for email/password login. Requires `AUTH_JWT_SECRET` (min 32 chars; generate with
  `openssl rand -base64 48`). Optional: `AUTH_TOKEN_TTL_HOURS` (default 720 = 30 days),
  `AUTH_REQUIRE_EMAIL_VERIFICATION` (default `false`). No Firebase setup needed.
- **`firebase`** (default) — Google/Apple/Email sign-in via Firebase. Provide credentials with one of
  the two options below. Optionally set the public `AUTH_FIREBASE_WEB_API_KEY` so `GET /auth/config`
  hands the client your web config.

Clients call `GET /auth/config` (public) to discover the mode before showing a login screen.
In `local` mode, clients use `POST /auth/register` and `POST /auth/login` (both public, return
a JWT for the `Authorization: Bearer` header). `GET /auth/me` and `POST /auth/sync` work in
both modes.

**Firebase – option A (file):**

- Create a [service account](https://console.firebase.google.com/project/_/settings/serviceaccounts/adminsdk) and download the JSON.
- Save it in the project (e.g. `firebase-service-account.json`) and **do not commit** it.
- In `.env`: `GOOGLE_APPLICATION_CREDENTIALS=./firebase-service-account.json`

**Firebase – option B (env vars):**

- In `.env` set: `FIREBASE_PROJECT_ID`, `FIREBASE_CLIENT_EMAIL`, `FIREBASE_PRIVATE_KEY` (private key with `\n` for newlines).

Other optional vars: `PORT` (default 3000), `REDIS_URL`, `SWAGGER_USERNAME`/`SWAGGER_PASSWORD`, `ALLOWED_ORIGINS`, `FIRST_RUN`. See `env.example`.

> In production use `npm run db:deploy` (not `db:migrate`) to apply migrations, or set `FIRST_RUN=true` on the first boot to run them automatically, then remove it.

### 3. Run migrations

```bash
npm run db:migrate
```

### 4. Start the server

**Development:**

```bash
npm run dev
```

**Production:**

```bash
npm run build
npm run start
```

API at `http://localhost:3000`. Swagger docs (when enabled): `http://localhost:3000/docs`.

### 5. Verify

```bash
curl http://localhost:3000/health
```

Returns `{ status, timestamp, uptime, apiVersion, minClientVersion }`. `apiVersion` is the self-host
contract: clients compare it against the official contract to detect a backend that has fallen behind.
If your instance reports an older `apiVersion` than the app expects, pull the latest code and redeploy
so the schema and endpoints stay in sync.

## Scripts

| Command | Description |
|---------|-------------|
| `npm run dev` | Dev server with hot reload |
| `npm run build` | Production build |
| `npm run start` | Run production build |
| `npm run db:migrate` | Run migrations (dev) |
| `npm run db:deploy` | Run migrations (production) |
| `npm run db:studio` | Open Prisma Studio |
| `npm run db:generate` | Generate Prisma Client |
| `npm run lint` | Lint |
| `npm run typecheck` | Type check |

## Recurring transactions (cron)

To process recurring transactions daily, run as a cron job:

```bash
npm run build
npm run cron:process-recurrences
```

Schedule this once per day (cron, systemd, or your host’s scheduler).

## Importing transactions

Two importers live under `/transactions/import`. Both require authentication and EDITOR+ on the household that owns the destination accounts, both accept files up to 5 MB, and both work in two steps: a **preview** that parses the file without persisting anything, and a **confirm** that persists the rows the user kept.

### Bank statements (OFX / CSV)

| Endpoint | Body | Notes |
|---|---|---|
| `POST /transactions/import/preview` | multipart: `accountId`, `file` (.ofx or .csv) | Returns parsed rows flagged as duplicate when an identical transaction (account, day, amount, description) already exists. |
| `POST /transactions/import/confirm` | JSON: `{ accountId, rows: [{ date, description, amount, type }] }` | Creates the rows through the regular transaction service (balances are updated); duplicates are re-checked and skipped. |

The CSV flavour expects `date;description;amount` (`,` also accepted as delimiter), dates as `dd/MM/yyyy` or `yyyy-MM-dd`, and Brazilian or plain decimal amounts. Negative amounts become expenses.

### Monthly sheet ("MaxFin" format)

A monthly budget sheet exported as CSV (one tab per month) can be imported in one go. The expected layout is: a title cell containing `Mês de <mês> de <ano>`, a header row whose second column is `Descrição`, and four blocks of rows:

1. **income** rows (values in `Entrada - Previsto` / `Recebido`), with no `Total` row;
2. **bills** rows (values in `Saída - Previsto` / `Realizado`) ending in a `Total` row;
3. **credit card** rows ending in a `Total` row — descriptions may carry installments as `N/M`, and `N/M +K` means `K` further installments were prepaid in this invoice (the row amount is the net total);
4. **debit/pix** rows ending in a `Total` row.

Everything after the third `Total` (grand totals, account balances) is ignored. Free text in the last column is kept as the transaction notes.

| Endpoint | Body | Notes |
|---|---|---|
| `POST /transactions/import/maxfin/preview` | multipart: `file` (.csv), `accounts` (JSON `{ income, bills, credit, debit }` account ids), optional `options` (JSON) | Returns every row with its status (`new`, `duplicate`, `changed`, `replaces-future`, `legacy-duplicate`), per-block sums against the sheet totals, a category map with suggestions, warnings and the invoice payment that confirm would record. |
| `POST /transactions/import/maxfin/confirm` | JSON: `{ month, accounts, options, categoryMap, rows }` | Creates the requested custom categories, the transactions, the remaining installments and the invoice payment. |

Rules applied:

- Every row is dated day 1 of the sheet month. Income uses `Recebido` when present, otherwise `Previsto`; expenses use `Realizado`, otherwise `Previsto`. A row is paid when the realized value is present; credit card rows are always paid (Recta's convention for CREDIT accounts).
- `options.closedMonth` (default: the sheet month is before the current month) marks every row as paid and enables `options.payInvoice`, which records the credit card invoice payment from the bills account on the card's due day, for the exact amount imported in that call, at most once per card and month.
- `options.generateFutureInstallments` (default: open month only) creates the remaining installments `N+1..M` of each credit row in the following months, sharing one `installmentId`.
- Each imported row stores a `sourceRef` (`maxfin:<yyyy-MM>:<block>:<line>`), unique per household (the column is nullable, so manual transactions are unaffected). Re-importing the same sheet imports nothing, and a repeated or concurrent confirm cannot store a row twice. A row whose amount or paid flag changed is reported as `changed` and only replaced when the client sends `replace: true`.
- Installments generated for later months carry a `sourceRef` ending in `:f<N>`. When a later sheet carries the same plan (same description and total), its row is reported as `replaces-future` and, with `replace: true`, supersedes the generated installments it covers (`N..N+K`). Generation never repeats an installment number that is already stored, and `replace` never deletes anything else.
- Confirm re-validates what the preview derived and rejects inconsistent requests before any write: `sourceRef` outside the sheet month or repeated, `type` not matching the block, `date` outside the month, installment shape (at most 99 installments; `futureCount` is recomputed server-side).
- A second confirm for the same closed month does not record a second invoice payment. The preview says so up front: `invoice.alreadyPaid` is true when the payment of that card and month already exists, and `invoice.willPay` is then false.
- The preview counts `replaces-future` rows as new (they import), but confirm skips them with a warning unless the client sends `replace: true` for them. Replacing is a delete followed by a create, not one database transaction: if confirm fails midway, run the preview again, rows already imported show up as duplicates and the missing ones as new.
- The category map lets the client point each sheet category name to a system category, an existing custom category, a new custom category, or the default (`OTHER_INCOME` / `OTHER_EXPENSES`).

## Project structure

```
src/
├── app.ts              # Fastify app
├── index.ts            # Entry point
├── modules/            # API modules (auth, users, households, accounts, transactions, etc.)
├── shared/
│   ├── config/         # env, Firebase
│   ├── db/             # Prisma & migrations
│   ├── middleware/     # Auth & authorization
│   └── utils/
└── jobs/               # Cron (e.g. processRecurrences)
```

## License

MIT
