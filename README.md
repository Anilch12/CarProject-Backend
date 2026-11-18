# Car Details API

TypeScript, Express 5, Mongoose and Zod backend using your existing local MongoDB. The API listens only on `127.0.0.1:5000` by default.

## Local setup (PowerShell)

Use Node.js 22 or newer and your running MongoDB service. From the repository root:

```powershell
npm.cmd ci
if (-not (Test-Path .env)) { Copy-Item .env.example .env }
node -e "console.log(require('node:crypto').randomBytes(48).toString('hex'))"
```

Paste the generated value into `JWT_SECRET` in `.env`. Keep the remaining defaults:

```dotenv
MONGODB_URI=mongodb://127.0.0.1:27017/car_details
PORT=5000
APP_TIMEZONE=Asia/Kolkata
NODE_ENV=development
```

Create your own owner account using the hidden password prompt, then start:

```powershell
npm.cmd run owner:create
npm.cmd run dev
```

The owner command requires a password of at least 12 characters. It hashes passwords with Argon2id and never overwrites an existing owner. For automation it also accepts `BOOTSTRAP_EMAIL`, `BOOTSTRAP_NAME`, and `BOOTSTRAP_PASSWORD` environment variables. There are no default login credentials. Keep `.env` out of version control.

For a compiled run:

```powershell
npm.cmd run build
npm.cmd start
```

Startup creates required indexes without dropping existing indexes or documents. `npm.cmd run db:indexes` performs the same additive index step explicitly. An index conflict fails startup and requires review; it never deletes conflicting records. Run backend commands from the repository root so the local environment and OpenAPI document can be loaded. `npm start` uses the root `server.js` entry point after compilation.

Check `http://127.0.0.1:5000/health`. Login through `POST /api/v1/auth/login`; send the returned token as `Authorization: Bearer <token>` on all business endpoints. Tokens expire after eight hours. Login is rate limited. The local bootstrap command is the only account-creation mechanism. Each owner is an isolated business; multi-user business membership is outside this initial scope.

## Render backend setup

### Fix an existing service that fails with `JWT_SECRET` undefined

The build succeeds, but startup requires a private signing secret. Your local `.env` is excluded from Git and is not uploaded to Render.

1. Generate a secret on your computer:

   ```powershell
   node -e "console.log(require('node:crypto').randomBytes(48).toString('hex'))"
   ```

2. Open the existing Render service, select **Environment**, and add these environment variables:

   | Key | Value |
   | --- | --- |
   | `JWT_SECRET` | The generated value (at least 32 random characters) |
   | `MONGODB_URI` | Your hosted MongoDB connection string, including database credentials and database name |
   | `NODE_ENV` | `production` |

3. Choose **Save and deploy**. After startup, check `https://<your-service>.onrender.com/health`.

Keep the secret private and stable across deployments; changing it invalidates existing login tokens. Production startup requires an explicit `MONGODB_URI` instead of falling back to the development database. Ensure the hosted database allows connections from your Render service.

