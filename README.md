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

Three importers live under `/transactions/import`. All require authentication and EDITOR+ on the household that owns the destination accounts, all accept files up to 5 MB, and all work in two steps: a **preview** that parses the file without persisting anything, and a **confirm** that persists what the user kept.

### Bank statements (OFX / CSV)

| Endpoint | Body | Notes |
|---|---|---|
| `POST /transactions/import/preview` | multipart: `accountId`, `file` (.ofx or .csv) | Returns parsed rows flagged as duplicate when an identical transaction (account, day, amount, description) already exists. |
| `POST /transactions/import/confirm` | JSON: `{ accountId, rows: [{ date, description, amount, type }] }` | Creates the rows through the regular transaction service (balances are updated); duplicates are re-checked and skipped. |

The CSV flavour expects `date;description;amount` (`,` also accepted as delimiter), dates as `dd/MM/yyyy` or `yyyy-MM-dd`, and Brazilian or plain decimal amounts. Negative amounts become expenses.

A credit card invoice (an OFX holding `CCSTMTRS`) sent to a `CREDIT` account is refused with a 400 that points to the card importer below: stored as raw rows it would duplicate the purchases the monthly sheet already put on the card.

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

### Card invoice (OFX)

A credit card invoice in OFX (`CREDITCARDMSGSRSV1/CCSTMTRS`, OFX 1.x SGML or 2.x XML, UTF-8 with a windows-1252 fallback) is reconciled with what the card already holds: the rows the monthly sheet imported, the future installments stored for later months, and the rows an earlier import created.

| Endpoint | Body | Notes |
|---|---|---|
| `POST /transactions/import/card-ofx/preview` | multipart: `file` (.ofx), `accountId` (the card), optional `options` (JSON `{ monthOverride?: { year, month } }`) | Returns the invoice month, every OFX line with its status (`reconciled`, `proposed`, `payment`) and group, the proposals, the sheet rows left without a line (`sheetOnly`), the previous invoice payment and the category map of the new purchases. Nothing is persisted. |
| `POST /transactions/import/card-ofx/confirm` | JSON: `{ accountId, monthKey, lines, selectedGroups, categoryMap, payment }` | Recomputes the reconciliation on what is stored at that moment and applies the selected groups that still exist (the others are counted as `skipped`). |

Lines and month:

- Each `STMTTRN` becomes a line: its day (`DTPOSTED`, as printed), absolute amount, kind (`purchase` when negative, `refund` when positive, `discount` for "Desconto Antecipação", `payment` for "Pagamento recebido"; purchases are `EXPENSE`, the others `INCOME`), the installment written as `Parcela N/M`, and the merchant (the memo without ` - Parcela N/M` and ` - NuPay`). The special texts are Nubank's; other banks' card statements read as plain purchases and credits.
- Each line has a stable ref `ofx:<FITID>:<first 8 hex of sha1(memo|signed amount|date)>` (identical lines are numbered in file order; long or unusual FITIDs are hashed).
- The invoice month is the due month: the statement closes on `DTEND` and is due in the same month when the card's due day comes after its closing day (the `DTEND` day when the card has none), otherwise in the next month. Without a due day the closing month is used, with a warning. `options.monthOverride` wins.
- Lines the confirm would reject are skipped with a warning instead: an amount above 1,000,000,000 (or not a finite number) and a FITID over 255 characters. At most 1,000 lines per invoice. A file without `CCSTMTRS`, an account that is not a credit card (checked after the household authorization) and a selected group whose refs are not among the lines sent are 400s.

Proposals, in the order they are made (each step only sees what the previous ones left):

1. **Already reconciled**: the line's ref is recorded (`transaction_external_refs`, or the `sourceRef` of a transaction an earlier import created), or the card has a transaction without ref with the same day, amount, type and description (what the generic importer stored; the next confirm records its ref).
2. **Plan** (`enrich-plan`): a sheet row `N/M +K` is the installments `N..N+K` of one FITID minus its discount(s), within 2 cents; then a sheet expense equal to the net of every remaining line of one FITID (two lines or more), for plans the sheet wrote without `+K`.
3. **Exact** (`enrich-exact`): same type and amount, one to one, or one cent apart when both sides carry the same installment `N/M` (installment rounding; the sheet row keeps its amount); ties go to the pair with the same `N/M`, then to the exact amount, then to more words in common. Payments other than the previous invoice's (advance payments) take part here, as credits, so they can pair with sheet credits.
4. **Sum** (`enrich-sum`): a sheet expense equal to a subset of the remaining purchases, searched among at most 15 of them (those sharing words with the row first, then in file order), smaller rows first. The subset is unique only if no other subset of the whole pool of remaining purchases makes the same total: that is counted exactly (a knapsack over the cents) while a work budget lasts, and a pool larger than the search window counts as ambiguous once it is spent. More than one subset makes the proposal `ambiguous` and unselected.
5. **Stored future installment** (`consume-future`): an installment line consumes a stored future installment (from the sheet or an earlier OFX) with the same `N/M` and an amount within one cent, preferring the plan the purchase itself generated; a prepayment's installments `N+1..N+K` consume the futures with those numbers, and its discount becomes a new credit.
6. **Reversal** (`reversal`): a purchase and a refund of the same amount and a similar merchant (same FITID or words in common); unselected.
7. **New** (`create`): the rest, one proposal per purchase (FITID). Selected by default only in months without sheet rows; in a month with sheet rows they come unselected and a warning compares what is left on each side, since the sheet often groups purchases its own way.

