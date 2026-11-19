'use strict';
const crypto = require('crypto');
// shared helpers used by both storage backends
exports.hash = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
exports.token = () => crypto.randomBytes(18).toString('hex');
exports.nowISO = () => new Date().toISOString();
exports.codeOf = (type) => ({ Checking: 'CHK', Savings: 'SAV', Loan: 'LOAN' }[type] || 'CHK');
exports.titleKind = (k) => String(k).charAt(0) + String(k).slice(1).toLowerCase(); // DEPOSIT -> Deposit
