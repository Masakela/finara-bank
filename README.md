# Finara — a testable financial web app

A fully functional demo **online-banking** application, built as a **System Under Test** for the
[STLC automation pipeline](https://github.com/Masakela/stlc-automation). Modeled on the proven
testable-banking flow set (register, login, accounts overview, open account, transfer, bill pay,
find transactions, update profile, request loan) — the same shape as Parasoft's ParaBank — but
rebuilt with modern, semantic, test-friendly HTML.

Backed by a **relational database** behind a pluggable storage layer: **SQLite** for zero-setup
local dev (Node 22's built-in `node:sqlite`) and **PostgreSQL** for production. The same repository
interface drives both, so behavior is identical.

## Run it

```bash
cd finara
node server.js            # SQLite backend (default), in-memory, seeded with the demo data
# → Finara running at http://localhost:7080  (sqlite backend · demo login: demo / demo123)
```

Open <http://localhost:7080>. Sign in with **`demo` / `demo123`** (seeded with a Checking and a
Savings account and some history), or register a new account.

> Port is `7080` by default. Override with `PORT=3000 node server.js`.
> SQLite persists to a file with `SQLITE_FILE=finara.sqlite node server.js` (default is in-memory).

## Database

The storage layer (`store.js` → `backends/`) picks a backend automatically:

- **SQLite** (default locally) — Node 22 built-in, no external packages. Schema + demo seed are
  created on first run. Great for local dev and the STLC test runs.
- **PostgreSQL** (production) — via `pg`. Selected automatically when `DATABASE_URL` is set (or
  `DB_BACKEND=postgres`). The schema + demo seed are created on first boot, so a fresh database
  just works — no manual migration step.

```bash
node server.js                               # SQLite (default)
DB_BACKEND=postgres DATABASE_URL=postgres://… node server.js   # PostgreSQL
```

Schema (`schema.sql`, for reference): 10 tables — customers, sessions, account_types, accounts,
transactions (double-entry ledger), transfers, payees, bill_payments, loans, contact_messages.
Money is stored in integer cents; every transfer is two postings that net to zero.

## What's in it

| Area | Route | Notes |
|------|-------|-------|
| Landing | `/` | Public marketing + links |
| Loan calculator | `/calculator` | Public; amortization math |
| Services | `/services` | Public info |
| Register | `/register` | Creates user + Checking account |
| Login / Logout | `/login`, `/logout` | Cookie session |
| **Accounts overview** | `/dashboard` | Balances + total (gated) |
| **Open new account** | `/accounts/open` | Funded from an existing account (gated) |
| **Transfer funds** | `/transfer` | Double-entry (gated) |
| **Bill pay** | `/billpay` | Payment to a payee (gated) |
| **Find transactions** | `/transactions` | List + amount filter (gated) |
| **Update profile** | `/profile` | Contact info (gated) |
| **Request loan** | `/loan` | 20%-down approval rule (gated) |
| **Statements & documents** | `/documents` | Upload documents + download statements (gated) |
| Document download | `/documents/download?id=` | Serves an uploaded file (owner-scoped) |
| Statement export | `/documents/statement.csv?account=` | CSV of an account's transactions (gated) |
| Company / legal | `/about` `/careers` `/contact` `/faq` `/locations` `/security` `/privacy` `/terms` `/accessibility` | Public pages linked from the global footer |
| Health | `/health` | `200 ok` |

**Input validation (negative & boundary cases).** Money fields (transfer, bill pay, opening
deposit, loan amount/down, and the calculator) are validated **server-side**: non-numeric input
(letters/symbols), negatives, zero where a positive is required, and more than two decimal places
are each rejected with a specific message. Login rejects empty fields ("Username and password are
required.") separately from bad credentials ("Invalid username or password."). These are correct
behaviors — they exist to give the pipeline real **negative and boundary** test cases to assert on,
distinct from the seeded defects below.

Validation is comprehensive: **no component accepts or ignores bad input silently.** The **Activity
filter** rejects non-numeric, negative, or min>max ranges with a `data-testid="filter-error"` message
instead of a confusingly empty list; **Profile** requires a first/last name and a well-formed email;
**Register** and **Contact** validate email format; **Bill pay** requires a payee name and a
digits-only account number (4-20 digits). Every rejection is a specific, assertable message.

**Interactive widgets (to exercise the crawler).** The public **Rates & offers** page (`/rates`,
also in the top nav and footer) and the landing page add UI that a crawler has to deal with beyond
plain links:

- **Dropdown menu** — a "Products ▾" nav menu (`data-testid="menu-products"`) that opens on click.
- **Modal popup** — a welcome-offer dialog on the landing page (`data-testid="promo-modal"`,
  `role="dialog"`), plus a site-wide **cookie-consent banner** (`data-testid="cookie-banner"`).
- **Predictive-text dropdown** — a typeahead search (`data-testid="typeahead-input"`) that renders a
  filtered `role="listbox"` of suggestions (`data-testid="ta-option"`) as you type.
- **Cards** — a product card grid (`data-testid="product-cards"`), each card its own `data-testid`.
- **Sortable table** — a rates table (`data-testid="rates-table"`) whose headers sort on click and
  expose `aria-sort`.
- **Dead links** — always present: benign non-navigating links (`href="#"` and an anchor with no
  `href`, `data-testid="deadlink-placeholder"` / `deadlink-nohref`) so a crawler is tested for
  *robustness* (it must not crash or loop). The genuinely broken 404 links are the **D8** seeded
  defect (off by default) so a crawl of the clean build stays green; `DEFECTS=D8` turns them on as a
  real broken-link finding.

**File upload & download.** The gated **Statements & documents** page (`/documents`) adds a real
`multipart/form-data` **file upload** (`data-testid="file-input"`) validated server-side — required,
allowed type (PDF/PNG/JPG), non-empty, and ≤ 5 MB each give specific rejection messages (more
negative/boundary cases). Uploaded files are re-downloadable (`/documents/download?id=`, scoped to
the owner), and each account's history exports as a **CSV download** (`/documents/statement.csv`,
`Content-Disposition: attachment`). Uploads are held in memory and reset on restart.

Money is stored in **integer cents**; transfers are **double-entry**; it's correct by design (no
seeded defects). Every form control has a `<label>`, and elements carry test hooks across the
locator tiers: `data-testid` on key controls, plus `data-qa` / `data-field` on form fields and a few
icon-only controls (notifications/messages) that have **only** a `data-qa` — so a crawl exercises the
`data-*` tier and the generated POM shows `locator('[data-qa="…"]')` alongside `getByRole`/`getByTestId`.