Group ids are `kind|sorted refs|target transaction id`; a proposal covers at most 150 lines (a purchase with more lines comes in several `create` groups), so an id stays under the 16,000 characters the confirm accepts. The client sends back the preview's lines (in the preview's order) and the groups it keeps; the server derives every line again from its FITID, date, amount and memo (kind, type, merchant, installment, ref) and rejects what does not match.

What confirm writes:

- **Enrich** (exact, plan, sum): the refs are recorded and the sheet row is rewritten in one database transaction. One-to-one: the bank's date and memo, with the sheet text appended to the notes as `Planilha: ...`. Plan or sum: the sheet description is kept, the date becomes the first line's, and the OFX lines go to the notes. Category, amount and existing notes stay.
- **Consume future**: the future installment (a placeholder an import generated) takes the line's date, memo, amount and paid flag, through the transaction service when the amount or the flag changes (the card balance moves); the ref is recorded.
- **Create**: the future installments are stored first and the line last, so a failure halfway leaves the group in place and a retry regenerates the missing numbers. One card transaction per line (`EXPENSE` for purchases, `INCOME` for refunds and discounts), `sourceRef` = the line's ref, installments with `installmentId = ofx:<FITID>`; in months without sheet rows, the remaining installments `N+1..M` are generated for the following months (`<ref>:f<i>`, never a number the plan already stores). The category comes from the client's map; merchants the map does not cover get the suggestion (the category of the merchant's latest transaction, else the sheet's label rules, else the default; a merchant never suggests creating a category).
- **Reversal**: both transactions are created (`reversalsImported` counts transactions, two per pair).
- **Payment**: the "Pagamento recebido" closest to the previous invoice (its recorded payment, else the total of its sheet rows, else the largest line) pays the previous month's invoice. When no payment is recorded, confirm records it from `payment.sourceAccountId` (required then); when the recorded one differs in amount or date, it is undone and paid again from the same account, and the card purchases the undo marked unpaid outside that invoice are marked paid again. The adjust is all or nothing: if paying again (or a later undo) fails, the payments already undone are recorded again with their own amount, date and account before the error is returned. Recorded payments from different accounts become one payment from one account, and the preview and the confirm warn about it. When that account is gone or inactive, the preview reports `recorded.sourceAccountId: null` and the adjust pays from `payment.sourceAccountId` (400 without one). The other "Pagamento recebido" lines are advance payments: they pair with sheet credits or stay as information (never imported), with a warning.
- A unique violation (another confirm got there first), a target deleted after the recompute, or a stored future deleted between the claim and its update skips the group. Re-importing the same invoice shows every line reconciled and the payment `ok`.

To undo the migration that adds `transaction_external_refs` (nothing else depends on it; imports done meanwhile will no longer recognize their lines as reconciled): run `DROP TABLE transaction_external_refs;`, delete the folder `prisma/migrations/20261003200000_add_transaction_external_refs` and, if it was applied through Prisma, `npx prisma migrate resolve --rolled-back 20261003200000_add_transaction_external_refs`.

## People and shared expenses

Splitting an expense with someone who has no Recta account: you pay 100%, a person owes you their part, and later they pay you back (or you pay them). This is **not** the household split (`isSplit` / `TransactionSplit`), which needs the other person to be a user and debits their part from their own account: nothing here moves money between accounts except the settlements below.

Everything is scoped to a household. Reading needs membership, writing needs EDITOR+, and the household is authorized before any error that depends on data (404, 409, a rejected split); only an id that does not exist at all, on a route keyed by an id alone, is a 404 before it can be authorized. Amounts are reais with two decimals, computed on integer cents. Responses are wrapped as `{ success, data }` (the ledger adds `pagination`). Routes keyed by an id alone (`/people/:id`, `/transactions/:transactionId/shares`, `/settlements/:id`) read the household from the record; an optional `?householdId=` query is authorized first and scopes the lookup, and a caller who is not in the record's household gets the same 404 as for an id that does not exist.

