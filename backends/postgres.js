'use strict';
/*
 * PostgreSQL backend (node-postgres `pg`). Same interface as the SQLite backend;
 * the logic/validation mirror backends/sqlite.js, which was verified end-to-end.
 * Schema + demo seed are created automatically on first run, so a fresh Render
 * Postgres just works. Enable with DB_BACKEND=postgres (auto when DATABASE_URL is set).
 *
 *   npm install pg
 */
const { hash, token, nowISO, codeOf, titleKind } = require('../util');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS account_types(code TEXT PRIMARY KEY,name TEXT NOT NULL,apy_bps INTEGER NOT NULL DEFAULT 0,is_credit BOOLEAN NOT NULL DEFAULT FALSE);
CREATE TABLE IF NOT EXISTS customers(customer_id BIGSERIAL PRIMARY KEY,username TEXT NOT NULL UNIQUE,password_hash TEXT NOT NULL,first_name TEXT NOT NULL,last_name TEXT NOT NULL,email TEXT NOT NULL,phone TEXT,address TEXT,created_at TIMESTAMPTZ NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS accounts(account_id BIGSERIAL PRIMARY KEY,customer_id BIGINT NOT NULL REFERENCES customers(customer_id) ON DELETE CASCADE,type_code TEXT NOT NULL REFERENCES account_types(code),balance_cents BIGINT NOT NULL DEFAULT 0,status TEXT NOT NULL DEFAULT 'ACTIVE',opened_at TIMESTAMPTZ NOT NULL DEFAULT now());
CREATE INDEX IF NOT EXISTS idx_accounts_customer ON accounts(customer_id);
CREATE TABLE IF NOT EXISTS transfers(transfer_id BIGSERIAL PRIMARY KEY,customer_id BIGINT NOT NULL REFERENCES customers(customer_id) ON DELETE CASCADE,from_account_id BIGINT NOT NULL REFERENCES accounts(account_id),to_account_id BIGINT NOT NULL REFERENCES accounts(account_id),amount_cents BIGINT NOT NULL,created_at TIMESTAMPTZ NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS payees(payee_id BIGSERIAL PRIMARY KEY,customer_id BIGINT NOT NULL REFERENCES customers(customer_id) ON DELETE CASCADE,name TEXT NOT NULL,account_number TEXT,address TEXT,created_at TIMESTAMPTZ NOT NULL DEFAULT now());
CREATE INDEX IF NOT EXISTS idx_payees_customer ON payees(customer_id);
CREATE TABLE IF NOT EXISTS bill_payments(payment_id BIGSERIAL PRIMARY KEY,customer_id BIGINT NOT NULL REFERENCES customers(customer_id) ON DELETE CASCADE,payee_id BIGINT NOT NULL REFERENCES payees(payee_id),from_account_id BIGINT NOT NULL REFERENCES accounts(account_id),amount_cents BIGINT NOT NULL,created_at TIMESTAMPTZ NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS loans(loan_id BIGSERIAL PRIMARY KEY,customer_id BIGINT NOT NULL REFERENCES customers(customer_id) ON DELETE CASCADE,loan_account_id BIGINT REFERENCES accounts(account_id),disbursed_to_account_id BIGINT REFERENCES accounts(account_id),principal_cents BIGINT NOT NULL,down_payment_cents BIGINT NOT NULL DEFAULT 0,term_months INTEGER,rate_bps INTEGER,status TEXT NOT NULL,created_at TIMESTAMPTZ NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS transactions(transaction_id BIGSERIAL PRIMARY KEY,account_id BIGINT NOT NULL REFERENCES accounts(account_id) ON DELETE CASCADE,posted_at TIMESTAMPTZ NOT NULL DEFAULT now(),kind TEXT NOT NULL,description TEXT NOT NULL,amount_cents BIGINT NOT NULL,balance_after_cents BIGINT NOT NULL,transfer_id BIGINT REFERENCES transfers(transfer_id),payment_id BIGINT REFERENCES bill_payments(payment_id),loan_id BIGINT REFERENCES loans(loan_id));
CREATE INDEX IF NOT EXISTS idx_txn_account ON transactions(account_id);
CREATE TABLE IF NOT EXISTS sessions(session_id TEXT PRIMARY KEY,customer_id BIGINT NOT NULL REFERENCES customers(customer_id) ON DELETE CASCADE,created_at TIMESTAMPTZ NOT NULL DEFAULT now(),expires_at TIMESTAMPTZ);
CREATE TABLE IF NOT EXISTS contact_messages(message_id BIGSERIAL PRIMARY KEY,name TEXT NOT NULL,email TEXT,message TEXT NOT NULL,created_at TIMESTAMPTZ NOT NULL DEFAULT now());
`;

function create({ pool: injected } = {}) {
  let pool = injected;
  const q = async (sql, params = []) => (await pool.query(sql, params)).rows;
  async function withClient(fn) {
    const c = await pool.connect();
    try { await c.query('BEGIN'); const r = await fn(c); await c.query('COMMIT'); return r; }
    catch (e) { try { await c.query('ROLLBACK'); } catch (_) {} throw e; }
    finally { c.release(); }
  }
  async function accOf(userId, id) {
    const rows = await q(`SELECT a.account_id AS id, at.name AS type, a.balance_cents AS balance
      FROM accounts a JOIN account_types at ON at.code = a.type_code WHERE a.account_id = $1 AND a.customer_id = $2`, [Number(id), Number(userId)]);
    const r = rows[0];
    return r && { id: String(r.id), type: r.type, balance: Number(r.balance) };
  }
  const balOf = async (c, id) => Number((await c.query('SELECT balance_cents FROM accounts WHERE account_id=$1', [Number(id)])).rows[0].balance_cents);
  const post = (c, accountId, kind, desc, amount, balAfter, extra = {}) => c.query(
    `INSERT INTO transactions(account_id,kind,description,amount_cents,balance_after_cents,transfer_id,payment_id,loan_id)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
    [Number(accountId), kind, desc, amount, balAfter, extra.transfer_id ?? null, extra.payment_id ?? null, extra.loan_id ?? null]);

  return {
    async init() {
      if (!pool) {
        const pg = require('pg');
        pg.types.setTypeParser(20, (v) => (v === null ? null : parseInt(v, 10))); // BIGINT -> number
        pool = new pg.Pool({
          connectionString: process.env.DATABASE_URL,
          ssl: process.env.PGSSLMODE === 'disable' ? false : { rejectUnauthorized: false },
          max: 5,
        });
      }
      for (const stmt of SCHEMA.split(';').map((s) => s.trim()).filter(Boolean)) await pool.query(stmt);
      const n = Number((await q('SELECT COUNT(*)::int AS c FROM customers'))[0].c);
      if (!n) {
        await q(`INSERT INTO account_types(code,name,apy_bps,is_credit) VALUES ('CHK','Checking',0,FALSE),('SAV','Savings',250,FALSE),('LOAN','Loan',0,TRUE)`);
        const uid = (await q(`INSERT INTO customers(username,password_hash,first_name,last_name,email,phone,address) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING customer_id`,
          ['demo', hash('demo123'), 'Dana', 'Morales', 'demo@finara.test', '312-555-0180', '500 W Madison St, Chicago, IL']))[0].customer_id;
        const chk = (await q(`INSERT INTO accounts(customer_id,type_code,balance_cents) VALUES($1,'CHK',750350) RETURNING account_id`, [uid]))[0].account_id;
        const sav = (await q(`INSERT INTO accounts(customer_id,type_code,balance_cents) VALUES($1,'SAV',1301875) RETURNING account_id`, [uid]))[0].account_id;
        const tr = (await q(`INSERT INTO transfers(customer_id,from_account_id,to_account_id,amount_cents) VALUES($1,$2,$3,50000) RETURNING transfer_id`, [uid, chk, sav]))[0].transfer_id;
        const seed = [
          [chk, 'DEPOSIT', 'Payroll — Acme Corp', 320000, 820000, null],
          [chk, 'DEBIT', "Grocery — Mariano's", -8450, 811550, null],
          [chk, 'DEBIT', 'Electric — ComEd', -11200, 800350, null],
          [sav, 'CREDIT', 'Interest', 1875, 1251875, null],
          [chk, 'TRANSFER', 'Transfer to Savings', -50000, 750350, tr],
          [sav, 'TRANSFER', 'Transfer from Checking', 50000, 1301875, tr],
        ];
        for (const t of seed) await q(`INSERT INTO transactions(account_id,kind,description,amount_cents,balance_after_cents,transfer_id) VALUES($1,$2,$3,$4,$5,$6)`, t);
      }
    },

    async resolveUser(sid) {
      if (!sid) return null;
      const rows = await q(`SELECT c.customer_id AS id,c.username,c.first_name,c.last_name,c.email,c.phone,c.address
        FROM sessions s JOIN customers c ON c.customer_id = s.customer_id WHERE s.session_id = $1`, [sid]);
      const r = rows[0];
      return r && { id: String(r.id), username: r.username, firstName: r.first_name, lastName: r.last_name, email: r.email, phone: r.phone, address: r.address };
    },
    async login(username, password) {
      const rows = await q(`SELECT customer_id AS id, password_hash FROM customers WHERE LOWER(username) = LOWER($1)`, [String(username || '')]);
      const r = rows[0];
      if (!r || r.password_hash !== hash(password)) return null;
      const sid = token();
      await q(`INSERT INTO sessions(session_id,customer_id) VALUES($1,$2)`, [sid, r.id]);
      return sid;
    },
    async logout(sid) { if (sid) await q(`DELETE FROM sessions WHERE session_id = $1`, [sid]); },
    async register({ firstName, lastName, email, username, password, depositCents = 0 }) {
      const dup = await q(`SELECT 1 FROM customers WHERE LOWER(username) = LOWER($1)`, [username]);
      if (dup.length) return { error: 'That username is already taken.' };
      const sid = token();
      await withClient(async (c) => {
        const uid = (await c.query(`INSERT INTO customers(username,password_hash,first_name,last_name,email) VALUES($1,$2,$3,$4,$5) RETURNING customer_id`, [username, hash(password), firstName, lastName, email])).rows[0].customer_id;
        const chk = (await c.query(`INSERT INTO accounts(customer_id,type_code,balance_cents) VALUES($1,'CHK',0) RETURNING account_id`, [uid])).rows[0].account_id;
        if (depositCents > 0) { await c.query(`UPDATE accounts SET balance_cents=$1 WHERE account_id=$2`, [depositCents, chk]); await post(c, chk, 'DEPOSIT', 'Opening deposit', depositCents, depositCents); }
        await c.query(`INSERT INTO sessions(session_id,customer_id) VALUES($1,$2)`, [sid, uid]);
      });
      return { sid };
    },
    async getAccounts(userId) {
      const rows = await q(`SELECT a.account_id AS id, at.name AS type, a.balance_cents AS balance
        FROM accounts a JOIN account_types at ON at.code = a.type_code WHERE a.customer_id = $1 ORDER BY a.account_id`, [Number(userId)]);
      return rows.map((r) => ({ id: String(r.id), type: r.type, balance: Number(r.balance) }));
    },
    async getTransactions(userId, accountId) {
      if (!accountId) return [];
      const owns = await q(`SELECT 1 FROM accounts WHERE account_id=$1 AND customer_id=$2`, [Number(accountId), Number(userId)]);
      if (!owns.length) return [];
      const rows = await q(`SELECT posted_at,kind,description,amount_cents,balance_after_cents
        FROM transactions WHERE account_id=$1 ORDER BY posted_at DESC, transaction_id DESC`, [Number(accountId)]);
      return rows.map((r) => ({ date: new Date(r.posted_at).toISOString(), type: titleKind(r.kind), description: r.description, amount: Number(r.amount_cents), balanceAfter: Number(r.balance_after_cents) }));
    },
    async transfer(userId, fromId, toId, amountCents) {
      if (String(fromId) === String(toId)) return { error: 'Choose two different accounts.' };
      if (!(amountCents > 0)) return { error: 'Enter an amount greater than zero.' };
      const from = await accOf(userId, fromId), to = await accOf(userId, toId);
      if (!from || !to) return { error: 'Pick valid accounts.' };
      if (amountCents > from.balance) return { error: 'Insufficient funds in the source account.' };
      await withClient(async (c) => {
        const tr = (await c.query(`INSERT INTO transfers(customer_id,from_account_id,to_account_id,amount_cents) VALUES($1,$2,$3,$4) RETURNING transfer_id`, [Number(userId), Number(fromId), Number(toId), amountCents])).rows[0].transfer_id;
        await c.query(`UPDATE accounts SET balance_cents=balance_cents+$1 WHERE account_id=$2`, [-amountCents, Number(fromId)]);
        await c.query(`UPDATE accounts SET balance_cents=balance_cents+$1 WHERE account_id=$2`, [amountCents, Number(toId)]);
        await post(c, fromId, 'TRANSFER', `Transfer to ${to.type} ••${String(to.id).slice(-4)}`, -amountCents, await balOf(c, fromId), { transfer_id: tr });
        await post(c, toId, 'TRANSFER', `Transfer from ${from.type} ••${String(from.id).slice(-4)}`, amountCents, await balOf(c, toId), { transfer_id: tr });
      });
      return { ok: true, amountCents };
    },
    async billpay(userId, fromId, payee, payeeAcct, amountCents) {
      const from = await accOf(userId, fromId);
      if (!from) return { error: 'Pick a valid account.' };
      if (!String(payee || '').trim()) return { error: 'Enter a payee name.' };
      if (!(amountCents > 0)) return { error: 'Enter an amount greater than zero.' };
      if (amountCents > from.balance) return { error: 'Insufficient funds for this payment.' };
      await withClient(async (c) => {
        const pid = (await c.query(`INSERT INTO payees(customer_id,name,account_number) VALUES($1,$2,$3) RETURNING payee_id`, [Number(userId), payee, payeeAcct || null])).rows[0].payee_id;
        const bp = (await c.query(`INSERT INTO bill_payments(customer_id,payee_id,from_account_id,amount_cents) VALUES($1,$2,$3,$4) RETURNING payment_id`, [Number(userId), pid, Number(fromId), amountCents])).rows[0].payment_id;
        await c.query(`UPDATE accounts SET balance_cents=balance_cents+$1 WHERE account_id=$2`, [-amountCents, Number(fromId)]);
        await post(c, fromId, 'PAYMENT', `Bill pay — ${payee}`, -amountCents, await balOf(c, fromId), { payment_id: bp });
      });
      return { ok: true, amountCents };
    },
    async openAccount(userId, type, fromId, depositCents) {
      const from = await accOf(userId, fromId);
      if (!from) return { error: 'Pick a valid funding account.' };
      if (depositCents > from.balance) return { error: 'Insufficient funds for the opening deposit.' };
      const t = type === 'Savings' ? 'Savings' : 'Checking';
      await withClient(async (c) => {
        const nid = (await c.query(`INSERT INTO accounts(customer_id,type_code,balance_cents) VALUES($1,$2,0) RETURNING account_id`, [Number(userId), codeOf(t)])).rows[0].account_id;
        if (depositCents > 0) {
          const tr = (await c.query(`INSERT INTO transfers(customer_id,from_account_id,to_account_id,amount_cents) VALUES($1,$2,$3,$4) RETURNING transfer_id`, [Number(userId), Number(fromId), nid, depositCents])).rows[0].transfer_id;
          await c.query(`UPDATE accounts SET balance_cents=balance_cents+$1 WHERE account_id=$2`, [-depositCents, Number(fromId)]);
          await c.query(`UPDATE accounts SET balance_cents=balance_cents+$1 WHERE account_id=$2`, [depositCents, nid]);
          await post(c, fromId, 'TRANSFER', `Opening deposit to ${t}`, -depositCents, await balOf(c, fromId), { transfer_id: tr });
          await post(c, nid, 'DEPOSIT', 'Opening deposit', depositCents, await balOf(c, nid), { transfer_id: tr });
        }
      });
      return { ok: true, type: t };
    },
    async requestLoan(userId, amountCents, downCents, toId) {
      const to = await accOf(userId, toId);
      if (!to) return { error: 'Pick a valid deposit account.' };
      if (!(amountCents > 0)) return { error: 'Enter a loan amount greater than zero.' };
      const approved = downCents >= amountCents * 0.2;
      await withClient(async (c) => {
        if (!approved) {
          await c.query(`INSERT INTO loans(customer_id,disbursed_to_account_id,principal_cents,down_payment_cents,status) VALUES($1,$2,$3,$4,'DENIED')`, [Number(userId), Number(toId), amountCents, downCents]);
          return;
        }
        const lacc = (await c.query(`INSERT INTO accounts(customer_id,type_code,balance_cents) VALUES($1,'LOAN',$2) RETURNING account_id`, [Number(userId), -amountCents])).rows[0].account_id;
        const loan = (await c.query(`INSERT INTO loans(customer_id,loan_account_id,disbursed_to_account_id,principal_cents,down_payment_cents,status) VALUES($1,$2,$3,$4,$5,'APPROVED') RETURNING loan_id`, [Number(userId), lacc, Number(toId), amountCents, downCents])).rows[0].loan_id;
        await post(c, lacc, 'CREDIT', 'Loan principal', -amountCents, -amountCents, { loan_id: loan });
        await c.query(`UPDATE accounts SET balance_cents=balance_cents+$1 WHERE account_id=$2`, [amountCents, Number(toId)]);
        await post(c, toId, 'DEPOSIT', 'Loan disbursement', amountCents, await balOf(c, toId), { loan_id: loan });
      });
      return approved ? { ok: true, approved: true, amountCents } : { ok: true, approved: false };
    },
    async updateProfile(userId, { firstName, lastName, email, phone, address }) {
      await q(`UPDATE customers SET first_name=$1,last_name=$2,email=$3,phone=$4,address=$5 WHERE customer_id=$6`,
        [firstName, lastName, email, phone || null, address || null, Number(userId)]);
      return { ok: true };
    },
    async addContact({ name, email, message }) {
      await q(`INSERT INTO contact_messages(name,email,message) VALUES($1,$2,$3)`, [name, email || null, message]);
      return { ok: true };
    },
  };
}
module.exports = { create };