## Test it with STLC

The app is **correct by default**. To give the pipeline real findings, run the **seeded-defect test
build** — `DEFECTS=all node server.js` turns on six intentional, requirement-mapped bugs (overdraft,
a loan boundary error, a case-sensitive duplicate check, stored XSS, an IDOR, and a broken search
filter). A banner marks the test build, and your Postgres production stays clean. The answer key is
**DEFECTS.md** (don't feed it to the pipeline).

The gated pages redirect to `/login` when signed out, which is exactly what the pipeline's
**authenticated crawl** is for. Point `/stlc` at the running app (optionally with the requirements
spec for a richer RTM):

```
/stlc REQUIREMENTS.md http://localhost:7080
```

### Authenticated crawl (reach the gated pages)

1. Log in once with Playwright MCP (or any Playwright login) using `demo` / `demo123` and export a
   `storageState` as `auth.json`.
2. Extend the map over the gated routes:

   ```bash
   node scripts/analyze-site.js http://localhost:7080/dashboard \
     --storage-state auth.json \
     --seed http://localhost:7080/transfer --seed http://localhost:7080/billpay \
     --seed http://localhost:7080/transactions --seed http://localhost:7080/profile \
     --seed http://localhost:7080/loan --seed http://localhost:7080/accounts/open \
     --merge qa-artifacts/<run>/site-map.json --out qa-artifacts/<run>/site-map.json
   ```

   Unauthenticated the crawl sees **5 public pages**; authenticated it reaches **15 pages / ~160
   locators**. Because the map is then `authenticated: true`, `generate-pom.js` wires the session
   into the generated config so the gated-page tests run signed in.

## Hosting — database + site on Render

The included `render.yaml` blueprint provisions **both** on Render in one step:

1. Push this folder to a GitHub repo.
2. render.com → **New → Blueprint** → pick the repo → **Apply**.

Render creates a free **PostgreSQL** instance, injects its connection string into the web service as
`DATABASE_URL`, and deploys the app (`npm install` → `node server.js`, health check `/health`). On
first boot the app creates the schema and demo seed, so the database is ready with no manual
migration. You get a public `https://<name>.onrender.com` URL backed by a real, **persistent**
Postgres database.

- **Railway / Heroku-style**: set `DATABASE_URL` + `DB_BACKEND=postgres`; the `Procfile` runs it.
- **Docker**: `docker build -t finara . && docker run -p 7080:7080 -e DATABASE_URL=… finara`.

Once it's live, point the STLC run and your resume at the public URL.

---

*Demo application for QA automation. Not a real bank; no real money or PII.*