| Endpoint | Notes |
|---|---|
| `GET /people?householdId&includeInactive` | People with their aliases. |
| `POST /people` `{ householdId, name, aliases? }` | 201. Names and aliases are unique per household after normalization (lower case, no accents, single spaces), across people: a repeat is a **409**. At most 20 aliases of 100 characters. |
| `PATCH /people/:id` `{ name?, aliases?, isActive? }` | `aliases` replaces the list. |
| `DELETE /people/:id` | 204 for a person with no data; a person with shares or settlements is only deactivated and answered with 200 and the person. |
| `GET /people/balances?householdId` | Per person: `owedToMe`, `iOwe`, `received`, `paid`, `balance = owedToMe - iOwe - received + paid` (positive: they owe you), `openShares`. Inactive people only while their balance is not zero. |
| `GET /people/:id/ledger?householdId&limit&cursor&order` | Shares and settlements with `signed` and a running `balanceAfter`, computed over the whole history in chronological order (day, creation time, id) and then paged with a cursor. Newest first by default (`order=asc` flips the list, not the balances); `limit` 1..200, default 50. |
| `GET /transactions/:transactionId/shares` | The shares and `myPart` (amount minus what people owe me). |
| `PUT /transactions/:transactionId/shares` `{ direction, strategy, entries, myShares? }` | Replaces the shares **of that direction** (`THEY_OWE_ME` or `I_OWE_THEM`) in one database transaction; no entries removes them. Only income and expense transactions; the people must be active and of the household. |
| `POST /transactions/:transactionId/shares/preview` | Same body, computes without saving: `{ shares: [{ personId, amount }], myPart }`. |
| `GET /people/:id/settlements`, `POST /people/:id/settlements` | See below. |
| `DELETE /settlements/:id` | 204. Never deletes the transaction. |
| `POST /people/organize/preview`, `POST /people/organize/apply` | See below. |

**Split strategies** are shortcuts to type a split; what is stored is always an amount per person. `exact`: each entry has its `amount`. `percent`: each entry has its `percent` of the transaction total (two decimals; what is left stays with me, and when the percents add up to 100 the cents lost to rounding go to the first person). `shares`: each entry has its `shares` (whole cotas), mine are `myShares` (default 1). `equal`: the people listed and I split evenly. Cents left by a division go to the first person listed, so the parts and my part always add up to the transaction amount. Every part is at least 0.01, nobody is listed twice, the parts of a direction never exceed the transaction amount, and at most 50 people.

**Settlements** record money that changed hands: `RECEIVED` (they paid me) or `PAID` (I paid them), with an amount, a day and a note. Three ways: only the record; `transactionId`, linking an existing transaction (an income for `RECEIVED`, an expense for `PAID`) that no other settlement uses (409 otherwise); or `createTransaction: { accountId, description?, categoryName? }`, which creates the real transaction through the regular transaction service, so the account balance moves like for any transaction, and links it. If the settlement cannot be saved after the transaction was created, the transaction is removed again. Deleting a settlement keeps its transaction; deleting a transaction unlinks its settlement and removes its shares.

### Organize splits

For data that came from the monthly sheet importer, which keeps free-text notes on the transactions. `preview` reads the household's transactions (optionally `startDate`, `endDate`, `onlyImported` for the sheet importer's rows) and proposes; `apply` creates what the user picked. Nothing is written by `preview`.

- **Standard notes** (the importer's own vocabulary, read through `parseShareHint`) become share proposals, selected by default: `*Dividir com X` is half of the amount (an odd cent goes to X) owed to me, `*X` the whole amount owed to me, `Pagar a X` the whole amount I owe. The typo `*Divivir`, a stray `*` inside a name and the remarks the importer appends after ` · ` are handled; `*Dividir` with no name is not a person called "Dividir".
- **Review lines**: a `*Reembolsar` with no person, a split note on an income, and free text that mentions a known person (by name or alias) or the words *dividido*, *dividir*, *divivir*, *reembolso* or *pagar*, each with a `reason` and, when exactly one known person is mentioned, a `suggestedPersonId`. The assistant never guesses amounts for them: the user resolves them as `manual` lines on apply.
- **Settlement proposals**: an income whose description is a person's name or alias, or `Reembolso - Name`, proposed as a `RECEIVED` settlement linked to that income, selected by default. Names the notes introduce count as known, so an income called like a person who only exists in the notes is proposed too.
- **People** are resolved through names and aliases (one person, several nicknames). Names that exist nowhere come back in `newPeople`; the user decides in `apply.people` which to create, which to merge (`{ name: 'A', aliases: ['B'] }` creates one person answering to both) and which to attach to an existing person (`existingId`). A proposal whose person was not chosen is skipped with a warning.
- **Idempotent**: a share already stored for the same transaction, person and direction, a transaction already linked to a settlement, and a review line whose transaction already has shares are counted in `alreadyDone` and not proposed again. Proposal ids are deterministic (transaction, person as written, direction).
- **Apply recomputes everything from the database** and never trusts what the client sends for proposals: only ids are read, and an id that no longer exists (already done, note edited, transaction deleted) counts as `skipped`. `manual` lines are validated like `PUT` shares (transaction of the household, income or expense, active person, amount at most the transaction amount and the parts of a direction at most its amount, no repeated person). People, shares and settlements are written in one database transaction (shares in chunks of 1,000 rows), so a failure leaves nothing behind. Applying the same selection twice creates nothing the second time.
- Limits: 20,000 transactions read per run (a warning asks for a narrower period), 10,000 proposal ids and 2,000 manual lines per apply.

To undo the migration `20261005120000_add_people_and_shares` (the shares, settlements and people are lost): `DROP TABLE settlements, transaction_shares, person_aliases, people; DROP TYPE "SettlementDirection", "ShareDirection";`, delete the folder and, if it was applied through Prisma, `npx prisma migrate resolve --rolled-back 20261005120000_add_people_and_shares`.

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
