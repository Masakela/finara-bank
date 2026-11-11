#!/usr/bin/env node
/*
 * Finara — a fully functional demo online-banking web app, built as a System Under Test
 * for the STLC automation pipeline (register, login, accounts, transfers, bill pay, transactions,
 * profile, loans). Zero dependencies: run `node server.js` and open http://localhost:7080.
 *
 * Designed to be testable: semantic HTML (every input has a <label>, buttons have clear text),
 * data-testid hooks on key elements, a real cookie-session login, and gated pages that redirect to
 * /login when signed out — so the crawler's authenticated pass (storageState) has something to do.
 * Money is stored in integer cents; transfers are double-entry. No seeded defects — it works.
 */
'use strict';
const http = require('http');
const crypto = require('crypto');
const { parse: parseQs } = require('querystring');

const PORT = process.env.PORT || 7080;

// ---------------------------------------------------------------- in-memory data
let SEQ = 1000;
const id = () => String(++SEQ);
const users = new Map();        // userId -> user
const byUsername = new Map();   // username -> userId
const accounts = new Map();     // accountId -> account
const txns = [];                // { id, accountId, date, type, description, amount(cents), balanceAfter }
const sessions = new Map();     // sid -> userId

const hash = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const nowISO = () => new Date().toISOString();
const money = (cents) => (cents < 0 ? '-' : '') + '$' + (Math.abs(cents) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const toCents = (dollars) => Math.round(parseFloat(dollars) * 100);

function createUser({ username, password, firstName, lastName, email, phone = '', address = '' }) {
  const uid = id();
  users.set(uid, { id: uid, username, pass: hash(password), firstName, lastName, email, phone, address });
  byUsername.set(username.toLowerCase(), uid);
  return uid;
}
function openAccount(userId, type, openingCents = 0) {
  const aid = id();
  accounts.set(aid, { id: aid, userId, type, balance: openingCents });
  return aid;
}
function post(accountId, type, description, amount) {
  const acc = accounts.get(accountId);
  acc.balance += amount; // amount signed in cents
  txns.push({ id: id(), accountId, date: nowISO(), type, description, amount, balanceAfter: acc.balance });
}
function userAccounts(userId) { return [...accounts.values()].filter((a) => a.userId === userId); }
function accountTxns(accountId) { return txns.filter((t) => t.accountId === accountId).reverse(); }

// ---------------------------------------------------------------- seed demo data (known test creds)
(function seed() {
  const uid = createUser({ username: 'demo', password: 'demo123', firstName: 'Dana', lastName: 'Morales', email: 'demo@finara.test', phone: '312-555-0180', address: '500 W Madison St, Chicago, IL' });
  const chk = openAccount(uid, 'Checking', 500000);
  const sav = openAccount(uid, 'Savings', 1250000);
  post(chk, 'Deposit', 'Payroll — Acme Corp', 320000);
  post(chk, 'Debit', 'Grocery — Mariano\'s', -8450);
  post(chk, 'Debit', 'Electric — ComEd', -11200);
  post(sav, 'Credit', 'Interest', 1875);
  post(chk, 'Transfer', 'Transfer to Savings', -50000);
  post(sav, 'Transfer', 'Transfer from Checking', 50000);
})();

// ---------------------------------------------------------------- http helpers
function cookies(req) {
  const out = {}; (req.headers.cookie || '').split(';').forEach((c) => { const i = c.indexOf('='); if (i > 0) out[c.slice(0, i).trim()] = decodeURIComponent(c.slice(i + 1).trim()); });
  return out;
}
function sessionUser(req) { const sid = cookies(req).sid; const uid = sid && sessions.get(sid); return uid ? users.get(uid) : null; }
function body(req) { return new Promise((res) => { let d = ''; req.on('data', (c) => (d += c)); req.on('end', () => res(parseQs(d))); }); }
function send(res, html, status = 200, headers = {}) { res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', ...headers }); res.end(html); }
function redirect(res, loc, headers = {}) { res.writeHead(302, { Location: loc, ...headers }); res.end(); }
const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// ---------------------------------------------------------------- layout + shared styles
function layout(title, user, main, flash) {
  const nav = user
    ? `<a href="/dashboard">Accounts</a><a href="/transfer">Transfer</a><a href="/billpay">Bill Pay</a><a href="/transactions">Activity</a><a href="/loan">Loans</a><a href="/profile">Profile</a><a class="ghost" href="/logout" data-testid="logout">Log out</a>`
    : `<a href="/services">Personal</a><a href="/calculator">Loans</a><a href="/faq">Help</a><a href="/about">About</a><a href="/login" data-testid="nav-login">Log in</a><a class="btn" href="/register" data-testid="nav-register">Open account</a>`;
  const flashHtml = flash ? `<div class="flash ${flash.kind}" data-testid="flash" role="status">${esc(flash.msg)}</div>` : '';
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)} · Finara</title>
<style>
:root{--navy:#0b2e4f;--navy2:#12436f;--teal:#0ea5a0;--ink:#13202e;--muted:#5b6b7b;--line:#e3e8ee;--bg:#f5f7fa;--card:#fff;--good:#0f9d58;--bad:#d64545;--warn:#b8860b}
*{box-sizing:border-box}body{margin:0;font:15px/1.55 -apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:var(--ink);background:var(--bg)}
a{color:var(--navy2);text-decoration:none}a:hover{text-decoration:underline}
header{background:var(--navy);color:#fff}
.bar{max-width:1040px;margin:0 auto;display:flex;align-items:center;gap:18px;padding:14px 20px}
.brand{font-weight:800;font-size:1.15rem;letter-spacing:.2px;color:#fff;margin-right:auto;display:flex;align-items:center;gap:8px}
.brand .mark{width:26px;height:26px;border-radius:7px;background:linear-gradient(135deg,var(--teal),#3bd1c9);display:inline-block}
nav{display:flex;align-items:center;gap:16px}
nav a{color:#dce7f1;font-size:.92rem;white-space:nowrap}nav a:hover{color:#fff}
nav a.btn,nav a.ghost{padding:7px 13px;border-radius:7px}
nav a.btn{background:var(--teal);color:#042b2a;font-weight:700}nav a.ghost{border:1px solid #39597a;color:#fff}
main{max-width:1040px;margin:0 auto;padding:26px 20px 56px}
h1{font-size:1.5rem;margin:0 0 4px}h2{font-size:1.15rem;margin:26px 0 12px}
.sub{color:var(--muted);margin:0 0 20px}
.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:20px;margin-bottom:18px}
.grid{display:grid;grid-template-columns:1fr 1fr;gap:16px}
@media(max-width:720px){.grid{grid-template-columns:1fr}.bar{flex-wrap:wrap;gap:10px}}
label{display:block;font-size:.82rem;color:var(--muted);margin:12px 0 5px;font-weight:600}
input,select{width:100%;padding:10px 12px;border:1px solid var(--line);border-radius:8px;font:inherit;background:#fff}
input:focus,select:focus{outline:2px solid var(--teal);border-color:var(--teal)}
button,.button{background:var(--navy2);color:#fff;border:0;padding:11px 18px;border-radius:8px;font:inherit;font-weight:700;cursor:pointer;margin-top:16px}
button:hover{background:var(--navy)}
table{width:100%;border-collapse:collapse}th,td{text-align:left;padding:10px 12px;border-bottom:1px solid var(--line);font-size:.92rem}
th{color:var(--muted);font-size:.74rem;text-transform:uppercase;letter-spacing:.05em}
.num{text-align:right;font-variant-numeric:tabular-nums}
.pos{color:var(--good)}.neg{color:var(--bad)}
.flash{padding:11px 15px;border-radius:9px;margin:0 0 18px;font-size:.92rem;border:1px solid}
.flash.ok{background:#eafaf1;border-color:#bfe9cf;color:#0b6b3a}.flash.err{background:#fdecec;border-color:#f3c3c3;color:#9b2222}.flash.warn{background:#fdf6e3;border-color:#efe0b0;color:#775c06}
.hero{background:linear-gradient(135deg,var(--navy),#163e66);color:#fff;border-radius:16px;padding:40px 32px;margin-bottom:22px}
.hero h1{font-size:2rem;margin-bottom:10px}.hero p{color:#cfe0ee;max-width:560px}
.hero .button{display:inline-block;background:var(--teal);color:#042b2a;margin-top:18px}
.hero-split{display:grid;grid-template-columns:1.25fr .85fr;gap:30px;align-items:center}
@media(max-width:820px){.hero-split{grid-template-columns:1fr}}
.hero-login{background:#fff;color:var(--ink);border-radius:14px;padding:22px 22px 24px}
.hero-login h3{margin:0 0 2px;font-size:1.1rem}.hero-login .muted{font-size:.85rem;margin:0 0 6px}
.hero-login button{width:100%}
.tiles{display:grid;grid-template-columns:repeat(3,1fr);gap:14px}@media(max-width:720px){.tiles{grid-template-columns:1fr}}
.tile .n{font-size:1.5rem;font-weight:800}.tile .l{color:var(--muted);font-size:.82rem}
.right{display:flex;justify-content:flex-end;gap:10px}
.muted{color:var(--muted)}.pill{display:inline-block;padding:2px 9px;border-radius:999px;background:#eef3f8;color:var(--navy2);font-size:.75rem;font-weight:700}
.site-footer{background:var(--navy);color:#c6d5e4;margin-top:44px}
.site-footer .cols{max-width:1040px;margin:0 auto;padding:40px 20px 24px;display:grid;grid-template-columns:1.5fr 1fr 1fr 1fr 1fr;gap:22px}
@media(max-width:820px){.site-footer .cols{grid-template-columns:1fr 1fr}}
.site-footer h4{color:#fff;font-size:.78rem;text-transform:uppercase;letter-spacing:.06em;margin:0 0 10px}
.site-footer a{display:block;color:#c6d5e4;font-size:.88rem;padding:4px 0;text-decoration:none}.site-footer a:hover{color:#fff;text-decoration:underline}
.site-footer .about .fbrand{color:#fff;font-weight:800;font-size:1.02rem;display:flex;align-items:center;gap:8px}
.site-footer .about .fmark{width:22px;height:22px;border-radius:6px;background:linear-gradient(135deg,var(--teal),#3bd1c9);display:inline-block}
.site-footer .about p{font-size:.86rem;line-height:1.6;color:#aebfd1;margin:10px 0 0}
.site-footer .social{display:flex;gap:9px;margin-top:14px}
.site-footer .social a{display:inline-flex;width:34px;height:34px;align-items:center;justify-content:center;border:1px solid #2c4f72;border-radius:8px;padding:0;font-weight:700;font-size:.8rem}
.site-footer .legal{border-top:1px solid #1c3e5e}
.site-footer .legal .inner{max-width:1040px;margin:0 auto;padding:16px 20px;display:flex;flex-wrap:wrap;gap:12px;justify-content:space-between;align-items:center;font-size:.78rem;color:#8ba3bc}
.site-footer .legal a{display:inline;color:#8ba3bc}.site-footer .badges{display:flex;gap:16px;flex-wrap:wrap}
</style></head><body>
<header><div class="bar"><a class="brand" href="/"><span class="mark"></span>Finara</a><nav>${nav}</nav></div></header>
<main>${flashHtml}${main}</main>
${siteFooter()}
</body></html>`;
}

function field(label, name, opts = {}) {
  const { type = 'text', value = '', ph = '', testid = '', required = true, step = '' } = opts;
  return `<label for="${name}">${esc(label)}</label>
<input id="${name}" name="${name}" type="${type}" value="${esc(value)}"${ph ? ` placeholder="${esc(ph)}"` : ''}${testid ? ` data-testid="${testid}"` : ''}${step ? ` step="${step}"` : ''}${required ? ' required' : ''}>`;
}
function accountOptions(uid, sel) {
  return userAccounts(uid).map((a) => `<option value="${a.id}"${a.id === sel ? ' selected' : ''}>${a.type} ••${a.id.slice(-4)} — ${money(a.balance)}</option>`).join('');
}

// ---------------------------------------------------------------- pages (public)
function pageHome(user) {
  const heroRight = user
    ? `<div class="hero-login"><h3>Welcome back, ${esc(user.firstName)}</h3><p class="muted">Jump straight back into your accounts.</p>
       <a class="button" href="/dashboard" style="display:block;text-align:center;box-sizing:border-box">Go to your dashboard</a></div>`
    : `<div class="hero-login"><h3>Log in</h3><p class="muted">Access your accounts. Demo: <b>demo</b> / <b>demo123</b></p>
       <form method="POST" action="/login">
         ${field('Username', 'username', { testid: 'home-username' })}
         ${field('Password', 'password', { type: 'password', testid: 'home-password' })}
         <button type="submit" data-testid="home-login">Log in</button>
       </form>
       <p class="muted" style="margin-top:12px;text-align:center">New to Finara? <a href="/register" data-testid="home-register">Create an account</a></p></div>`;
  const main = `
<div class="hero hero-split">
  <div class="hero-main">
    <span class="pill" style="background:#17507f;color:#bfe8e4">FDIC-style demo</span>
    <h1>Banking that moves at your speed.</h1>
    <p>Open an account in minutes, move money with confidence, and see every transaction in one clean place.</p>
    <a class="button" href="/register" data-testid="hero-open">Open an account</a>
  </div>
  ${heroRight}
</div>
<div class="tiles">
  <div class="card tile"><div class="n">2.5%</div><div class="l">APY on savings</div></div>
  <div class="card tile"><div class="n">$0</div><div class="l">Monthly fees</div></div>
  <div class="card tile"><div class="n">24/7</div><div class="l">Account access</div></div>
</div>
<div class="grid">
  <div class="card"><h2>What you can do</h2>
    <ul class="muted"><li>Open checking &amp; savings accounts</li><li>Transfer funds between accounts</li><li>Pay bills to any payee</li><li>Search your transaction history</li><li>Apply for a loan</li></ul>
    <a class="button" href="/services">Explore our services</a></div>
  <div class="card"><h2>Estimate a loan payment</h2>
    <p class="muted">No account needed — try the calculator.</p>
    <a class="button" href="/calculator" data-testid="home-calc">Open loan calculator</a></div>
</div>`;
  return layout('Home', user, main);
}

function pageServices(user) {
  const main = `<h1>Services</h1><p class="sub">Everything Finara offers.</p>
<div class="grid">
  <div class="card"><h2>Checking</h2><p class="muted">No-fee everyday checking with instant transfers and bill pay.</p></div>
  <div class="card"><h2>Savings</h2><p class="muted">2.5% APY, no minimum balance, interest paid monthly.</p></div>
  <div class="card"><h2>Loans</h2><p class="muted">Personal and auto loans with fast online decisions. <a href="/calculator">Estimate a payment →</a></p></div>
  <div class="card"><h2>Security</h2><p class="muted">Session-based sign-in and account-level access controls.</p></div>
</div>`;
  return layout('Services', user, main);
}

function pageCalculator(user, q) {
  let result = '';
  const amt = q.amount, rate = q.rate, years = q.years;
  if (amt && rate && years) {
    const P = parseFloat(amt), r = parseFloat(rate) / 100 / 12, n = parseInt(years, 10) * 12;
    if (P > 0 && n > 0) {
      const m = r === 0 ? P / n : (P * r * Math.pow(1 + r, n)) / (Math.pow(1 + r, n) - 1);
      const total = m * n;
      result = `<div class="card" data-testid="calc-result"><h2>Estimated payment</h2>
        <div class="tiles"><div class="tile"><div class="n" data-testid="calc-monthly">$${m.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</div><div class="l">per month</div></div>
        <div class="tile"><div class="n">$${total.toLocaleString('en-US', { maximumFractionDigits: 0 })}</div><div class="l">total of payments</div></div>
        <div class="tile"><div class="n">$${(total - P).toLocaleString('en-US', { maximumFractionDigits: 0 })}</div><div class="l">total interest</div></div></div></div>`;
    }
  }
  const main = `<h1>Loan calculator</h1><p class="sub">Estimate a monthly payment. No sign-in required.</p>
<div class="card"><form method="GET" action="/calculator">
  ${field('Loan amount ($)', 'amount', { type: 'number', value: amt || '25000', testid: 'calc-amount', step: '0.01' })}
  ${field('Annual interest rate (%)', 'rate', { type: 'number', value: rate || '6.5', testid: 'calc-rate', step: '0.01' })}
  ${field('Term (years)', 'years', { type: 'number', value: years || '5', testid: 'calc-years' })}
  <button type="submit" data-testid="calc-submit">Calculate</button>
</form></div>${result}`;
  return layout('Loan Calculator', user, main);
}

function pageLogin(user, flash, prefill = '') {
  const main = `<h1>Log in</h1><p class="sub">Use the demo account: <b>demo</b> / <b>demo123</b></p>
<div class="card" style="max-width:440px"><form method="POST" action="/login">
  ${field('Username', 'username', { value: prefill, testid: 'login-username' })}
  ${field('Password', 'password', { type: 'password', testid: 'login-password' })}
  <button type="submit" data-testid="login-submit">Log in</button>
</form><p class="muted" style="margin-top:14px">No account? <a href="/register">Open one</a>.</p></div>`;
  return layout('Log in', user, main, flash);
}

function pageRegister(user, flash, v = {}) {
  const main = `<h1>Open an account</h1><p class="sub">Create your Finara login. A checking account is opened for you.</p>
<div class="card" style="max-width:560px"><form method="POST" action="/register">
  <div class="grid">
    <div>${field('First name', 'firstName', { value: v.firstName, testid: 'reg-first' })}</div>
    <div>${field('Last name', 'lastName', { value: v.lastName, testid: 'reg-last' })}</div>
  </div>
  ${field('Email', 'email', { type: 'email', value: v.email, testid: 'reg-email' })}
  ${field('Username', 'username', { value: v.username, testid: 'reg-username' })}
  <div class="grid">
    <div>${field('Password', 'password', { type: 'password', testid: 'reg-password' })}</div>
    <div>${field('Confirm password', 'confirm', { type: 'password', testid: 'reg-confirm' })}</div>
  </div>
  ${field('Opening deposit ($)', 'deposit', { type: 'number', value: v.deposit || '100', required: false, testid: 'reg-deposit', step: '0.01' })}
  <button type="submit" data-testid="register-submit">Create account</button>
</form></div>`;
  return layout('Open an account', user, main, flash);
}

// ---------------------------------------------------------------- pages (gated)
function pageDashboard(user, flash) {
  const accs = userAccounts(user.id);
  const total = accs.reduce((s, a) => s + (a.type === 'Loan' ? 0 : a.balance), 0);
  const rows = accs.map((a) => `<tr><td><a href="/transactions?account=${a.id}">${a.type} ••${a.id.slice(-4)}</a></td>
    <td class="muted">${a.type === 'Loan' ? 'Loan balance' : 'Available'}</td>
    <td class="num ${a.balance < 0 ? 'neg' : ''}" data-testid="balance-${a.id}">${money(a.balance)}</td></tr>`).join('');
  const main = `<h1>Accounts overview</h1><p class="sub">Welcome back, ${esc(user.firstName)}.</p>
<div class="card"><table><thead><tr><th>Account</th><th>Type</th><th class="num">Balance</th></tr></thead>
  <tbody>${rows}</tbody>
  <tfoot><tr><th>Total deposits</th><th></th><th class="num" data-testid="total-balance">${money(total)}</th></tr></tfoot></table>
  <div class="right"><a class="button" href="/accounts/open" data-testid="open-account">Open new account</a></div></div>
<div class="grid">
  <div class="card"><h2>Move money</h2><p class="muted">Transfer between your accounts or pay a bill.</p><a href="/transfer">Transfer funds →</a> &nbsp; <a href="/billpay">Pay a bill →</a></div>
  <div class="card"><h2>Recent activity</h2><p class="muted">Search and review every transaction.</p><a href="/transactions">View activity →</a></div>
</div>`;
  return layout('Accounts', user, main, flash);
}

function pageOpenAccount(user, flash) {
  const main = `<h1>Open a new account</h1><p class="sub">Fund it from one of your existing accounts.</p>
<div class="card" style="max-width:520px"><form method="POST" action="/accounts/open">
  <label for="type">What type of account would you like to open?</label>
  <select id="type" name="type" data-testid="open-type"><option value="Checking">Checking</option><option value="Savings">Savings</option></select>
  <label for="from">Funding account</label>
  <select id="from" name="from" data-testid="open-from">${accountOptions(user.id)}</select>
  ${field('Opening deposit ($)', 'deposit', { type: 'number', value: '25', testid: 'open-deposit', step: '0.01' })}
  <button type="submit" data-testid="open-submit">Open account</button>
</form></div>`;
  return layout('Open account', user, main, flash);
}

function pageTransfer(user, flash) {
  const main = `<h1>Transfer funds</h1><p class="sub">Move money between your accounts.</p>
<div class="card" style="max-width:520px"><form method="POST" action="/transfer">
  ${field('Amount ($)', 'amount', { type: 'number', value: '', ph: '0.00', testid: 'transfer-amount', step: '0.01' })}
  <label for="from">From account</label><select id="from" name="from" data-testid="transfer-from">${accountOptions(user.id)}</select>
  <label for="to">To account</label><select id="to" name="to" data-testid="transfer-to">${accountOptions(user.id, userAccounts(user.id)[1] && userAccounts(user.id)[1].id)}</select>
  <button type="submit" data-testid="transfer-submit">Transfer</button>
</form></div>`;
  return layout('Transfer', user, main, flash);
}

function pageBillpay(user, flash) {
  const main = `<h1>Bill pay</h1><p class="sub">Send a payment to any payee.</p>
<div class="card" style="max-width:560px"><form method="POST" action="/billpay">
  ${field('Payee name', 'payee', { testid: 'bill-payee', ph: 'e.g. ComEd' })}
  ${field('Payee account number', 'payeeAcct', { testid: 'bill-acct' })}
  ${field('Amount ($)', 'amount', { type: 'number', ph: '0.00', testid: 'bill-amount', step: '0.01' })}
  <label for="from">Pay from</label><select id="from" name="from" data-testid="bill-from">${accountOptions(user.id)}</select>
  <button type="submit" data-testid="bill-submit">Send payment</button>
</form></div>`;
  return layout('Bill Pay', user, main, flash);
}

function pageTransactions(user, q, flash) {
  const accs = userAccounts(user.id);
  const sel = q.account || (accs[0] && accs[0].id);
  const minC = q.min ? toCents(q.min) : null, maxC = q.max ? toCents(q.max) : null;
  let list = accountTxns(sel);
  if (minC != null) list = list.filter((t) => Math.abs(t.amount) >= minC);
  if (maxC != null) list = list.filter((t) => Math.abs(t.amount) <= maxC);
  const rows = list.length ? list.map((t) => `<tr><td class="muted">${t.date.slice(0, 10)}</td><td>${esc(t.description)}</td><td><span class="pill">${t.type}</span></td>
    <td class="num ${t.amount < 0 ? 'neg' : 'pos'}">${money(t.amount)}</td><td class="num muted">${money(t.balanceAfter)}</td></tr>`).join('')
    : `<tr><td colspan="5" class="muted" data-testid="no-txns">No transactions match your search.</td></tr>`;
  const opts = accs.map((a) => `<option value="${a.id}"${a.id === sel ? ' selected' : ''}>${a.type} ••${a.id.slice(-4)}</option>`).join('');
  const main = `<h1>Account activity</h1><p class="sub">Search and review transactions.</p>
<div class="card"><form method="GET" action="/transactions" class="grid" style="grid-template-columns:2fr 1fr 1fr auto;align-items:end;gap:12px">
  <div><label for="account">Account</label><select id="account" name="account" data-testid="txn-account">${opts}</select></div>
  <div>${field('Min amount ($)', 'min', { type: 'number', value: q.min || '', required: false, testid: 'txn-min', step: '0.01' })}</div>
  <div>${field('Max amount ($)', 'max', { type: 'number', value: q.max || '', required: false, testid: 'txn-max', step: '0.01' })}</div>
  <div><button type="submit" data-testid="txn-search" style="margin:0">Search</button></div>
</form></div>
<div class="card"><table><thead><tr><th>Date</th><th>Description</th><th>Type</th><th class="num">Amount</th><th class="num">Balance</th></tr></thead>
  <tbody data-testid="txn-rows">${rows}</tbody></table></div>`;
  return layout('Activity', user, main, flash);
}

function pageProfile(user, flash) {
  const main = `<h1>Profile &amp; contact info</h1><p class="sub">Keep your details up to date.</p>
<div class="card" style="max-width:560px"><form method="POST" action="/profile">
  <div class="grid"><div>${field('First name', 'firstName', { value: user.firstName, testid: 'prof-first' })}</div><div>${field('Last name', 'lastName', { value: user.lastName, testid: 'prof-last' })}</div></div>
  ${field('Email', 'email', { type: 'email', value: user.email, testid: 'prof-email' })}
  ${field('Phone', 'phone', { value: user.phone, required: false, testid: 'prof-phone' })}
  ${field('Address', 'address', { value: user.address, required: false, testid: 'prof-address' })}
  <button type="submit" data-testid="profile-submit">Save changes</button>
</form></div>`;
  return layout('Profile', user, main, flash);
}

function pageLoan(user, flash) {
  const main = `<h1>Request a loan</h1><p class="sub">Fast online decision. A down payment of at least 20% is required for approval.</p>
<div class="card" style="max-width:520px"><form method="POST" action="/loan">
  ${field('Loan amount ($)', 'amount', { type: 'number', value: '15000', testid: 'loan-amount', step: '0.01' })}
  ${field('Down payment ($)', 'down', { type: 'number', value: '3000', testid: 'loan-down', step: '0.01' })}
  <label for="to">Deposit funds to</label><select id="to" name="to" data-testid="loan-to">${accountOptions(user.id)}</select>
  <button type="submit" data-testid="loan-submit">Apply for loan</button>
</form></div>`;
  return layout('Loans', user, main, flash);
}

// ---------------------------------------------------------------- global footer
function siteFooter() {
  return `<footer class="site-footer">
  <div class="cols">
    <div class="about">
      <div class="fbrand"><span class="fmark"></span>Finara</div>
      <p>Simple, modern banking built for everyday life — open an account, move money, and stay on top of every transaction.</p>
      <div class="social"><a href="/about" aria-label="LinkedIn" title="LinkedIn">in</a><a href="/about" aria-label="X" title="X">X</a><a href="/about" aria-label="Facebook" title="Facebook">f</a></div>
    </div>
    <div><h4>Company</h4><a href="/about">About us</a><a href="/careers">Careers</a><a href="/contact">Contact</a><a href="/locations">Locations &amp; ATMs</a></div>
    <div><h4>Products</h4><a href="/services">Checking</a><a href="/services">Savings</a><a href="/calculator">Loans</a><a href="/calculator">Loan calculator</a></div>
    <div><h4>Support</h4><a href="/faq">Help center</a><a href="/security">Security</a><a href="/contact">Contact us</a><a href="/login">Log in</a></div>
    <div><h4>Legal</h4><a href="/privacy">Privacy policy</a><a href="/terms">Terms of service</a><a href="/accessibility">Accessibility</a><a href="/terms">Disclosures</a></div>
  </div>
  <div class="legal"><div class="inner">
    <div class="badges"><span>© 2026 Finara · Member FDIC</span><span>Equal Housing Lender</span><span>Routing&nbsp;#000000000</span></div>
    <div>Demo application for QA automation — not a real bank. <a href="/privacy">Privacy</a> · <a href="/terms">Terms</a></div>
  </div></div>
</footer>`;
}

// ---------------------------------------------------------------- content pages (footer / company)
function contentPage(user, title, bodyHtml, flash) { return layout(title, user, `<h1>${esc(title)}</h1>${bodyHtml}`, flash); }
const CONTENT = {
  about: { title: 'About Finara', html: `<p class="sub">Banking that respects your time.</p>
    <div class="grid"><div class="card"><h2>Our mission</h2><p class="muted">We build straightforward money tools without the fees and friction of traditional banks. Finara is a demonstration application created to showcase an end-to-end QA automation pipeline.</p></div>
    <div class="card"><h2>By the numbers</h2><div class="tiles"><div class="tile"><div class="n">2.5%</div><div class="l">Savings APY</div></div><div class="tile"><div class="n">$0</div><div class="l">Monthly fees</div></div><div class="tile"><div class="n">24/7</div><div class="l">Access</div></div></div></div></div>
    <div class="card"><h2>Newsroom</h2><ul class="muted"><li>Finara launches its modern online banking experience.</li><li>New: instant transfers between your accounts.</li><li>Loan calculator now available to everyone, no sign-in required.</li></ul></div>` },
  careers: { title: 'Careers', html: `<p class="sub">Help us build better banking.</p>
    <div class="card"><h2>Open roles</h2><table><thead><tr><th>Role</th><th>Team</th><th>Location</th></tr></thead>
    <tbody><tr><td>Senior QA Automation Engineer</td><td>Quality</td><td>Remote / Chicago</td></tr><tr><td>Backend Engineer</td><td>Platform</td><td>Remote</td></tr><tr><td>Product Designer</td><td>Design</td><td>Remote</td></tr></tbody></table>
    <p class="muted" style="margin-top:14px">Interested? <a href="/contact">Get in touch</a>.</p></div>` },
  faq: { title: 'Help Center', html: `<p class="sub">Answers to common questions.</p>
    <div class="card"><h2>How do I open an account?</h2><p class="muted">Choose <a href="/register">Open account</a>, enter your details, and you're ready in minutes.</p></div>
    <div class="card"><h2>How do transfers work?</h2><p class="muted">From the dashboard, choose <a href="/transfer">Transfer</a>, pick your accounts and an amount. Funds move instantly between your Finara accounts.</p></div>
    <div class="card"><h2>Is there a fee?</h2><p class="muted">No monthly fees on checking or savings. Loan rates vary — try the <a href="/calculator">calculator</a>.</p></div>
    <div class="card"><h2>I forgot my password</h2><p class="muted">Contact support from the <a href="/contact">Contact</a> page and we'll help you recover access.</p></div>` },
  locations: { title: 'Locations & ATMs', html: `<p class="sub">Find a branch or a fee-free ATM.</p>
    <div class="card"><form method="GET" action="/locations"><label for="zip">Search by ZIP code</label><div class="grid" style="grid-template-columns:1fr auto;gap:12px;align-items:end"><div><input id="zip" name="zip" type="text" placeholder="60601"></div><div><button type="submit" style="margin:0">Search</button></div></div></form></div>
    <div class="grid"><div class="card"><h2>Chicago — Loop</h2><p class="muted">500 W Madison St, Chicago, IL 60661<br>Mon–Fri 9am–5pm · ATM 24/7</p></div>
    <div class="card"><h2>Chicago — River North</h2><p class="muted">320 W Illinois St, Chicago, IL 60654<br>Mon–Fri 9am–5pm · ATM 24/7</p></div></div>` },
  security: { title: 'Security Center', html: `<p class="sub">How we protect your account.</p>
    <div class="grid"><div class="card"><h2>Our safeguards</h2><ul class="muted"><li>Session-based sign-in with HttpOnly cookies</li><li>Account-level access controls</li><li>Output encoding to prevent injection</li></ul></div>
    <div class="card"><h2>Protect yourself</h2><ul class="muted"><li>Never share your password</li><li>Always log out on shared devices</li><li>Report anything suspicious via <a href="/contact">Contact</a></li></ul></div></div>` },
  privacy: { title: 'Privacy Policy', html: `<p class="sub">Last updated November 2026</p>
    <div class="card"><p class="muted">This is a demonstration application. Finara collects only the information needed to operate the demo (name, email, and account activity you create). No real personal or financial data is processed, and the in-memory data resets when the server restarts. We do not sell data or share it with third parties. Questions? Visit <a href="/contact">Contact</a>.</p></div>` },
  terms: { title: 'Terms of Service', html: `<p class="sub">Last updated November 2026</p>
    <div class="card"><p class="muted">Finara is a demo application provided "as is," for software testing and demonstration only. It is not a real bank, holds no real funds, and offers no real financial products. By using it you agree it carries no warranty and creates no banking relationship. See also our <a href="/privacy">Privacy Policy</a> and <a href="/accessibility">Accessibility</a> statement.</p></div>` },
  accessibility: { title: 'Accessibility', html: `<p class="sub">Everyone should be able to bank with ease.</p>
    <div class="card"><p class="muted">Finara is built with semantic HTML: every form control has a label, actionable controls expose clear names, and the site is keyboard-navigable. We aim to meet WCAG 2.1 AA. Found a barrier? Tell us via <a href="/contact">Contact</a>.</p></div>` },
};
function pageContact(user, flash) {
  const main = `<h1>Contact us</h1><p class="sub">We're here to help.</p>
<div class="grid">
  <div class="card"><h2>Reach us</h2><p class="muted">Phone: 1-800-555-0100<br>Email: support@finara.test<br>Mail: 500 W Madison St, Chicago, IL 60661</p></div>
  <div class="card"><h2>Send a message</h2><form method="POST" action="/contact">
    ${field('Your name', 'name', { testid: 'contact-name' })}
    ${field('Email', 'email', { type: 'email', testid: 'contact-email' })}
    <label for="message">Message</label><textarea id="message" name="message" rows="4" style="width:100%;padding:10px 12px;border:1px solid var(--line);border-radius:8px;font:inherit" required></textarea>
    <button type="submit" data-testid="contact-submit">Send message</button>
  </form></div>
</div>`;
  return layout('Contact', user, main, flash);
}

// ---------------------------------------------------------------- router
const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, `http://localhost:${PORT}`);
  const path = u.pathname;
  const q = Object.fromEntries(u.searchParams);
  const user = sessionUser(req);
  const flash = q.ok ? { kind: 'ok', msg: q.ok } : q.err ? { kind: 'err', msg: q.err } : q.warn ? { kind: 'warn', msg: q.warn } : null;
  const gated = ['/dashboard', '/accounts/open', '/transfer', '/billpay', '/transactions', '/profile', '/loan'];
  if (gated.includes(path) && !user) return redirect(res, '/login?warn=' + encodeURIComponent('Please log in to continue.'));

  // ---- GET pages
  if (req.method === 'GET') {
    switch (path) {
      case '/': return send(res, pageHome(user));
      case '/services': return send(res, pageServices(user));
      case '/about': case '/careers': case '/faq': case '/locations': case '/security': case '/privacy': case '/terms': case '/accessibility': { const c = CONTENT[path.slice(1)]; return send(res, contentPage(user, c.title, c.html, flash)); }
      case '/contact': return send(res, pageContact(user, flash));
      case '/calculator': return send(res, pageCalculator(user, q));
      case '/login': return send(res, pageLogin(user, flash));
      case '/register': return send(res, pageRegister(user, flash));
      case '/dashboard': return send(res, pageDashboard(user, flash));
      case '/accounts/open': return send(res, pageOpenAccount(user, flash));
      case '/transfer': return send(res, pageTransfer(user, flash));
      case '/billpay': return send(res, pageBillpay(user, flash));
      case '/transactions': return send(res, pageTransactions(user, q, flash));
      case '/profile': return send(res, pageProfile(user, flash));
      case '/loan': return send(res, pageLoan(user, flash));
      case '/logout': { const sid = cookies(req).sid; if (sid) sessions.delete(sid); return redirect(res, '/?ok=' + encodeURIComponent('You have been logged out.'), { 'Set-Cookie': 'sid=; Path=/; Max-Age=0' }); }
      case '/health': return send(res, 'ok');
    }
    return send(res, layout('Not found', user, '<h1>404</h1><p class="sub">That page does not exist.</p><a href="/">Back home</a>'), 404);
  }

  // ---- POST actions
  if (req.method === 'POST') {
    const f = await body(req);
    if (path === '/login') {
      const uid = byUsername.get(String(f.username || '').toLowerCase());
      const acc = uid && users.get(uid);
      if (acc && acc.pass === hash(f.password)) {
        const sid = crypto.randomBytes(18).toString('hex'); sessions.set(sid, uid);
        return redirect(res, '/dashboard', { 'Set-Cookie': `sid=${sid}; Path=/; HttpOnly; SameSite=Lax` });
      }
      return send(res, pageLogin(user, { kind: 'err', msg: 'Invalid username or password.' }, f.username), 401);
    }
    if (path === '/register') {
      const need = ['firstName', 'lastName', 'email', 'username', 'password', 'confirm'];
      if (need.some((k) => !String(f[k] || '').trim())) return send(res, pageRegister(user, { kind: 'err', msg: 'All fields except opening deposit are required.' }, f), 400);
      if (f.password !== f.confirm) return send(res, pageRegister(user, { kind: 'err', msg: 'Passwords do not match.' }, f), 400);
      if (byUsername.has(String(f.username).toLowerCase())) return send(res, pageRegister(user, { kind: 'err', msg: 'That username is already taken.' }, f), 409);
      const dep = Math.max(0, toCents(f.deposit || '0') || 0);
      const uid = createUser({ username: f.username, password: f.password, firstName: f.firstName, lastName: f.lastName, email: f.email });
      const chk = openAccount(uid, 'Checking', 0); if (dep > 0) post(chk, 'Deposit', 'Opening deposit', dep);
      const sid = crypto.randomBytes(18).toString('hex'); sessions.set(sid, uid);
      return redirect(res, '/dashboard', { 'Set-Cookie': `sid=${sid}; Path=/; HttpOnly; SameSite=Lax` });
    }
    if (path === '/contact') {
      if (!String(f.name || '').trim() || !String(f.message || '').trim()) return redirect(res, '/contact?err=' + encodeURIComponent('Name and message are required.'));
      return redirect(res, '/contact?ok=' + encodeURIComponent('Thanks — we\'ll be in touch shortly.'));
    }
    if (!user) return redirect(res, '/login');

    if (path === '/transfer') {
      const amt = toCents(f.amount), from = accounts.get(f.from), to = accounts.get(f.to);
      if (!from || !to || from.userId !== user.id || to.userId !== user.id) return redirect(res, '/transfer?err=' + encodeURIComponent('Pick valid accounts.'));
      if (f.from === f.to) return redirect(res, '/transfer?err=' + encodeURIComponent('Choose two different accounts.'));
      if (!(amt > 0)) return redirect(res, '/transfer?err=' + encodeURIComponent('Enter an amount greater than zero.'));
      if (amt > from.balance) return redirect(res, '/transfer?err=' + encodeURIComponent('Insufficient funds in the source account.'));
      post(from.id, 'Transfer', `Transfer to ${to.type} ••${to.id.slice(-4)}`, -amt);
      post(to.id, 'Transfer', `Transfer from ${from.type} ••${from.id.slice(-4)}`, amt);
      return redirect(res, '/dashboard?ok=' + encodeURIComponent(`Transferred ${money(amt)} successfully.`));
    }
    if (path === '/billpay') {
      const amt = toCents(f.amount), from = accounts.get(f.from);
      if (!from || from.userId !== user.id) return redirect(res, '/billpay?err=' + encodeURIComponent('Pick a valid account.'));
      if (!String(f.payee || '').trim()) return redirect(res, '/billpay?err=' + encodeURIComponent('Enter a payee name.'));
      if (!(amt > 0)) return redirect(res, '/billpay?err=' + encodeURIComponent('Enter an amount greater than zero.'));
      if (amt > from.balance) return redirect(res, '/billpay?err=' + encodeURIComponent('Insufficient funds for this payment.'));
      post(from.id, 'Payment', `Bill pay — ${f.payee}`, -amt);
      return redirect(res, '/dashboard?ok=' + encodeURIComponent(`Paid ${money(amt)} to ${f.payee}.`));
    }
    if (path === '/accounts/open') {
      const from = accounts.get(f.from), dep = Math.max(0, toCents(f.deposit || '0') || 0);
      if (!from || from.userId !== user.id) return redirect(res, '/accounts/open?err=' + encodeURIComponent('Pick a valid funding account.'));
      if (dep > from.balance) return redirect(res, '/accounts/open?err=' + encodeURIComponent('Insufficient funds for the opening deposit.'));
      const nid = openAccount(user.id, f.type === 'Savings' ? 'Savings' : 'Checking', 0);
      if (dep > 0) { post(from.id, 'Transfer', `Opening deposit to ${f.type}`, -dep); post(nid, 'Deposit', 'Opening deposit', dep); }
      return redirect(res, '/dashboard?ok=' + encodeURIComponent(`Opened a new ${f.type} account.`));
    }
    if (path === '/profile') {
      Object.assign(user, { firstName: f.firstName || user.firstName, lastName: f.lastName || user.lastName, email: f.email || user.email, phone: f.phone || '', address: f.address || '' });
      return redirect(res, '/profile?ok=' + encodeURIComponent('Your profile has been updated.'));
    }
    if (path === '/loan') {
      const amt = toCents(f.amount), down = toCents(f.down), to = accounts.get(f.to);
      if (!to || to.userId !== user.id) return redirect(res, '/loan?err=' + encodeURIComponent('Pick a valid deposit account.'));
      if (!(amt > 0)) return redirect(res, '/loan?err=' + encodeURIComponent('Enter a loan amount greater than zero.'));
      if (down >= amt * 0.2) {
        const lid = openAccount(user.id, 'Loan', -amt);
        post(lid, 'Credit', 'Loan principal', 0);
        post(to.id, 'Deposit', 'Loan disbursement', amt);
        return redirect(res, '/dashboard?ok=' + encodeURIComponent(`Loan approved — ${money(amt)} disbursed.`));
      }
      return redirect(res, '/loan?err=' + encodeURIComponent('Loan denied: down payment must be at least 20% of the amount.'));
    }
    return send(res, layout('Not found', user, '<h1>404</h1>'), 404);
  }

  res.writeHead(405); res.end('Method Not Allowed');
});

server.listen(PORT, '0.0.0.0', () => console.log(`Finara running at http://localhost:${PORT}  (demo login: demo / demo123)`));
