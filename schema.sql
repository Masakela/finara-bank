-- ============================================================================
-- Finara — relational schema (PostgreSQL)
-- Money is stored in integer CENTS (BIGINT) — never floating point.
-- The transaction ledger is the source of truth; accounts.balance_cents is a
-- cached balance kept in step inside the same DB transaction as its postings.
--
-- SQLite port: replace BIGSERIAL -> INTEGER PRIMARY KEY AUTOINCREMENT,
-- TIMESTAMPTZ -> TEXT (store ISO-8601), BOOLEAN -> INTEGER(0/1), drop now()
-- defaults (set them in code). FOREIGN KEY / CHECK syntax is identical.
-- ============================================================================

-- Reference / lookup table: the kinds of account Finara offers --------------
CREATE TABLE account_types (
  code      TEXT    PRIMARY KEY,               -- 'CHK', 'SAV', 'LOAN'
  name      TEXT    NOT NULL,                  -- 'Checking', 'Savings', 'Loan'
  apy_bps   INTEGER NOT NULL DEFAULT 0,        -- annual yield in basis points (250 = 2.50%)
  is_credit BOOLEAN NOT NULL DEFAULT FALSE     -- loans carry a negative (owed) balance
);

-- Customers (the login + profile) -------------------------------------------
CREATE TABLE customers (
  customer_id   BIGSERIAL   PRIMARY KEY,
  username      TEXT        NOT NULL UNIQUE,
  password_hash TEXT        NOT NULL,          -- sha256 hex in the demo; use bcrypt/argon2 in prod
  first_name    TEXT        NOT NULL,
  last_name     TEXT        NOT NULL,
  email         TEXT        NOT NULL,
  phone         TEXT,
  address       TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Accounts — one customer has many accounts ---------------------------------
CREATE TABLE accounts (
  account_id    BIGSERIAL   PRIMARY KEY,
  customer_id   BIGINT      NOT NULL REFERENCES customers(customer_id) ON DELETE CASCADE,
  type_code     TEXT        NOT NULL REFERENCES account_types(code),
  balance_cents BIGINT      NOT NULL DEFAULT 0,   -- cached; = opening + SUM(postings)
  status        TEXT        NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','CLOSED')),
  opened_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_accounts_customer ON accounts(customer_id);

-- Transfers — groups the two postings of a money move between two accounts ---
CREATE TABLE transfers (
  transfer_id     BIGSERIAL   PRIMARY KEY,
  customer_id     BIGINT      NOT NULL REFERENCES customers(customer_id) ON DELETE CASCADE,
  from_account_id BIGINT      NOT NULL REFERENCES accounts(account_id),
  to_account_id   BIGINT      NOT NULL REFERENCES accounts(account_id),
  amount_cents    BIGINT      NOT NULL CHECK (amount_cents > 0),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (from_account_id <> to_account_id)
);

-- Payees — saved bill-pay recipients, one customer has many ------------------
CREATE TABLE payees (
  payee_id       BIGSERIAL   PRIMARY KEY,
  customer_id    BIGINT      NOT NULL REFERENCES customers(customer_id) ON DELETE CASCADE,
  name           TEXT        NOT NULL,
  account_number TEXT,
  address        TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_payees_customer ON payees(customer_id);

-- Bill payments — a payment from an account to a payee -----------------------
CREATE TABLE bill_payments (
  payment_id      BIGSERIAL   PRIMARY KEY,
  customer_id     BIGINT      NOT NULL REFERENCES customers(customer_id) ON DELETE CASCADE,
  payee_id        BIGINT      NOT NULL REFERENCES payees(payee_id),
  from_account_id BIGINT      NOT NULL REFERENCES accounts(account_id),
  amount_cents    BIGINT      NOT NULL CHECK (amount_cents > 0),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Loans — a loan request + its outcome --------------------------------------
CREATE TABLE loans (
  loan_id                 BIGSERIAL   PRIMARY KEY,
  customer_id             BIGINT      NOT NULL REFERENCES customers(customer_id) ON DELETE CASCADE,
  loan_account_id         BIGINT      REFERENCES accounts(account_id),  -- Loan account created on approval
  disbursed_to_account_id BIGINT      REFERENCES accounts(account_id),  -- where principal was deposited
  principal_cents         BIGINT      NOT NULL CHECK (principal_cents > 0),
  down_payment_cents      BIGINT      NOT NULL DEFAULT 0,
  term_months             INTEGER,
  rate_bps                INTEGER,
  status                  TEXT        NOT NULL CHECK (status IN ('APPROVED','DENIED')),
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Transactions = the LEDGER (postings). Append-only; correct with reversals.
-- amount_cents is SIGNED: debits negative, credits positive. Each transfer
-- writes two rows (debit + credit) sharing transfer_id; they sum to zero.
CREATE TABLE transactions (
  transaction_id      BIGSERIAL   PRIMARY KEY,
  account_id          BIGINT      NOT NULL REFERENCES accounts(account_id) ON DELETE CASCADE,
  posted_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  kind                TEXT        NOT NULL CHECK (kind IN ('DEPOSIT','DEBIT','CREDIT','TRANSFER','PAYMENT')),
  description         TEXT        NOT NULL,
  amount_cents        BIGINT      NOT NULL,       -- signed
  balance_after_cents BIGINT      NOT NULL,       -- running balance snapshot for fast statements
  transfer_id         BIGINT      REFERENCES transfers(transfer_id)     ON DELETE SET NULL,
  payment_id          BIGINT      REFERENCES bill_payments(payment_id)  ON DELETE SET NULL,
  loan_id             BIGINT      REFERENCES loans(loan_id)             ON DELETE SET NULL
);
CREATE INDEX idx_txn_account  ON transactions(account_id, posted_at DESC);
CREATE INDEX idx_txn_transfer ON transactions(transfer_id);

-- Sessions — login cookie -> customer ---------------------------------------
CREATE TABLE sessions (
  session_id  TEXT        PRIMARY KEY,           -- random token (the cookie value)
  customer_id BIGINT      NOT NULL REFERENCES customers(customer_id) ON DELETE CASCADE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at  TIMESTAMPTZ
);
CREATE INDEX idx_sessions_customer ON sessions(customer_id);

-- Contact messages — public contact form (no login) -------------------------
CREATE TABLE contact_messages (
  message_id BIGSERIAL   PRIMARY KEY,
  name       TEXT        NOT NULL,
  email      TEXT,
  message    TEXT        NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Integrity notes:
--  * Double-entry: for any transfer_id, SUM(amount_cents) over its transactions = 0.
--  * Balance check: accounts.balance_cents should equal the latest
--    balance_after_cents for that account (reconciliation query in SCHEMA.md).
--  * In production, enforce the zero-sum rule with a trigger and store
--    password_hash with bcrypt/argon2, not sha256.
