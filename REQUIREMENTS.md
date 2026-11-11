# Finara — Requirements Specification

A demo online-banking web application, used as the **System Under Test** for the STLC automation
pipeline. This spec is written to be consumed by the `requirement-analyst` agent: feed it alongside
the running URL — `/stlc REQUIREMENTS.md http://localhost:7080` — to produce an RTM, test plan,
cases, and an executed suite.

**Demo login:** `demo` / `demo123` (seeded with a Checking and a Savings account + history).

## Scope

A single customer can register, sign in, view accounts, move money (transfer / bill pay), open
new accounts, search transactions, update their profile, and apply for a loan. A public loan
calculator is available without signing in.

---

## Functional requirements

| ID | Requirement | Acceptance criteria |
|----|-------------|---------------------|
| FR-01 | **Public landing** | `/` shows product info and links to register, log in, and the loan calculator. Reachable without a session. |
| FR-02 | **Loan calculator (public)** | `/calculator` accepts amount, annual rate %, and term (years) and returns the monthly payment, total of payments, and total interest. Uses standard amortization: `M = P·r·(1+r)^n / ((1+r)^n − 1)`. No sign-in required. |
| FR-03 | **Registration** | `/register` creates a user from first/last name, email, username, password + confirm, and an optional opening deposit. On success a Checking account is created and the user is signed in. |
| FR-04 | **Registration validation** | Reject when required fields are blank, when password ≠ confirm, or when the username already exists; show a clear error and preserve entered values. |
| FR-05 | **Login** | `/login` authenticates username + password and starts a session (cookie). Valid demo creds land on the dashboard. |
| FR-06 | **Login validation** | Invalid credentials return an "Invalid username or password" error and HTTP 401; no session is created. |
| FR-07 | **Logout** | `/logout` ends the session and returns to the landing page; gated pages are no longer reachable. |
| FR-08 | **Accounts overview** | `/dashboard` lists the user's accounts with type and balance and shows a total-deposits figure (Loan balances excluded from the deposit total). |
| FR-09 | **Open new account** | `/accounts/open` opens a Checking or Savings account funded from an existing account; the opening deposit moves via a double-entry transfer. |
| FR-10 | **Transfer funds** | `/transfer` moves an amount between two of the user's accounts: debit the source, credit the destination, both recorded as transactions. |
| FR-11 | **Transfer validation** | Reject non-positive amounts, same source/destination, and amounts exceeding the source balance ("Insufficient funds"). |
| FR-12 | **Bill pay** | `/billpay` sends a payment to a named payee from a selected account, recorded as a Payment debit. |
| FR-13 | **Bill pay validation** | Reject a blank payee, non-positive amount, or amount exceeding the account balance. |
| FR-14 | **Find transactions** | `/transactions` lists transactions for a selected account, newest first, with date, description, type, amount, and running balance. |
| FR-15 | **Transaction search** | Filter the list by minimum and/or maximum amount; an empty result shows a "no transactions match" message. |
| FR-16 | **Update profile** | `/profile` updates first/last name, email, phone, and address; changes persist for the session. |
| FR-17 | **Request loan** | `/loan` accepts a loan amount, down payment, and deposit account. Approve when the down payment is ≥ 20% of the amount: create a Loan account and disburse the principal to the chosen account. Otherwise deny with a reason. |
| FR-18 | **Balance integrity** | Every money movement is double-entry where applicable; account balances always equal opening balance plus the sum of posted transactions. Money is stored in integer cents (no floating-point drift). |

## Non-functional requirements

| ID | Requirement | Acceptance criteria |
|----|-------------|---------------------|
| NFR-01 | **Access control** | All of `/dashboard`, `/accounts/open`, `/transfer`, `/billpay`, `/transactions`, `/profile`, `/loan` redirect to `/login` when there is no valid session. A user can only act on their own accounts. |
| NFR-02 | **Session management** | A successful login sets an `HttpOnly`, `SameSite=Lax` session cookie; logout clears it. |
| NFR-03 | **Input handling** | All user-supplied values are HTML-escaped on output (no script injection via names, payees, etc.). |
| NFR-04 | **Accessibility / testability** | Every form control has an associated `<label>`; actionable controls expose a clear accessible name; key elements carry `data-testid` hooks (e.g. `login-submit`, `transfer-amount`, `balance-<id>`, `total-balance`, `flash`). |
| NFR-05 | **Usability feedback** | Success and error outcomes are shown as a visible status message (`data-testid="flash"`). |
| NFR-06 | **Availability** | `/health` returns `200 ok` for readiness checks. |

---

## Suggested test coverage (for the pipeline)

- **Positive paths:** register → dashboard; login → transfer → balance updated; bill pay; open account; loan approved; calculator result.
- **Negative paths:** blank/duplicate registration; bad login (401); transfer over balance / same account / zero; bill pay with no payee; loan denied (< 20% down).
- **Boundary:** transfer of exactly the full balance; down payment of exactly 20%; calculator at 0% rate.
- **Non-functional:** gated routes redirect when signed out; HTML-escaping of a payee/name containing `<script>`; cookie flags on login.
