# Finara — a testable financial web app

A fully functional demo **online-banking** application, built as a **System Under Test** for the
[STLC automation pipeline](https://github.com/Masakela/stlc-automation). Modeled on the proven
testable-banking flow set (register, login, accounts overview, open account, transfer, bill pay,
find transactions, update profile, request loan) — the same shape as Parasoft's ParaBank — but
rebuilt with modern, semantic, test-friendly HTML.

**Zero dependencies.** It's a single Node file using only the standard library.

## Run it

```bash
cd finara
node server.js
# → Finara running at http://localhost:7080  (demo login: demo / demo123)
```

Open <http://localhost:7080>. Sign in with **`demo` / `demo123`** (seeded with a Checking and a
Savings account and some history), or register a new account.

> Port is `7080` by default (avoids the usual 8080 clashes). Override with `PORT=3000 node server.js`.

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
| Company / legal | `/about` `/careers` `/contact` `/faq` `/locations` `/security` `/privacy` `/terms` `/accessibility` | Public pages linked from the global footer |
| Health | `/health` | `200 ok` |

Money is stored in **integer cents**; transfers are **double-entry**; it's correct by design (no
seeded defects). Every form control has a `<label>`, and key elements carry `data-testid` hooks.

## Test it with STLC

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

## Hosting / deploy

The app binds to `process.env.PORT` and `0.0.0.0`, so it runs on any Node host as-is. Deploy files
are included:

- **Render** (free, Git-based): push this folder to a GitHub repo, then on render.com → **New →
  Blueprint** and select the repo. `render.yaml` provisions a free web service (`node server.js`,
  health check `/health`) and gives you a public `https://<name>.onrender.com` URL.
- **Railway / Heroku-style**: the `Procfile` (`web: node server.js`) is all they need.
- **Docker** (any container host): `docker build -t finara . && docker run -p 7080:7080 finara`.

Data is in-memory and resets on restart — ideal for a demo. Once it's live, point the STLC run and
your resume at the public URL.

---

*Demo application for QA automation. Not a real bank; no real money or PII.*
