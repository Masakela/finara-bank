'use strict';
/*
 * SQLite backend (Node 22's built-in node:sqlite). Zero external deps — the
 * default backend for local dev and for the STLC test runs. Same interface as
 * the Oracle backend, so what passes here passes there.
 */
const { DatabaseSync } = require('node:sqlite');
const { hash, token, nowISO, codeOf, titleKind } = require('../util');

// Seeded defects (opt-in via DEFECTS env) — see DEFECTS.md. Default = correct behavior.
const _DEF = new Set((process.env.DEFECTS || '').split(',').map((s) => s.trim()).filter(Boolean));
const bug = (id) => _DEF.has('all') || _DEF.has(id);

const SCHEMA = `
CREATE TABLE IF NOT EXISTS account_types(code TEXT PRIMARY KEY,name TEXT NOT NULL,apy_bps INTEGER NOT NULL DEFAULT 0,is_credit INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS customers(customer_id INTEGER PRIMARY KEY AUTOINCREMENT,username TEXT NOT NULL UNIQUE,password_hash TEXT NOT NULL,first_name TEXT NOT NULL,last_name TEXT NOT NULL,email TEXT NOT NULL,phone TEXT,address TEXT,created_at TEXT NOT NULL DEFAULT (datetime('now')));
CREATE TABLE IF NOT EXISTS accounts(account_id INTEGER PRIMARY KEY AUTOINCREMENT,customer_id INTEGER NOT NULL REFERENCES customers(customer_id) ON DELETE CASCADE,type_code TEXT NOT NULL REFERENCES account_types(code),balance_cents INTEGER NOT NULL DEFAULT 0,status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK(status IN('ACTIVE','CLOSED')),opened_at TEXT NOT NULL DEFAULT (datetime('now')));
CREATE INDEX IF NOT EXISTS idx_accounts_customer ON accounts(customer_id);
CREATE TABLE IF NOT EXISTS transfers(transfer_id INTEGER PRIMARY KEY AUTOINCREMENT,customer_id INTEGER NOT NULL REFERENCES customers(customer_id),from_account_id INTEGER NOT NULL REFERENCES accounts(account_id),to_account_id INTEGER NOT NULL REFERENCES accounts(account_id),amount_cents INTEGER NOT NULL CHECK(amount_cents>0),created_at TEXT NOT NULL DEFAULT (datetime('now')),CHECK(from_account_id<>to_account_id));
CREATE TABLE IF NOT EXISTS payees(payee_id INTEGER PRIMARY KEY AUTOINCREMENT,customer_id INTEGER NOT NULL REFERENCES customers(customer_id),name TEXT NOT NULL,account_number TEXT,address TEXT,created_at TEXT NOT NULL DEFAULT (datetime('now')));
CREATE INDEX IF NOT EXISTS idx_payees_customer ON payees(customer_id);
CREATE TABLE IF NOT EXISTS bill_payments(payment_id INTEGER PRIMARY KEY AUTOINCREMENT,customer_id INTEGER NOT NULL REFERENCES customers(customer_id),payee_id INTEGER NOT NULL REFERENCES payees(payee_id),from_account_id INTEGER NOT NULL REFERENCES accounts(account_id),amount_cents INTEGER NOT NULL CHECK(amount_cents>0),created_at TEXT NOT NULL DEFAULT (datetime('now')));
CREATE TABLE IF NOT EXISTS loans(loan_id INTEGER PRIMARY KEY AUTOINCREMENT,customer_id INTEGER NOT NULL REFERENCES customers(customer_id),loan_account_id INTEGER REFERENCES accounts(account_id),disbursed_to_account_id INTEGER REFERENCES accounts(account_id),principal_cents INTEGER NOT NULL CHECK(principal_cents>0),down_payment_cents INTEGER NOT NULL DEFAULT 0,term_months INTEGER,rate_bps INTEGER,status TEXT NOT NULL CHECK(status IN('APPROVED','DENIED')),created_at TEXT NOT NULL DEFAULT (datetime('now')));
CREATE TABLE IF NOT EXISTS transactions(transaction_id INTEGER PRIMARY KEY AUTOINCREMENT,account_id INTEGER NOT NULL REFERENCES accounts(account_id) ON DELETE CASCADE,posted_at TEXT NOT NULL DEFAULT (datetime('now')),kind TEXT NOT NULL CHECK(kind IN('DEPOSIT','DEBIT','CREDIT','TRANSFER','PAYMENT')),description TEXT NOT NULL,amount_cents INTEGER NOT NULL,balance_after_cents INTEGER NOT NULL,transfer_id INTEGER REFERENCES transfers(transfer_id),payment_id INTEGER REFERENCES bill_payments(payment_id),loan_id INTEGER REFERENCES loans(loan_id));
CREATE INDEX IF NOT EXISTS idx_txn_account ON transactions(account_id,posted_at DESC);
CREATE TABLE IF NOT EXISTS sessions(session_id TEXT PRIMARY KEY,customer_id INTEGER NOT NULL REFERENCES customers(customer_id) ON DELETE CASCADE,created_at TEXT NOT NULL DEFAULT (datetime('now')),expires_at TEXT);
CREATE TABLE IF NOT EXISTS contact_messages(message_id INTEGER PRIMARY KEY AUTOINCREMENT,name TEXT NOT NULL,email TEXT,message TEXT NOT NULL,created_at TEXT NOT NULL DEFAULT (datetime('now')));
`;

