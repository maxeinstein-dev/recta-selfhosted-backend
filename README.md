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

A monthly budget sheet (one tab per month) can be imported from the CSV export of one tab, or from the whole workbook (.xlsx) at once. The expected layout of a month tab is: a title cell containing `Mês de <mês> de <ano>`, a header row whose second column is `Descrição`, and four blocks of rows:

1. **income** rows (values in `Entrada - Previsto` / `Recebido`), with no `Total` row;
2. **bills** rows (values in `Saída - Previsto` / `Realizado`) ending in a `Total` row;
3. **credit card** rows ending in a `Total` row — descriptions may carry installments as `N/M`, and `N/M +K` means `K` further installments were prepaid in this invoice (the row amount is the net total);
4. **debit/pix** rows ending in a `Total` row.

Everything after the third `Total` (grand totals, account balances) is ignored. Free text in the last column is kept as the transaction notes.

| Endpoint | Body | Notes |
|---|---|---|
| `POST /transactions/import/maxfin/preview` | multipart: `file` (.csv), `accounts` (JSON `{ income, bills, credit, debit }` account ids), optional `options` (JSON) | Returns every row with its status (`new`, `duplicate`, `changed`, `replaces-future`, `legacy-duplicate`), per-block sums against the sheet totals, a category map with suggestions, warnings and the invoice payment that confirm would record. |
| `POST /transactions/import/maxfin/workbook/preview` | multipart: `file` (.xlsx), `accounts` (JSON, as above), optional `options` (JSON `{ months, closedThrough, payInvoice, generateFutureInstallments }`) | Reads every tab. Returns `sheets` (each `selected`, `available` or `skipped` with a `reason`, plus `hidden`), one full monthly preview per selected month in `months` (oldest first, each the same the CSV preview gives, with its own options), and one `categoryMap` merged across them. |
| `POST /transactions/import/maxfin/confirm` | JSON: `{ month, accounts, options, categoryMap, rows }` | Creates the requested custom categories, the transactions, the remaining installments and the invoice payment. One month per call, whichever preview it came from. |

Rules applied:

