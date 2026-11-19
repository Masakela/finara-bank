'use strict';
// Pick the storage backend:
//   DB_BACKEND=postgres   -> PostgreSQL (production; also auto-selected when DATABASE_URL is set)
//   DB_BACKEND=sqlite     -> SQLite (default locally; Node 22 built-in, zero deps)
function makeStore() {
  let backend = (process.env.DB_BACKEND || '').toLowerCase();
  if (!backend) backend = process.env.DATABASE_URL ? 'postgres' : 'sqlite';
  if (backend === 'postgres' || backend === 'pg') return require('./backends/postgres').create();
  return require('./backends/sqlite').create();
}
module.exports = { makeStore };