See [Render environment variables](https://render.com/docs/configure-environment-variables) for the dashboard workflow.

### New service using a Blueprint

The repository includes [render.yaml](render.yaml). Create a Render **Blueprint** from this repository to apply it. Render generates `JWT_SECRET` securely and prompts for your hosted `MONGODB_URI`. This file does not configure an existing manually created Web Service automatically; use the steps above for that service.

See [Render Blueprint secrets](https://render.com/docs/blueprint-spec#generating-random-secrets) for automatic secret generation.

### Manual service settings

Create a Node.js Web Service with these settings:

- Root Directory: repository root (leave blank)
- Build Command: `npm ci --include=dev && npm run build`
- Start Command: `npm start`
- Health Check Path: `/health`
- Environment: `NODE_ENV=production`, your hosted `MONGODB_URI`, and a private `JWT_SECRET` of at least 32 random characters.

The build includes development dependencies because TypeScript is needed for compilation. `npm start` runs `server.js`, which loads the compiled backend. The server reads Render's `PORT` environment variable and binds to `0.0.0.0` in production; local development stays on `127.0.0.1`. Let Render supply `PORT`.

Set your hosted database URI in Render's environment settings. The local `127.0.0.1` MongoDB default refers to the Render container when deployed and cannot reach the database on your computer. Keep real connection strings and signing secrets out of the repository.

See [Render web services](https://render.com/docs/web-services) for port binding and service settings. These instructions prepare the backend; the service has not been deployed.

## API and examples

[openapi.json](openapi.json) is the complete OpenAPI 3.1 contract with schemas and example payloads. Import it into Postman or an OpenAPI viewer. The authenticated API also serves it at `/api/v1/openapi.json`. [examples.http](examples.http) contains a runnable sequence for an HTTP client supporting `.http` files.

| Resource | Operations under `/api/v1` |
| --- | --- |
| Authentication | `POST /auth/login` |
| Customers | `POST/GET /customers`, `GET/PATCH /customers/:id` |
| Vehicles | `POST/GET /vehicles`, `GET/PATCH /vehicles/:id` |
| Trips | `POST/GET /trips`, `GET/PATCH /trips/:id` |
| Payments | `POST/GET /trips/:id/payments`, `POST /trips/:id/payments/:paymentId/void` |
| Reporting | `GET /dashboard/summary` |
| Imports | `POST /imports/preview`, `GET /imports/:id`, `POST /imports/:id/commit` |
| Health | `GET /health` (also available at root `/health`) |

Trip filters: `from`, `to` (calendar dates), `customerId`, `vehicleId`, `status`, `paymentStatus`. Listings support `page` (default 1) and `pageSize` (default 20, maximum 100). Trips sort by `startAt DESC, _id DESC`; customers/vehicles by `createdAt DESC, _id DESC`; payments by `createdAt DESC, _id DESC`. These are deterministic offset pages, not snapshots across concurrent edits. Trip detail contains the ledger and audit history; trip lists omit those arrays.

All request objects use allowlisted fields and reject unknown properties. IDs must be 24 hexadecimal characters. Linked customers and vehicles must belong to the authenticated owner. Registration numbers are uppercased with spaces/hyphens removed and are unique per owner. Customer names are not unique.

Errors use `{ "error": { "code": "...", "message": "...", "details": [], "requestId": "..." } }`; `details` is optional. Common statuses are 401 (authentication), 404 (missing or foreign record), 409 (financial/booking/idempotency conflict), and 422 (invalid input). Stack traces are never sent in HTTP responses.

## Financial behavior

- All amounts are safe integer paise in INR: ₹2,000 = `200000`. Trip charges may be zero; payments must be positive. A zero-charge trip is `paid`.
- An advance is one payment. Valid payments determine `collectedAmountPaise`; charge minus collections determines `balanceAmountPaise`. `paymentStatus` is derived independently from trip status. Clients cannot set these values.
- Every payment creation requires `Idempotency-Key` (8–128 letters, digits, `.`, `_`, `:`, `-`). Keys are scoped to a trip. Identical normalized payloads return the same payment ID (201 initially, 200 on replay). Different payloads return 409. Equivalent timestamp offsets normalize to the same instant. A retry after voiding returns that same ledger entry with its current `voided` status; it never restores the payment.
- Payment creation and voiding use bounded optimistic concurrency retries. Every ledger/charge/cancellation change compares the trip revision and atomically updates the fields, revision and audit together. A simultaneous charge reduction cannot bypass the collections check. Exhausted contention returns 409; retry payment creation with the same key.
- Patching a trip requires `changeReason`. Charge changes record before/after values. Cancellation preserves all payments, audit entries and outstanding charges. Payments can still be recorded on a cancelled trip to settle a retained balance.
- Voiding corrects a mistaken entry; it is not a refund. A repeated void with the same reason is idempotent; a different reason conflicts. Voided entries remain visible and are excluded from all collections, including historical dated totals. Refunds and adjustments need a future explicit model.
- Ordinary payment creation requires `paidAt`. Only reviewed import entries can use `paidAt: null`. Unknown historical methods must be explicitly `unknown`.

Expected usage is a handful to tens of payments per trip. Limits are **500 ledger entries including voids** and **2,000 audit entries** per trip, with bounded text fields. The API refuses further mutations at the history cap without truncating anything. These limits keep documents well below MongoDB's 16 MiB BSON limit. Larger ledgers require a deliberate archival/data-model migration.

## Booking safety on standalone MongoDB

See [docs/concurrency.md](docs/concurrency.md) for the exact protocol and recovery procedure. An atomic conditional update on the vehicle stores a reservation only if no other trip overlaps. Intervals are `[startAt, endAt)`, allowing consecutive bookings. Only cancelled trips release reservations; completed trips keep their historical reservation. Different vehicles can operate simultaneously.

A booking change reserves its replacement interval before updating the trip with a revision check, then releases the previous token after confirmed success. This works across multiple API processes without transactions or process-local locks. A crash or uncertain write can leave an extra reservation and block availability. Such reservations **never expire automatically**. `npm.cmd run bookings:inspect` reports them without changing data. Strict no-overlap protection is maintained by failing closed. No replica-set setup is required for this implementation.

## Reporting dates and cancellation

Accepted timestamps must include `Z` or an explicit numeric offset. MongoDB stores UTC dates. Reporting uses Asia/Kolkata; `from=2026-11-01&to=2026-11-01` means `[2026-10-31T18:30:00Z, 2026-11-01T18:30:00Z)`. `from`/`to` are inclusive calendar dates; omitted bounds are unbounded. Responses return UTC timestamps; clients should display them in Asia/Kolkata. Only this reporting timezone is currently supported.

Dashboard metrics deliberately measure different things:

| Metric | Meaning |
| --- | --- |
| `tripCount`, `tripValuePaise` | Trips whose start falls within the period, and their charges |
| `currentCollectionsPaise` | All currently valid collections against those selected trips, regardless of receipt date |
| `currentOutstandingPaise` | Current charges minus those collections |
| `paymentsReceivedInPeriodPaise` | Valid dated receipts in the period across **all** owner trips, regardless of trip date |
| `undatedCollectionsAllTripsPaise` | Valid undated receipts across **all** owner trips; never allocated to a date period |
| `cancelledTripCount` | Cancelled trips within the selected trip-start period |

Cancelled trips and their retained charges are included in all metrics. Reports are current views, not historical ledger snapshots; voiding a receipt removes it from dated collections. Dashboard calculations use one aggregation with facets. A total above JavaScript's safe integer range returns an explicit overflow error. Collections are not profit; fuel, tolls and driver expenses are outside scope.

## Two-stage Excel import

The workbook is never modified. The source workbook and its review notes are excluded from this public repository because they contain customer and trip data. Provide an authorized `.xlsx` file for review.

1. Upload `.xlsx` as multipart field `file` to `/api/v1/imports/preview`. The preview stores original bytes, SHA-256, sheet names, physical row numbers, raw cell values, proposed fields and issue codes. Manual summary rows are ignored. Reuploading identical bytes returns the same owner-scoped preview. There are no customer, vehicle, trip or payment writes during preview.
2. Create/select the actual customers and vehicles. Review every chosen row. Commit a full normalized `trip`, explicit `payments` array, `reviewed: true` and a substantive `reviewNote`. Explain corrected dates, advance interpretation, identity decisions, billing, and remaining unknowns. `paidAt: null` and `method: "unknown"` preserve historical uncertainty. An empty array explicitly means no actual payments are being imported.
3. Commit only selected rows to `/imports/:id/commit`. Unselected or conflicting rows remain pending. Each row creates its trip, payments, audit and import source mapping in one document write. A unique owner/import/sheet/row index plus stable trip IDs prevents duplicates. An identical retry returns the existing trip. A changed resolution after commit conflicts; use the audited trip API to edit committed data.

Commits are atomic **per row**, not per uploaded batch. A 200 response may contain pending row-level errors; inspect every result. Invalid request structure is rejected before any row writes. A server/network interruption can occur after earlier rows succeeded, so retry the same payload. Mapping is read from committed trip source fields; no second mapping write can be lost. A changed workbook has a new fingerprint and requires duplicate review; duplicate suggestions are not automatic identity merges.

Excel calendar values have no timezone. Preview candidates interpret them as Asia/Kolkata and flag `CONFIRM_TIMEZONE`; review is mandatory. Raw values and original bytes remain available for traceability. Numeric floating-point date artifacts are rounded to the nearest second **only in proposed candidates**; raw dates are untouched. Uploads are limited to 2 MiB, 20 MiB expanded ZIP content, 1,000 archive entries, 500 trip rows and 4 MiB decoded preview; imports persist no more than 50 approved rows per commit request.

## Tests and synthetic data

```powershell
npm.cmd run typecheck
npm.cmd run docs:generate
npm.cmd run build
npm.cmd test
npm.cmd run test:smoke
npm.cmd audit
```

Tests use the actual local MongoDB server, not mocks. They ignore `MONGODB_URI`, require a local `TEST_MONGODB_URI` with a `car_details_test` name, create a fresh random-suffix test database, verify it is empty, and remove only that newly created test database afterward. They never use `car_details`. They cover races, idempotency, voids, dates, booking edits, fail-closed reservations, ownership, imports, reporting boundaries and the OpenAPI contract.

Verified locally: **22/22 integration tests passed**, TypeScript type checking and compilation passed, OpenAPI validation passed, and the compiled-server smoke test passed. The smoke test uses loopback port 5099 and its own fresh test database. `npm audit` reported **0 vulnerabilities**. The normal application database was not populated and no owner credentials were created there.

For a separate demonstration dataset:

```powershell
$env:SEED_PASSWORD = '<choose a new password of at least 12 characters>'
npm.cmd run seed:dev
Remove-Item Env:SEED_PASSWORD
```

This writes only to `car_details_dev`, refuses a different database name, and refuses to overwrite an existing synthetic owner. To run against it, set `MONGODB_URI=mongodb://127.0.0.1:27017/car_details_dev`. The login email is `synthetic@example.test`; the password is the value you supplied. The seed does not read or import your workbook.

## Source layout

`models/index.ts` defines schemas and indexes; `controllers/index.ts` contains HTTP handlers; `routes/index.ts` maps API routes and middleware; `trips.ts` owns financial mutations and booking reservations; `imports.ts` handles review and commit; `reporting.ts` contains dashboard aggregation; `validation.ts` defines inputs; `auth.ts` handles login/tokens; `src/app.ts` configures Express and error handling. CLI scripts are in `scripts/`, integration tests in `tests/`. No deployment or production database changes are part of this implementation.