function create({ file = process.env.SQLITE_FILE || ':memory:' } = {}) {
  const db = new DatabaseSync(file);
  db.exec('PRAGMA foreign_keys = ON;');
  const get = (sql, p = []) => db.prepare(sql).get(...p);
  const all = (sql, p = []) => db.prepare(sql).all(...p);
  const run = (sql, p = []) => db.prepare(sql).run(...p);
  const mapAcc = (r) => r && ({ id: String(r.id), type: r.type, balance: r.balance });
  const acc = (userId, id) => { const r = get('SELECT a.account_id id, at.name type, a.balance_cents balance FROM accounts a JOIN account_types at ON at.code=a.type_code WHERE a.account_id=? AND a.customer_id=?', [Number(id), Number(userId)]); return mapAcc(r); };
  const setBal = (id, delta) => run('UPDATE accounts SET balance_cents=balance_cents+? WHERE account_id=?', [delta, Number(id)]);
  const balOf = (id) => get('SELECT balance_cents b FROM accounts WHERE account_id=?', [Number(id)]).b;
  const postTxn = (accountId, kind, desc, amount, balAfter, { transfer_id = null, payment_id = null, loan_id = null } = {}) =>
    run('INSERT INTO transactions(account_id,posted_at,kind,description,amount_cents,balance_after_cents,transfer_id,payment_id,loan_id) VALUES(?,?,?,?,?,?,?,?,?)',
      [Number(accountId), nowISO(), kind, desc, amount, balAfter, transfer_id, payment_id, loan_id]);

  return {
    async init() {
      db.exec(SCHEMA);
      if (!get('SELECT COUNT(*) c FROM customers').c) {
        db.exec(`INSERT INTO account_types VALUES('CHK','Checking',0,0),('SAV','Savings',250,0),('LOAN','Loan',0,1);`);
        const uid = run('INSERT INTO customers(username,password_hash,first_name,last_name,email,phone,address) VALUES(?,?,?,?,?,?,?)',
          ['demo', hash('demo123'), 'Dana', 'Morales', 'demo@finara.test', '312-555-0180', '500 W Madison St, Chicago, IL']).lastInsertRowid;
        const chk = run('INSERT INTO accounts(customer_id,type_code,balance_cents) VALUES(?,?,?)', [uid, 'CHK', 750350]).lastInsertRowid;
        const sav = run('INSERT INTO accounts(customer_id,type_code,balance_cents) VALUES(?,?,?)', [uid, 'SAV', 1301875]).lastInsertRowid;
        const tr = run('INSERT INTO transfers(customer_id,from_account_id,to_account_id,amount_cents) VALUES(?,?,?,?)', [uid, chk, sav, 50000]).lastInsertRowid;
        const seedTxns = [
          [chk, 'DEPOSIT', 'Payroll — Acme Corp', 320000, 820000, null],
          [chk, 'DEBIT', "Grocery — Mariano's", -8450, 811550, null],
          [chk, 'DEBIT', 'Electric — ComEd', -11200, 800350, null],
          [sav, 'CREDIT', 'Interest', 1875, 1251875, null],
          [chk, 'TRANSFER', 'Transfer to Savings', -50000, 750350, tr],
          [sav, 'TRANSFER', 'Transfer from Checking', 50000, 1301875, tr],
        ];
        for (const t of seedTxns) run('INSERT INTO transactions(account_id,kind,description,amount_cents,balance_after_cents,transfer_id) VALUES(?,?,?,?,?,?)', t);
      }
    },

    async resolveUser(sid) {
      if (!sid) return null;
      const r = get(`SELECT c.customer_id id,c.username,c.first_name firstName,c.last_name lastName,c.email,c.phone,c.address
        FROM sessions s JOIN customers c ON c.customer_id=s.customer_id WHERE s.session_id=?`, [sid]);
      return r && { id: String(r.id), username: r.username, firstName: r.firstName, lastName: r.lastName, email: r.email, phone: r.phone, address: r.address };
    },
    async login(username, password) {
      const r = get('SELECT customer_id id,password_hash FROM customers WHERE LOWER(username)=LOWER(?)', [String(username || '')]);
      if (!r || r.password_hash !== hash(password)) return null;
      const sid = token(); run('INSERT INTO sessions(session_id,customer_id) VALUES(?,?)', [sid, r.id]); return sid;
    },
    async logout(sid) { if (sid) run('DELETE FROM sessions WHERE session_id=?', [sid]); },
    async register({ firstName, lastName, email, username, password, depositCents = 0 }) {
      // D3: duplicate-username check is case-sensitive, so "Demo" slips past an existing "demo"
      if (get(bug('D3') ? 'SELECT 1 x FROM customers WHERE username=?' : 'SELECT 1 x FROM customers WHERE LOWER(username)=LOWER(?)', [username])) return { error: 'That username is already taken.' };
      const uid = run('INSERT INTO customers(username,password_hash,first_name,last_name,email) VALUES(?,?,?,?,?)', [username, hash(password), firstName, lastName, email]).lastInsertRowid;
      const chk = run('INSERT INTO accounts(customer_id,type_code,balance_cents) VALUES(?,?,0)', [uid, 'CHK']).lastInsertRowid;
      if (depositCents > 0) { setBal(chk, depositCents); postTxn(chk, 'DEPOSIT', 'Opening deposit', depositCents, balOf(chk)); }
      const sid = token(); run('INSERT INTO sessions(session_id,customer_id) VALUES(?,?)', [sid, uid]); return { sid };
    },
    async getAccounts(userId) {
      return all('SELECT a.account_id id, at.name type, a.balance_cents balance FROM accounts a JOIN account_types at ON at.code=a.type_code WHERE a.customer_id=? ORDER BY a.account_id', [Number(userId)]).map(mapAcc);
    },
    async getTransactions(userId, accountId) {
      if (!accountId) return [];
      const owns = get('SELECT 1 x FROM accounts WHERE account_id=? AND customer_id=?', [Number(accountId), Number(userId)]);
      if (!owns && !bug('D6')) return []; // D6: missing ownership check → view any account's transactions (IDOR)
      return all('SELECT posted_at date,kind,description,amount_cents amount,balance_after_cents balanceAfter FROM transactions WHERE account_id=? ORDER BY posted_at DESC, transaction_id DESC', [Number(accountId)])
        .map((r) => ({ date: r.date, type: titleKind(r.kind), description: r.description, amount: r.amount, balanceAfter: r.balanceAfter }));
    },
    async transfer(userId, fromId, toId, amountCents) {
      if (String(fromId) === String(toId)) return { error: 'Choose two different accounts.' };
      if (!(amountCents > 0)) return { error: 'Enter an amount greater than zero.' };
      const from = acc(userId, fromId), to = acc(userId, toId);
      if (!from || !to) return { error: 'Pick valid accounts.' };
      if (amountCents > from.balance && !bug('D1')) return { error: 'Insufficient funds in the source account.' }; // D1: overdraft allowed
      db.exec('BEGIN');
      try {
        const tr = run('INSERT INTO transfers(customer_id,from_account_id,to_account_id,amount_cents) VALUES(?,?,?,?)', [Number(userId), Number(fromId), Number(toId), amountCents]).lastInsertRowid;
        setBal(fromId, -amountCents); setBal(toId, amountCents);
        postTxn(fromId, 'TRANSFER', `Transfer to ${to.type} ••${String(to.id).slice(-4)}`, -amountCents, balOf(fromId), { transfer_id: tr });
        postTxn(toId, 'TRANSFER', `Transfer from ${from.type} ••${String(from.id).slice(-4)}`, amountCents, balOf(toId), { transfer_id: tr });
        db.exec('COMMIT');
      } catch (e) { db.exec('ROLLBACK'); return { error: 'Transfer failed.' }; }
      return { ok: true, amountCents };
    },
    async billpay(userId, fromId, payee, payeeAcct, amountCents) {
      const from = acc(userId, fromId);
      if (!from) return { error: 'Pick a valid account.' };
      if (!String(payee || '').trim()) return { error: 'Enter a payee name.' };
      if (!(amountCents > 0)) return { error: 'Enter an amount greater than zero.' };
      if (amountCents > from.balance) return { error: 'Insufficient funds for this payment.' };
      db.exec('BEGIN');
      try {
        const pid = run('INSERT INTO payees(customer_id,name,account_number) VALUES(?,?,?)', [Number(userId), payee, payeeAcct || null]).lastInsertRowid;
        const bp = run('INSERT INTO bill_payments(customer_id,payee_id,from_account_id,amount_cents) VALUES(?,?,?,?)', [Number(userId), pid, Number(fromId), amountCents]).lastInsertRowid;
        setBal(fromId, -amountCents);
        postTxn(fromId, 'PAYMENT', `Bill pay — ${payee}`, -amountCents, balOf(fromId), { payment_id: bp });
        db.exec('COMMIT');
      } catch (e) { db.exec('ROLLBACK'); return { error: 'Payment failed.' }; }
      return { ok: true, amountCents };
    },
    async openAccount(userId, type, fromId, depositCents) {
      const from = acc(userId, fromId);
      if (!from) return { error: 'Pick a valid funding account.' };
      if (depositCents > from.balance) return { error: 'Insufficient funds for the opening deposit.' };
      const t = type === 'Savings' ? 'Savings' : 'Checking';
      db.exec('BEGIN');
      try {
        const nid = run('INSERT INTO accounts(customer_id,type_code,balance_cents) VALUES(?,?,0)', [Number(userId), codeOf(t)]).lastInsertRowid;
        if (depositCents > 0) {
          const tr = run('INSERT INTO transfers(customer_id,from_account_id,to_account_id,amount_cents) VALUES(?,?,?,?)', [Number(userId), Number(fromId), nid, depositCents]).lastInsertRowid;
          setBal(fromId, -depositCents); setBal(nid, depositCents);
          postTxn(fromId, 'TRANSFER', `Opening deposit to ${t}`, -depositCents, balOf(fromId), { transfer_id: tr });
          postTxn(nid, 'DEPOSIT', 'Opening deposit', depositCents, balOf(nid), { transfer_id: tr });
        }
        db.exec('COMMIT');
      } catch (e) { db.exec('ROLLBACK'); return { error: 'Could not open the account.' }; }
      return { ok: true, type: t };
    },
    async requestLoan(userId, amountCents, downCents, toId) {
      const to = acc(userId, toId);
      if (!to) return { error: 'Pick a valid deposit account.' };
      if (!(amountCents > 0)) return { error: 'Enter a loan amount greater than zero.' };
      // D2: boundary bug — strict > wrongly denies an exactly-20% down payment
      const approved = bug('D2') ? downCents > amountCents * 0.2 : downCents >= amountCents * 0.2;
      db.exec('BEGIN');
      try {
        if (!approved) {
          run('INSERT INTO loans(customer_id,disbursed_to_account_id,principal_cents,down_payment_cents,status) VALUES(?,?,?,?,?)', [Number(userId), Number(toId), amountCents, downCents, 'DENIED']);
          db.exec('COMMIT'); return { ok: true, approved: false };
        }
        const lacc = run('INSERT INTO accounts(customer_id,type_code,balance_cents) VALUES(?,?,?)', [Number(userId), 'LOAN', -amountCents]).lastInsertRowid;
        const loan = run('INSERT INTO loans(customer_id,loan_account_id,disbursed_to_account_id,principal_cents,down_payment_cents,status) VALUES(?,?,?,?,?,?)', [Number(userId), lacc, Number(toId), amountCents, downCents, 'APPROVED']).lastInsertRowid;
        postTxn(lacc, 'CREDIT', 'Loan principal', -amountCents, -amountCents, { loan_id: loan });
        setBal(toId, amountCents);
        postTxn(toId, 'DEPOSIT', 'Loan disbursement', amountCents, balOf(toId), { loan_id: loan });
        db.exec('COMMIT');
      } catch (e) { db.exec('ROLLBACK'); return { error: 'Loan processing failed.' }; }
      return { ok: true, approved: true, amountCents };
    },
    async updateProfile(userId, { firstName, lastName, email, phone, address }) {
      run('UPDATE customers SET first_name=?,last_name=?,email=?,phone=?,address=? WHERE customer_id=?',
        [firstName, lastName, email, phone || null, address || null, Number(userId)]);
      return { ok: true };
    },
    async addContact({ name, email, message }) {
      run('INSERT INTO contact_messages(name,email,message) VALUES(?,?,?)', [name, email || null, message]); return { ok: true };
    },
  };
}
module.exports = { create };
