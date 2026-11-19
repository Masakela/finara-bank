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

// Seeded defects (opt-in): DEFECTS=all or a comma list (e.g. DEFECTS=D5,D6) turns on
// intentional bugs so the STLC pipeline has real findings. Default (unset) = correct app.
// The answer key is DEFECTS.md. Backend-logic defects are read the same way in backends/sqlite.js.
const DEFECTS = new Set((process.env.DEFECTS || '').split(',').map((s) => s.trim()).filter(Boolean));
const bug = (id) => DEFECTS.has('all') || DEFECTS.has(id);

// ---------------------------------------------------------------- data store (SQLite or Oracle)
const { makeStore } = require('./store');
const store = makeStore();

// Per-request data for the (synchronous) page renderers. Each gated handler loads
// these from the store and then renders synchronously — no await in between — so
// the module-level view can't be clobbered by a concurrent request mid-render.
let _ACCS = [], _TXNS = {};
// Uploaded documents live in memory per customer (metadata + bytes). No DB/schema change, so
// both backends behave the same; it resets on restart, like the rest of the demo data.
const DOCS = new Map(); // String(userId) -> [{ id, name, size, type, docType, uploadedAt, data }]
let _DOC_SEQ = 1;
function userDocs(uid) { return DOCS.get(String(uid)) || []; }
function userAccounts() { return _ACCS; }
function accountTxns(accountId) { return _TXNS[accountId] || []; }

const money = (cents) => (cents < 0 ? '-' : '') + '$' + (Math.abs(cents) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const toCents = (dollars) => Math.round(parseFloat(dollars) * 100);

// Server-side numeric validation for money fields. Browsers restrict <input type="number">,
// but a client can POST anything, so the server is the real guard — and these rejections give
// the STLC pipeline concrete negative/boundary cases (letters, symbols, negatives, >2 decimals).
function amountOf(raw, { allowZero = false, label = 'Amount' } = {}) {
  const s = String(raw == null ? '' : raw).trim();
  if (s === '') return { error: `${label} is required.` };
  if (!/^-?\d*\.?\d+$/.test(s)) return { error: `${label} must be a number — digits only (e.g. 100.00), no letters or symbols.` };
  if (!/^-?\d*\.?\d{0,2}$/.test(s)) return { error: `${label} can have at most two decimal places.` };
  const n = parseFloat(s);
  if (n < 0) return { error: `${label} can't be negative.` };
  if (!allowZero && n === 0) return { error: `Enter ${label.toLowerCase()} greater than zero.` };
  return { cents: Math.round(n * 100) };
}
// Email + digits-only validators, same pattern: a specific message for every way the value is wrong,
// so every component surfaces a UI error instead of silently accepting or ignoring bad input.
function emailOf(raw, { required = true } = {}) {
  const s = String(raw == null ? '' : raw).trim();
  if (!s) return required ? { error: 'Email is required.' } : { value: '' };
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s)) return { error: 'Enter a valid email address (e.g. name@example.com).' };
  return { value: s };
}
function digitsOf(raw, { label = 'Value', required = true, min = 0, max = 0 } = {}) {
  const s = String(raw == null ? '' : raw).trim();
  if (!s) return required ? { error: `${label} is required.` } : { value: '' };
  if (!/^\d+$/.test(s)) return { error: `${label} must contain digits only — no letters, spaces, or symbols.` };
  if (min && s.length < min) return { error: `${label} must be at least ${min} digits.` };
  if (max && s.length > max) return { error: `${label} must be at most ${max} digits.` };
  return { value: s };
}

// ---------------------------------------------------------------- http helpers
function cookies(req) {
  const out = {}; (req.headers.cookie || '').split(';').forEach((c) => { const i = c.indexOf('='); if (i > 0) out[c.slice(0, i).trim()] = decodeURIComponent(c.slice(i + 1).trim()); });
  return out;
}
function body(req) { return new Promise((res) => { let d = ''; req.on('data', (c) => (d += c)); req.on('end', () => res(parseQs(d))); }); }
function send(res, html, status = 200, headers = {}) { res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', ...headers }); res.end(html); }
function redirect(res, loc, headers = {}) { res.writeHead(302, { Location: loc, ...headers }); res.end(); }
const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const csvCell = (v) => { const s = String(v == null ? '' : v); return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };

// ---- file upload: minimal multipart/form-data parser (no deps) + server-side validation
const UPLOAD_MAX = 5 * 1024 * 1024;            // 5 MB per file (advertised limit)
const UPLOAD_HARD = 12 * 1024 * 1024;          // hard stop so a huge upload can't exhaust the demo server
const ALLOWED_EXT = ['pdf', 'png', 'jpg', 'jpeg'];
function multipart(req) {
  return new Promise((resolve) => {
    const ct = req.headers['content-type'] || '';
    const m = ct.match(/boundary=(?:"([^"]+)"|([^;]+))/i);
    if (!m) return resolve({ fields: {}, files: [] });
    const bbuf = Buffer.from('--' + (m[1] || m[2]).trim());
    const chunks = []; let total = 0, aborted = false;
    req.on('data', (c) => { total += c.length; if (total > UPLOAD_HARD) aborted = true; if (!aborted) chunks.push(c); });
    req.on('end', () => {
      if (aborted) return resolve({ fields: {}, files: [], tooLarge: true });
      const buf = Buffer.concat(chunks);
      const fields = {}, files = [];
      let idx = buf.indexOf(bbuf);
      while (idx !== -1) {
        const next = buf.indexOf(bbuf, idx + bbuf.length);
        if (next === -1) break;
        const part = buf.slice(idx + bbuf.length + 2, next - 2); // skip CRLF after boundary, strip CRLF before next
        const sep = part.indexOf('\r\n\r\n');
        idx = next;
        if (sep === -1) continue;
        const header = part.slice(0, sep).toString('utf8');
        const content = part.slice(sep + 4);
        const nameM = header.match(/name="([^"]*)"/i);
        const fileM = header.match(/filename="([^"]*)"/i);
        const name = nameM ? nameM[1] : '';
        if (fileM) {
          const ctM = header.match(/content-type:\s*([^\r\n]+)/i);
          files.push({ field: name, filename: fileM[1], contentType: ctM ? ctM[1].trim() : 'application/octet-stream', data: content });
        } else { fields[name] = content.toString('utf8'); }
      }
      resolve({ fields, files });
    });
  });
}
// Validate an uploaded file: required, allowed type, non-empty, within size — specific messages give
// the STLC pipeline negative/boundary cases (missing file, wrong type, empty, too large).
function validateUpload(file) {
  if (!file || !file.filename) return { error: 'Please choose a file to upload.' };
  const ext = (file.filename.split('.').pop() || '').toLowerCase();
  if (!ALLOWED_EXT.includes(ext)) return { error: `Unsupported file type ".${ext}". Allowed types: PDF, PNG, JPG.` };
  if (!file.data || file.data.length === 0) return { error: 'The selected file is empty.' };
  if (file.data.length > UPLOAD_MAX) return { error: `File is too large (${(file.data.length / 1048576).toFixed(1)} MB). Maximum is 5 MB.` };
  return { ok: true };
}

