# Finara — seeded defects (answer key)

Finara is **correct by default**. Setting the `DEFECTS` env var turns on intentional, realistic
bugs so the STLC pipeline has meaningful findings. This file is the **answer key** — keep it out of
what you feed the pipeline (don't pass it to `/stlc`); use it afterward to confirm the run caught
each defect.

```bash
DEFECTS=all node server.js          # all defects on (SQLite test build)
DEFECTS=D1,D5,D6 node server.js     # just these
node server.js                      # clean — no defects (and production / Postgres is always clean)
```

When any defect is on, a **"Test build — seeded defects enabled"** banner (`data-testid="defect-banner"`) shows at the top, so a clean build is never confused with a test build.

> These live in the SQLite build and the server layer, so your **Render/PostgreSQL production stays
> correct**. Run the defect build locally as the STLC target.

| ID | Defect | Requirement | Severity | Trigger | Expected vs. actual |
|----|--------|-------------|----------|---------|---------------------|
| **D1** | Overdraft allowed — the insufficient-funds check is bypassed | FR-11, FR-18 | **High** | Transfer more than the source balance | Expected: rejected "Insufficient funds". Actual: succeeds; source balance goes **negative** (ledger integrity broken) |
| **D2** | Loan approval boundary — strict `>` instead of `>=` | FR-17 | Medium | Request a loan with a down payment **exactly 20%** of the amount (e.g. 3,000 on 15,000) | Expected: approved. Actual: **denied** |
| **D3** | Duplicate-username check is case-sensitive | FR-04 | Medium | Register username `DEMO` while `demo` exists | Expected: "username already taken". Actual: a **second account** is created |
| **D5** | Stored XSS — a transaction description is rendered unescaped | NFR-03 | **High** | Bill pay to a payee named `<script>alert(1)</script>`, then open Activity | Expected: text escaped. Actual: the markup **renders/executes** |
| **D6** | Broken access control (IDOR) — Activity doesn't verify account ownership | NFR-01 | **High** | While signed in, open `/transactions?account=<id you don't own>` | Expected: empty / no access. Actual: **another customer's transactions** are shown |
| **D7** | Transaction search ignores the Max-amount filter | FR-15 | Low | On Activity, set a small **Max amount** and search | Expected: only rows ≤ max. Actual: **all rows** still show |
| **D8** | Broken / dead links — links to pages that don't exist | NFR-04 | Medium | Crawl **/rates** (and the global footer); follow the "Seasonal offers" / "Switching guide" links | Expected: every link resolves (200). Actual: `/offers/spring-sale`, `/help/legacy-guide`, `/blog/rates-2023` return **404** |

## How the pipeline should surface these

- **UI tests (Playwright):** D2, D3, D7 are straight functional/negative/boundary cases; D1 shows as a wrong success + negative balance; D5 as a script node in the DOM.
- **Crawler / link checking:** D8 is a broken-link finding — the authenticated or public crawl follows the links on **/rates** and the footer and gets 404s. It's the natural payoff for the link-discovery widgets below.
- **Security checks:** D5 (XSS) and D6 (IDOR) are the high-severity findings — exactly the "meaningful work" a QA pipeline should flag.
- **Data validation (Postgres/SQL):** D1 is also catchable at the DB layer — the double-entry and balance-reconciliation queries (see the data-validation suite) would flag the negative balance / broken invariant.

Each maps to a requirement ID, so the STLC's RTM traces every finding back to what it violates.