- The sheet month comes from, in order: `options.monthOverride`; the tab name, when the file is named like Google's download of one tab (`<workbook> - <tab>.csv`) and the tab name holds a month (`OUT`, `Março 2026`); the title (`Mês de <mês> de <ano>`); the file name. A title that names another month (a tab copied from the previous one) loses to the tab name and the preview warns (`monthSource: 'sheet'`): such a CSV now lands on the tab's month, so its `sourceRef`s are those of that month, not of the month in the title. The year of a month taken from the tab name: a 4-digit year in the tab name; otherwise, when the title names the same month, the title's year; when the title names another month, the 4-digit year of the file name (for a `<workbook> - <tab>.csv` download, its workbook part), else the title's year, plus one when the tab month is earlier than the title month (a copy is made after its source); without a title month, the file name's year. In a file named for its year (`..._2026.xlsx`) this keeps a forward copy (`NOV` made from `OUT`) and a backward copy (`SET` made from `OUT`) in that year; a `JAN` copied from `DEZ` lands in the file's year too, where it is skipped as a repeated month if that year's `JAN` exists. The warning says which year was used and why.
- Every row is dated day 1 of the sheet month. Income uses `Recebido` when present, otherwise `Previsto`; expenses use `Realizado`, otherwise `Previsto`. A row is paid when the realized value is present; credit card rows are always paid (Recta's convention for CREDIT accounts).
- A negative value (a refund, a reversal) is imported with its absolute amount and the opposite type, in the same block and therefore on the same account: a credit (`INCOME`) in the bills, card and debit/pix blocks, a debit (`EXPENSE`) in the income block. Its notes say so (`valor negativo na planilha: lançado como crédito`). Zero values are still skipped. Block sums are net (credits count against their block), like the sheet `Total` they are compared with.
- `options.closedMonth` (default: the sheet month is before the current month) marks every row as paid and enables `options.payInvoice`, which records the credit card invoice payment from the bills account on the card's due day, for the net amount imported in that call (card purchases minus card credits), at most once per card and month. When that net is zero or less no payment is recorded and a warning says so.
- `options.generateFutureInstallments` (default: open month only) creates the remaining installments `N+1..M` of each credit row in the following months, sharing one `installmentId`; a card credit paid back in installments generates `INCOME` installments.
- Each imported row stores a `sourceRef` (`maxfin:<yyyy-MM>:<block>:<line>`), unique per household (the column is nullable, so manual transactions are unaffected). Re-importing the same sheet imports nothing, and a repeated or concurrent confirm cannot store a row twice. A row whose amount, paid flag or type changed is reported as `changed` (a value whose sign flipped changes the type: `tipo despesa → crédito`) and only replaced when the client sends `replace: true`. The legacy-duplicate match compares the type too.
- Installments generated for later months carry a `sourceRef` ending in `:f<N>`. When a later sheet carries the same plan (same description and total), its row is reported as `replaces-future` and, with `replace: true`, supersedes the generated installments it covers (`N..N+K`). Generation never repeats an installment number that is already stored, and `replace` never deletes anything else.
- Confirm re-validates what the preview derived and rejects inconsistent requests before any write: `sourceRef` outside the sheet month, not matching the row's block or repeated, `date` outside the month, installment shape (at most 99 installments; `futureCount` is recomputed server-side). Any block may hold both types (negative values flip them).
- A second confirm for the same closed month does not record a second invoice payment. The preview says so up front: `invoice.alreadyPaid` is true when the payment of that card and month already exists, and `invoice.willPay` is then false.
- The preview counts `replaces-future` rows as new (they import), but confirm skips them with a warning unless the client sends `replace: true` for them. Replacing is a delete followed by a create, not one database transaction: if confirm fails midway, run the preview again, rows already imported show up as duplicates and the missing ones as new.
- The category map lets the client point each sheet category name to a system category, an existing custom category, a new custom category, or the default (`OTHER_INCOME` / `OTHER_EXPENSES`).

#### Workbook (.xlsx)

- Each tab is read so that the parser gets what it gets from Google Sheets' CSV export of that tab: cached values (a formula through its last result), numbers of the money columns D..I as `1300,00` (the export shows `R$ 1.300,00`; both parse to the same amount), merged cells only in their top-left cell, and rows on their own line numbers, so a month gets the same `sourceRef`s from the workbook as from the CSV of its tab and importing it from either source is idempotent. This holds for the text and money cells the parser reads; elsewhere the reader writes plain numbers (`3883,14`), dates as `dd/mm/yyyy`, booleans as `TRUE`/`FALSE` and errors as empty cells, where the export shows formatted text (`R$ 3.883,14`) and `#N/A` (in the user's workbook those differences only appear in cells the parser ignores: the footer after the third `Total`).
- The month of a tab comes from its name (`OUT`, `Março`), else from its title, and its year follows the rule above, with the 4-digit year of the uploaded file name as the file name's year and, last, the single year the titled tabs share. The file name never gives a month.
- A tab is skipped, with the reason, when it has no `Descrição` header, no month, no rows, or a month an earlier tab already holds. Hidden tabs are read like the others (`hidden: true`).
- `options.months` picks the months (each must be a month tab of the workbook); by default every month tab up to the current month is selected and later ones stay `available`. `closedThrough` (`YYYY-MM`, default the previous month, `null` for none) closes every selected month up to it; `payInvoice` (default `true`) applies to every closed month; `generateFutureInstallments` (default `true`) applies only to the latest selected month, and only when it is open.
- Nothing is persisted: the client confirms month by month with `POST /transactions/import/maxfin/confirm`, oldest first, echoing each month's own options.
- Limits: 5 MB per upload, 50 MB uncompressed (both the sizes the archive declares and the bytes actually inflated), at most 10,000 zip entries and 60 tabs, and 2,000 rows and 40 columns read per tab (a tab with values beyond them is read up to there, with a warning). A cell holds at most 50,000 characters (Google Sheets' limit) and the cells read from one workbook at most 5,000,000; the selected months of one preview hold at most 6,000 rows (select fewer months above that). Every part is read once, forward, and anything damaged or over a limit answers 400.

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