// ---------------------------------------------------------------- layout + shared styles
function layout(title, user, main, flash) {
  const bell = `<button type="button" class="icon-btn" data-qa="notifications" title="Notifications"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.7 21a2 2 0 0 1-3.4 0"/></svg></button>`;
  const mail = `<button type="button" class="icon-btn" data-qa="messages" title="Messages"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 5h16v14H4z"/><path d="M4 7l8 6 8-6"/></svg></button>`;
  const nav = user
    ? `<a href="/dashboard">Accounts</a><a href="/transfer">Transfer</a><a href="/billpay">Bill Pay</a><a href="/transactions">Activity</a><a href="/loan">Loans</a><a href="/documents" data-testid="nav-documents">Documents</a><a href="/profile">Profile</a>${bell}${mail}<a class="ghost" href="/logout" data-testid="logout">Log out</a>`
    : `<div class="dropdown" data-testid="menu-products"><button type="button" class="dropbtn" data-qa="products-menu" aria-haspopup="true" aria-expanded="false">Products &#9662;</button><div class="dropdown-menu" role="menu"><a href="/services" role="menuitem" data-testid="menu-checking">Checking</a><a href="/services" role="menuitem" data-testid="menu-savings">Savings</a><a href="/calculator" role="menuitem" data-testid="menu-loans">Loans</a><a href="/rates" role="menuitem" data-testid="menu-rates">Rates &amp; offers</a></div></div><a href="/services">Personal</a><a href="/rates">Rates</a><a href="/faq">Help</a><a href="/about">About</a><a href="/login" data-testid="nav-login">Log in</a><a class="btn" href="/register" data-testid="nav-register">Open account</a>`;
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
nav .icon-btn{background:transparent;border:0;color:#dce7f1;cursor:pointer;padding:4px;margin:0;display:inline-flex;align-items:center}nav .icon-btn:hover{color:#fff}
nav a.btn{background:var(--teal);color:#042b2a;font-weight:700}nav a.ghost{border:1px solid #39597a;color:#fff}
main{max-width:1040px;margin:0 auto;padding:26px 20px 56px}
h1{font-size:1.5rem;margin:0 0 4px}h2{font-size:1.15rem;margin:26px 0 12px}
.sub{color:var(--muted);margin:0 0 20px}
.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:20px;margin-bottom:18px}
.grid{display:grid;grid-template-columns:1fr 1fr;gap:16px}
@media(max-width:720px){.grid{grid-template-columns:1fr}.bar{flex-wrap:wrap;gap:10px}}
label{display:block;font-size:.82rem;color:var(--muted);margin:12px 0 5px;font-weight:600}
input,select{width:100%;padding:10px 12px;border:1px solid var(--line);border-radius:8px;font:inherit;background:#fff}
input[type=file]{padding:8px;background:#f8fafc;cursor:pointer}
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
/* --- crawler-testable widgets: dropdowns, modal, cookie banner, cards, typeahead, sortable table --- */
.dropdown{position:relative;display:inline-block}
.dropdown .dropbtn{background:transparent;border:0;color:#dce7f1;font:inherit;font-size:.92rem;cursor:pointer;padding:0;margin:0;white-space:nowrap}
.dropdown .dropbtn:hover{color:#fff}
.dropdown-menu{position:absolute;top:150%;left:0;min-width:190px;background:#fff;border:1px solid var(--line);border-radius:10px;box-shadow:0 12px 34px rgba(11,46,79,.2);padding:6px;z-index:50;display:none}
.dropdown-menu a{display:block;color:var(--ink);padding:8px 12px;border-radius:7px;font-size:.9rem}
.dropdown-menu a:hover{background:#eef3f8;text-decoration:none}
.dropdown.open .dropdown-menu{display:block}
.cookie-banner{position:fixed;left:0;right:0;bottom:0;background:#0b2e4f;color:#e6eef6;padding:14px 20px;display:flex;flex-wrap:wrap;align-items:center;gap:14px;justify-content:center;z-index:200;box-shadow:0 -4px 18px rgba(0,0,0,.25);font-size:.9rem}
.cookie-banner a{color:#7fd6d0}
.cookie-banner .cookie-actions{display:flex;gap:10px}
.cookie-banner button{margin:0;padding:8px 14px;font-size:.85rem}
.cookie-banner .ghost-btn{background:transparent;border:1px solid #39597a;color:#fff}
.modal-overlay{position:fixed;inset:0;background:rgba(9,22,37,.55);display:flex;align-items:center;justify-content:center;z-index:300;padding:20px}
.modal-overlay[hidden],.cookie-banner[hidden],.ta-results[hidden]{display:none}
.modal{background:#fff;border-radius:16px;padding:30px 28px;max-width:420px;width:100%;position:relative;box-shadow:0 20px 60px rgba(0,0,0,.3)}
.modal h2{margin:8px 0 6px}
.modal-close{position:absolute;top:8px;right:12px;background:transparent;border:0;color:var(--muted);font-size:1.7rem;line-height:1;cursor:pointer;margin:0;padding:4px 8px}
.modal .button{display:inline-block}
.card-grid{display:grid;grid-template-columns:repeat(4,1fr);gap:16px}@media(max-width:820px){.card-grid{grid-template-columns:1fr 1fr}}@media(max-width:480px){.card-grid{grid-template-columns:1fr}}
.product-card{display:flex;flex-direction:column}.product-card h3{margin:6px 0 2px}.product-card .rate{font-size:1.6rem;font-weight:800;color:var(--navy2)}.product-card .button{margin-top:auto}
.typeahead{position:relative;max-width:460px}
.ta-results{list-style:none;margin:6px 0 0;padding:6px;position:absolute;left:0;right:0;background:#fff;border:1px solid var(--line);border-radius:10px;box-shadow:0 10px 30px rgba(11,46,79,.15);z-index:40;max-height:260px;overflow:auto}
.ta-results li{padding:9px 12px;border-radius:7px;cursor:pointer;font-size:.9rem}
.ta-results li:hover,.ta-results li.active{background:#eef3f8}
.ta-results li.ta-empty{color:var(--muted);cursor:default}
th .th-sort{background:transparent;border:0;color:inherit;font:inherit;text-transform:inherit;letter-spacing:inherit;cursor:pointer;padding:0;margin:0}
th[aria-sort="ascending"] .th-sort::after{content:" \\25B2";font-size:.7em}th[aria-sort="descending"] .th-sort::after{content:" \\25BC";font-size:.7em}
.deadlinks a{margin-right:18px;display:inline-block}
</style></head><body>
${DEFECTS.size ? '<div data-testid="defect-banner" style="background:#b8860b;color:#fff;text-align:center;padding:6px 12px;font-size:.8rem">⚠ Test build — seeded defects are enabled</div>' : ''}
<header><div class="bar"><a class="brand" href="/"><span class="mark"></span>Finara</a><nav>${nav}</nav></div></header>
<main data-component="app-main" data-qa="main">${flashHtml}${main}</main>
${siteFooter()}
<div id="cookie-banner" class="cookie-banner" data-testid="cookie-banner" role="region" aria-label="Cookie consent" hidden><span>Finara uses cookies to improve your experience. Read our <a href="/privacy">Privacy Policy</a>.</span><div class="cookie-actions"><button type="button" data-testid="cookie-accept">Accept all</button><button type="button" class="ghost-btn" data-testid="cookie-decline">Decline</button></div></div>
<script>${WIDGET_JS}</script>
</body></html>`;
}

// Inline JS powering the crawler-testable widgets. Each block self-guards, so pages
// without a given widget are unaffected. No external dependencies.
const WIDGET_JS = `(function(){
  var cb=document.getElementById('cookie-banner');
  if(cb){var seen=false;try{seen=localStorage.getItem('finara-cookie');}catch(e){}
    if(!seen)cb.hidden=false;
    cb.addEventListener('click',function(e){var b=e.target.closest('[data-testid=cookie-accept],[data-testid=cookie-decline]');if(!b)return;try{localStorage.setItem('finara-cookie',b.getAttribute('data-testid'));}catch(e){}cb.hidden=true;});
  }
  document.querySelectorAll('.dropdown').forEach(function(d){
    var btn=d.querySelector('.dropbtn');if(!btn)return;
    btn.addEventListener('click',function(e){e.stopPropagation();var open=d.classList.toggle('open');btn.setAttribute('aria-expanded',open?'true':'false');});
  });
  var ov=document.getElementById('promo-overlay');
  function closeModal(){if(ov)ov.hidden=true;}
  if(ov){setTimeout(function(){ov.hidden=false;},400);
    ov.addEventListener('click',function(e){if(e.target===ov||e.target.closest('[data-testid=promo-close],[data-testid=promo-dismiss-link]')){e.preventDefault();closeModal();}});
  }
  document.addEventListener('click',function(){document.querySelectorAll('.dropdown.open').forEach(function(d){d.classList.remove('open');var b=d.querySelector('.dropbtn');if(b)b.setAttribute('aria-expanded','false');});});
  document.addEventListener('keydown',function(e){if(e.key==='Escape'){document.querySelectorAll('.dropdown.open').forEach(function(d){d.classList.remove('open');});closeModal();}});
  var ti=document.querySelector('[data-testid=typeahead-input]');
  var tr=document.getElementById('ta-results');
  if(ti&&tr){
    var ITEMS=[];try{ITEMS=JSON.parse(ti.getAttribute('data-items')||'[]');}catch(e){}
    function render(list){
      if(!list.length){tr.innerHTML='<li class="ta-empty" data-testid="ta-empty">No matches</li>';tr.hidden=false;ti.setAttribute('aria-expanded','true');return;}
      tr.innerHTML=list.map(function(x){return '<li role="option" data-testid="ta-option" data-value="'+x.replace(/"/g,'&quot;')+'">'+x+'</li>';}).join('');
      tr.hidden=false;ti.setAttribute('aria-expanded','true');
    }
    ti.addEventListener('input',function(){var v=ti.value.trim().toLowerCase();if(!v){tr.hidden=true;ti.setAttribute('aria-expanded','false');return;}render(ITEMS.filter(function(x){return x.toLowerCase().indexOf(v)>-1;}).slice(0,8));});
    tr.addEventListener('click',function(e){var li=e.target.closest('[data-testid=ta-option]');if(!li)return;ti.value=li.getAttribute('data-value');tr.hidden=true;ti.setAttribute('aria-expanded','false');});
    document.addEventListener('click',function(e){if(e.target!==ti&&!tr.contains(e.target)){tr.hidden=true;ti.setAttribute('aria-expanded','false');}});
  }
  document.querySelectorAll('table.sortable').forEach(function(tbl){
    tbl.querySelectorAll('th[data-sort]').forEach(function(th){
      var colIndex=Array.prototype.indexOf.call(th.parentNode.children,th);
      th.addEventListener('click',function(){
        var dir=th.getAttribute('aria-sort')==='ascending'?'descending':'ascending';
        tbl.querySelectorAll('th').forEach(function(h){h.setAttribute('aria-sort','none');});
        th.setAttribute('aria-sort',dir);
        var tb=tbl.querySelector('tbody');var rows=Array.prototype.slice.call(tb.querySelectorAll('tr'));
        var num=th.getAttribute('data-sort')==='number';
        rows.sort(function(a,b){var x=a.children[colIndex].getAttribute('data-value')||a.children[colIndex].textContent;var y=b.children[colIndex].getAttribute('data-value')||b.children[colIndex].textContent;if(num){return dir==='ascending'?parseFloat(x)-parseFloat(y):parseFloat(y)-parseFloat(x);}return dir==='ascending'?String(x).localeCompare(y):String(y).localeCompare(x);});
        rows.forEach(function(r){tb.appendChild(r);});
      });
    });
  });
})();`;

function field(label, name, opts = {}) {
  const { type = 'text', value = '', ph = '', testid = '', required = true, step = '' } = opts;
  return `<label for="${name}">${esc(label)}</label>
<input id="${name}" name="${name}" type="${type}" value="${esc(value)}"${ph ? ` placeholder="${esc(ph)}"` : ''}${testid ? ` data-testid="${testid}"` : ''} data-qa="field-${name}" data-field="${name}"${step ? ` step="${step}"` : ''}${required ? ' required' : ''}>`;
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
<div class="modal-overlay" id="promo-overlay" data-testid="promo-modal" role="dialog" aria-modal="true" aria-labelledby="promo-title" hidden>
  <div class="modal">
    <button type="button" class="modal-close" data-testid="promo-close" aria-label="Close dialog">&times;</button>
    <span class="pill">Welcome offer</span>
    <h2 id="promo-title">Earn 2.5% APY on savings</h2>
    <p class="muted">Open a Finara savings account today — no minimum balance, no monthly fees.</p>
    <a class="button" href="/register" data-testid="promo-cta">Get started</a>
    <p style="margin:12px 0 0"><a href="#" data-testid="promo-dismiss-link">No thanks</a></p>
  </div>
</div>
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

function pageRates(user) {
  const items = ['Checking account', 'High-yield savings', '12-month CD', 'Money market', 'Personal loan', 'Auto loan', 'Credit card', 'Loan calculator', 'Chicago — Loop branch', 'Chicago — River North branch', 'Routing number', 'Wire transfer', 'Mobile deposit', 'Overdraft protection'];
  // Broken links are a seeded defect (D8): off by default so the clean build stays clean,
  // on with DEFECTS=all / DEFECTS=D8 to give the crawler real broken-link findings (404 targets).
  const brokenLinks = bug('D8')
    ? `<div class="card deadlinks" data-testid="offers-broken"><h2>Seasonal offers</h2>
      <a href="/offers/spring-sale" data-testid="deadlink-offer">Spring rate sale &rarr;</a>
      <a href="/help/legacy-guide" data-testid="deadlink-guide">Switching guide &rarr;</a>
      <a href="/blog/rates-2023" data-testid="deadlink-blog">2023 rate history &rarr;</a></div>`
    : '';
  const main = `<h1>Rates &amp; offers</h1><p class="sub">Compare Finara products and find what fits.</p>
<div class="card"><h2>Find a product or branch</h2>
  <div class="typeahead">
    <label for="product-search">Search products &amp; locations</label>
    <input id="product-search" type="text" autocomplete="off" role="combobox" aria-expanded="false" aria-controls="ta-results" aria-autocomplete="list" data-testid="typeahead-input" data-qa="product-search" data-items='${esc(JSON.stringify(items))}' placeholder="Try &ldquo;savings&rdquo; or &ldquo;Chicago&rdquo;">
    <ul id="ta-results" class="ta-results" role="listbox" data-testid="typeahead-results" hidden></ul>
  </div>
</div>
<h2>Our products</h2>
<div class="card-grid" data-testid="product-cards">
  <article class="card product-card" data-testid="product-card-checking"><span class="pill">Everyday</span><h3>Checking</h3><div class="rate">0.10%</div><p class="muted">No monthly fees, instant transfers.</p><a class="button" href="/register" data-testid="card-cta-checking">Open account</a></article>
  <article class="card product-card" data-testid="product-card-savings"><span class="pill">Popular</span><h3>Savings</h3><div class="rate">2.50%</div><p class="muted">High-yield, no minimum balance.</p><a class="button" href="/register" data-testid="card-cta-savings">Open account</a></article>
  <article class="card product-card" data-testid="product-card-loan"><span class="pill">Flexible</span><h3>Personal loan</h3><div class="rate">6.50%</div><p class="muted">Fast online decisions.</p><a class="button" href="/calculator" data-testid="card-cta-loan">Estimate payment</a></article>
  <article class="card product-card" data-testid="product-card-credit"><span class="pill">Rewards</span><h3>Credit card</h3><div class="rate">18.9%</div><p class="muted">Cash back on everyday spend.</p><a href="#" data-testid="deadlink-placeholder">Coming soon</a></article>
</div>
<h2>Current rates</h2>
<div class="card"><table class="sortable" data-testid="rates-table">
  <thead><tr>
    <th data-sort="text" aria-sort="none"><button type="button" class="th-sort" data-testid="sort-product">Product</button></th>
    <th data-sort="number" aria-sort="none" class="num"><button type="button" class="th-sort" data-testid="sort-rate">Rate (APY)</button></th>
    <th class="num">Min balance</th>
    <th>Term</th>
  </tr></thead>
  <tbody>
    <tr><td>High-yield savings</td><td class="num" data-value="2.5">2.50%</td><td class="num">$0</td><td>None</td></tr>
    <tr><td>12-month CD</td><td class="num" data-value="3.75">3.75%</td><td class="num">$1,000</td><td>12 months</td></tr>
    <tr><td>Checking</td><td class="num" data-value="0.1">0.10%</td><td class="num">$0</td><td>None</td></tr>
    <tr><td>Money market</td><td class="num" data-value="2.1">2.10%</td><td class="num">$2,500</td><td>None</td></tr>
    <tr><td>Personal loan</td><td class="num" data-value="6.5">6.50%</td><td class="num">&mdash;</td><td>36&ndash;60 months</td></tr>
  </tbody>
</table></div>
${brokenLinks}
<div class="card deadlinks"><h2>More</h2>
  <a href="#" data-testid="deadlink-hash">Investment accounts (coming soon)</a>
  <a data-testid="deadlink-nohref">Rewards program</a>
  <a href="/faq" data-testid="link-faq">Help center</a>
</div>`;
  return layout('Rates & offers', user, main);
}

function pageCalculator(user, q) {
  let result = '';
  const amt = q.amount, rate = q.rate, years = q.years;
  if (amt || rate || years) {
    // Validate each field; surface a clear message for non-numeric / out-of-range input.
    const num = (raw, label, { min = null } = {}) => {
      const s = String(raw == null ? '' : raw).trim();
      if (s === '') return { error: `${label} is required.` };
      if (!/^\d*\.?\d+$/.test(s)) return { error: `${label} must be a number — digits only, no letters or symbols.` };
      const v = parseFloat(s);
      if (min != null && v < min) return { error: `${label} must be ${min} or more.` };
      return { v };
    };
    const vA = num(amt, 'Loan amount', { min: 0 });
    const vR = num(rate, 'Interest rate', { min: 0 });
    const vY = num(years, 'Term (years)', { min: 0 });
    const err = (vA.error || vR.error || vY.error);
    if (err) {
      result = `<div class="card" data-testid="calc-error" style="border-left:4px solid #c0392b"><p class="muted" style="margin:0;color:#c0392b">${esc(err)}</p></div>`;
    } else if (vA.v > 0 && vY.v > 0) {
      const P = vA.v, r = vR.v / 100 / 12, n = Math.round(vY.v * 12);
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
  // Validate the Min/Max filter so bad input gets a clear message instead of a silently empty list.
  let filterErr = '', minC = null, maxC = null;
  if (String(q.min || '').trim() !== '') { const r = amountOf(q.min, { allowZero: true, label: 'Min amount' }); if (r.error) filterErr = r.error; else minC = r.cents; }
  if (!filterErr && String(q.max || '').trim() !== '') { const r = amountOf(q.max, { allowZero: true, label: 'Max amount' }); if (r.error) filterErr = r.error; else maxC = r.cents; }
  if (!filterErr && minC != null && maxC != null && minC > maxC) filterErr = 'Min amount can’t be greater than Max amount.';
  let list = accountTxns(sel);
  if (!filterErr) {
    if (minC != null) list = list.filter((t) => Math.abs(t.amount) >= minC);
    if (maxC != null && !bug('D7')) list = list.filter((t) => Math.abs(t.amount) <= maxC); // D7: max filter ignored
  } else { list = []; }
  const filterErrHtml = filterErr ? `<div class="flash err" data-testid="filter-error" role="status">${esc(filterErr)}</div>` : '';
  const rows = list.length ? list.map((t) => `<tr><td class="muted">${t.date.slice(0, 10)}</td><td>${bug('D5') ? t.description : esc(t.description)}</td><td><span class="pill">${t.type}</span></td>
    <td class="num ${t.amount < 0 ? 'neg' : 'pos'}">${money(t.amount)}</td><td class="num muted">${money(t.balanceAfter)}</td></tr>`).join('')
    : `<tr><td colspan="5" class="muted" data-testid="no-txns">${filterErr ? 'Fix the filter above to see results.' : 'No transactions match your search.'}</td></tr>`;
  const opts = accs.map((a) => `<option value="${a.id}"${a.id === sel ? ' selected' : ''}>${a.type} ••${a.id.slice(-4)}</option>`).join('');
  const main = `<h1>Account activity</h1><p class="sub">Search and review transactions.</p>
<div class="card"><form method="GET" action="/transactions" class="grid" style="grid-template-columns:2fr 1fr 1fr auto;align-items:end;gap:12px">
  <div><label for="account">Account</label><select id="account" name="account" data-testid="txn-account">${opts}</select></div>
  <div>${field('Min amount ($)', 'min', { type: 'number', value: q.min || '', required: false, testid: 'txn-min', step: '0.01' })}</div>
  <div>${field('Max amount ($)', 'max', { type: 'number', value: q.max || '', required: false, testid: 'txn-max', step: '0.01' })}</div>
  <div><button type="submit" data-testid="txn-search" style="margin:0">Search</button></div>
</form></div>
${filterErrHtml}
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

function pageDocuments(user, flash) {
  const accs = userAccounts();
  const docs = userDocs(user.id);
  const docRows = docs.length
    ? docs.map((d) => `<tr data-testid="doc-row-${d.id}"><td>${esc(d.name)}</td><td>${esc(d.docType)}</td><td class="num">${Math.max(1, Math.round(d.size / 1024))} KB</td><td>${esc(d.uploadedAt)}</td><td><a href="/documents/download?id=${d.id}" data-testid="doc-download-${d.id}" data-qa="doc-download">Download</a></td></tr>`).join('')
    : '<tr><td colspan="5" class="muted">No documents uploaded yet.</td></tr>';
  const stmtRows = accs.length
    ? accs.map((a) => `<tr><td>${esc(a.type)} &bull;&bull;${String(a.id).slice(-4)}</td><td class="num">${money(a.balance)}</td><td><a href="/documents/statement.csv?account=${encodeURIComponent(a.id)}" data-testid="stmt-download-${a.id}" data-qa="statement-download" download>Download CSV</a></td></tr>`).join('')
    : '<tr><td colspan="3" class="muted">No accounts yet.</td></tr>';
  const main = `<h1>Statements &amp; documents</h1><p class="sub">Upload supporting documents and download your account statements.</p>
<div class="grid">
  <div class="card"><h2>Upload a document</h2>
    <form method="POST" action="/documents/upload" enctype="multipart/form-data" data-testid="doc-upload-form">
      <label for="docType">Document type</label>
      <select id="docType" name="docType" data-testid="doc-type" data-qa="field-docType"><option>ID verification</option><option>Proof of income</option><option>Proof of address</option><option>Check image</option><option>Other</option></select>
      <label for="document">File (PDF, PNG, or JPG &mdash; max 5&nbsp;MB)</label>
      <input id="document" name="document" type="file" accept=".pdf,.png,.jpg,.jpeg" data-testid="file-input" data-qa="field-document" data-field="document" required>
      <button type="submit" data-testid="doc-upload-submit">Upload document</button>
    </form>
  </div>
  <div class="card"><h2>Download statements</h2>
    <p class="muted">Export your transaction history as a CSV file.</p>
    <table data-testid="statements-table"><thead><tr><th>Account</th><th class="num">Balance</th><th>Statement</th></tr></thead><tbody>${stmtRows}</tbody></table>
  </div>
</div>
<div class="card"><h2>Your documents</h2>
  <table data-testid="documents-table"><thead><tr><th>File</th><th>Type</th><th class="num">Size</th><th>Uploaded</th><th>Action</th></tr></thead><tbody>${docRows}</tbody></table>
</div>`;
  return layout('Documents', user, main, flash);
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
    <div><h4>Products</h4><a href="/services">Checking</a><a href="/services">Savings</a><a href="/calculator">Loans</a><a href="/rates">Rates &amp; offers</a></div>
    <div><h4>Support</h4><a href="/faq">Help center</a><a href="/security">Security</a><a href="/documents">Statements &amp; documents</a><a href="/contact">Contact us</a><a href="/login">Log in</a>${bug('D8') ? '<a href="/help/legacy-guide" data-testid="footer-deadlink">Switching guide</a>' : ''}</div>
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
  const user = await store.resolveUser(cookies(req).sid);
  const flash = q.ok ? { kind: 'ok', msg: q.ok } : q.err ? { kind: 'err', msg: q.err } : q.warn ? { kind: 'warn', msg: q.warn } : null;
  const gated = ['/dashboard', '/accounts/open', '/transfer', '/billpay', '/transactions', '/profile', '/loan', '/documents', '/documents/statement.csv', '/documents/download'];
  if (gated.includes(path) && !user) return redirect(res, '/login?warn=' + encodeURIComponent('Please log in to continue.'));

  // ---- GET pages
  if (req.method === 'GET') {
    switch (path) {
      case '/': return send(res, pageHome(user));
      case '/services': return send(res, pageServices(user));
      case '/rates': return send(res, pageRates(user));
      case '/about': case '/careers': case '/faq': case '/locations': case '/security': case '/privacy': case '/terms': case '/accessibility': { const c = CONTENT[path.slice(1)]; return send(res, contentPage(user, c.title, c.html, flash)); }
      case '/contact': return send(res, pageContact(user, flash));
      case '/calculator': return send(res, pageCalculator(user, q));
      case '/login': return send(res, pageLogin(user, flash));
      case '/register': return send(res, pageRegister(user, flash));
      case '/dashboard': { _ACCS = await store.getAccounts(user.id); return send(res, pageDashboard(user, flash)); }
      case '/accounts/open': { _ACCS = await store.getAccounts(user.id); return send(res, pageOpenAccount(user, flash)); }
      case '/transfer': { _ACCS = await store.getAccounts(user.id); return send(res, pageTransfer(user, flash)); }
      case '/billpay': { _ACCS = await store.getAccounts(user.id); return send(res, pageBillpay(user, flash)); }
      case '/transactions': { const a = await store.getAccounts(user.id); const sel = q.account || (a[0] && a[0].id); const list = sel ? await store.getTransactions(user.id, sel) : []; _ACCS = a; _TXNS = { [sel]: list }; return send(res, pageTransactions(user, q, flash)); }
      case '/profile': return send(res, pageProfile(user, flash));
      case '/loan': { _ACCS = await store.getAccounts(user.id); return send(res, pageLoan(user, flash)); }
      case '/documents': { _ACCS = await store.getAccounts(user.id); return send(res, pageDocuments(user, flash)); }
      case '/documents/statement.csv': {
        const accs = await store.getAccounts(user.id);
        const owns = accs.find((a) => String(a.id) === String(q.account));
        if (!owns) return send(res, layout('Not found', user, '<h1>404</h1><p class="sub">No such account.</p>'), 404);
        const txns = await store.getTransactions(user.id, q.account);
        const rows = [['Date', 'Type', 'Description', 'Amount', 'Balance after']];
        for (const t of txns) rows.push([t.date, t.type, t.description, (t.amount / 100).toFixed(2), (t.balanceAfter / 100).toFixed(2)]);
        const csv = rows.map((r) => r.map(csvCell).join(',')).join('\r\n');
        res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="finara-statement-${String(q.account).slice(-4)}.csv"` });
        return res.end(csv);
      }
      case '/documents/download': {
        const d = userDocs(user.id).find((x) => String(x.id) === String(q.id)); // scoped to the user → no IDOR
        if (!d) return send(res, layout('Not found', user, '<h1>404</h1><p class="sub">Document not found.</p>'), 404);
        res.writeHead(200, { 'Content-Type': d.type || 'application/octet-stream', 'Content-Disposition': `attachment; filename="${d.name.replace(/[^\w.\- ]/g, '_')}"` });
        return res.end(d.data);
      }
      case '/logout': { await store.logout(cookies(req).sid); return redirect(res, '/?ok=' + encodeURIComponent('You have been logged out.'), { 'Set-Cookie': 'sid=; Path=/; Max-Age=0' }); }
      case '/health': return send(res, 'ok');
    }
    return send(res, layout('Not found', user, '<h1>404</h1><p class="sub">That page does not exist.</p><a href="/">Back home</a>'), 404);
  }

  // ---- POST actions
  if (req.method === 'POST') {
    // File upload is multipart — handle it before body() (which would drain the stream as urlencoded).
    if (path === '/documents/upload') {
      if (!user) return redirect(res, '/login?warn=' + encodeURIComponent('Please log in to continue.'));
      const { fields, files, tooLarge } = await multipart(req);
      if (tooLarge) return redirect(res, '/documents?err=' + encodeURIComponent('File is too large. Maximum is 5 MB.'));
      const file = (files || []).find((x) => x.field === 'document') || (files || [])[0];
      const v = validateUpload(file);
      if (v.error) return redirect(res, '/documents?err=' + encodeURIComponent(v.error));
      const list = DOCS.get(String(user.id)) || [];
      list.unshift({ id: _DOC_SEQ++, name: file.filename, size: file.data.length, type: file.contentType, docType: fields.docType || 'Other', uploadedAt: new Date().toISOString().slice(0, 10), data: file.data });
      DOCS.set(String(user.id), list.slice(0, 20));
      return redirect(res, '/documents?ok=' + encodeURIComponent(`Uploaded “${file.filename}”.`));
    }
    const f = await body(req);
    if (path === '/login') {
      const u = String(f.username || '').trim(), p = String(f.password || '');
      if (!u || !p.trim()) return send(res, pageLogin(user, { kind: 'err', msg: 'Username and password are required.' }, f.username), 400);
      if (u.length > 100 || p.length > 200) return send(res, pageLogin(user, { kind: 'err', msg: 'Username or password is too long.' }, f.username), 400);
      const sid = await store.login(f.username, f.password);
      if (sid) return redirect(res, '/dashboard', { 'Set-Cookie': `sid=${sid}; Path=/; HttpOnly; SameSite=Lax` });
      return send(res, pageLogin(user, { kind: 'err', msg: 'Invalid username or password.' }, f.username), 401);
    }
    if (path === '/register') {
      const need = ['firstName', 'lastName', 'email', 'username', 'password', 'confirm'];
      if (need.some((k) => !String(f[k] || '').trim())) return send(res, pageRegister(user, { kind: 'err', msg: 'All fields except opening deposit are required.' }, f), 400);
      if (f.password !== f.confirm) return send(res, pageRegister(user, { kind: 'err', msg: 'Passwords do not match.' }, f), 400);
      const regEmail = emailOf(f.email);
      if (regEmail.error) return send(res, pageRegister(user, { kind: 'err', msg: regEmail.error }, f), 400);
      let dep = 0;
      if (String(f.deposit || '').trim() !== '') {
        const d = amountOf(f.deposit, { allowZero: true, label: 'Opening deposit' });
        if (d.error) return send(res, pageRegister(user, { kind: 'err', msg: d.error }, f), 400);
        dep = d.cents;
      }
      const r = await store.register({ firstName: f.firstName, lastName: f.lastName, email: f.email, username: f.username, password: f.password, depositCents: dep });
      if (r.error) return send(res, pageRegister(user, { kind: 'err', msg: r.error }, f), 409);
      return redirect(res, '/dashboard', { 'Set-Cookie': `sid=${r.sid}; Path=/; HttpOnly; SameSite=Lax` });
    }
    if (path === '/contact') {
      if (!String(f.name || '').trim() || !String(f.message || '').trim()) return redirect(res, '/contact?err=' + encodeURIComponent('Name and message are required.'));
      const contactEmail = emailOf(f.email, { required: false });
      if (contactEmail.error) return redirect(res, '/contact?err=' + encodeURIComponent(contactEmail.error));
      await store.addContact({ name: f.name, email: f.email, message: f.message });
      return redirect(res, '/contact?ok=' + encodeURIComponent('Thanks — we\'ll be in touch shortly.'));
    }
    if (!user) return redirect(res, '/login');

    if (path === '/transfer') {
      const amt = amountOf(f.amount);
      if (amt.error) return redirect(res, '/transfer?err=' + encodeURIComponent(amt.error));
      const r = await store.transfer(user.id, f.from, f.to, amt.cents);
      if (r.error) return redirect(res, '/transfer?err=' + encodeURIComponent(r.error));
      return redirect(res, '/dashboard?ok=' + encodeURIComponent(`Transferred ${money(r.amountCents)} successfully.`));
    }
    if (path === '/billpay') {
      if (!String(f.payee || '').trim()) return redirect(res, '/billpay?err=' + encodeURIComponent('Enter a payee name.'));
      const acct = digitsOf(f.payeeAcct, { label: 'Payee account number', min: 4, max: 20 });
      if (acct.error) return redirect(res, '/billpay?err=' + encodeURIComponent(acct.error));
      const amt = amountOf(f.amount);
      if (amt.error) return redirect(res, '/billpay?err=' + encodeURIComponent(amt.error));
      const r = await store.billpay(user.id, f.from, f.payee, acct.value, amt.cents);
      if (r.error) return redirect(res, '/billpay?err=' + encodeURIComponent(r.error));
      return redirect(res, '/dashboard?ok=' + encodeURIComponent(`Paid ${money(r.amountCents)} to ${f.payee}.`));
    }
    if (path === '/accounts/open') {
      let dep = 0;
      if (String(f.deposit || '').trim() !== '') {
        const d = amountOf(f.deposit, { allowZero: true, label: 'Opening deposit' });
        if (d.error) return redirect(res, '/accounts/open?err=' + encodeURIComponent(d.error));
        dep = d.cents;
      }
      const r = await store.openAccount(user.id, f.type, f.from, dep);
      if (r.error) return redirect(res, '/accounts/open?err=' + encodeURIComponent(r.error));
      return redirect(res, '/dashboard?ok=' + encodeURIComponent(`Opened a new ${r.type} account.`));
    }
    if (path === '/profile') {
      const pf = String(f.firstName || '').trim(), pl = String(f.lastName || '').trim();
      if (!pf || !pl) return send(res, pageProfile(user, { kind: 'err', msg: 'First and last name are required.' }), 400);
      const profEmail = emailOf(f.email);
      if (profEmail.error) return send(res, pageProfile(user, { kind: 'err', msg: profEmail.error }), 400);
      await store.updateProfile(user.id, { firstName: pf, lastName: pl, email: profEmail.value, phone: f.phone || '', address: f.address || '' });
      return redirect(res, '/profile?ok=' + encodeURIComponent('Your profile has been updated.'));
    }
    if (path === '/loan') {
      const amt = amountOf(f.amount, { label: 'Loan amount' });
      if (amt.error) return redirect(res, '/loan?err=' + encodeURIComponent(amt.error));
      const down = amountOf(f.down, { allowZero: true, label: 'Down payment' });
      if (down.error) return redirect(res, '/loan?err=' + encodeURIComponent(down.error));
      const r = await store.requestLoan(user.id, amt.cents, down.cents, f.to);
      if (r.error) return redirect(res, '/loan?err=' + encodeURIComponent(r.error));
      if (r.approved) return redirect(res, '/dashboard?ok=' + encodeURIComponent(`Loan approved — ${money(r.amountCents)} disbursed.`));
      return redirect(res, '/loan?err=' + encodeURIComponent('Loan denied: down payment must be at least 20% of the amount.'));
    }
    return send(res, layout('Not found', user, '<h1>404</h1>'), 404);
  }

  res.writeHead(405); res.end('Method Not Allowed');
});

(async () => {
  await store.init();
  server.listen(PORT, '0.0.0.0', () => console.log(`Finara running at http://localhost:${PORT}  (${(process.env.DB_BACKEND || 'sqlite')} backend · demo login: demo / demo123)`));
})().catch((e) => { console.error('Startup failed:', e.message); process.exit(1); });
