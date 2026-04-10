const initSqlJs = require('sql.js');
const fs = require('fs');
const path = require('path');
const config = require('../config');

let db = null;
let SQL = null;

/**
 * Initialize the database connection.
 * Creates the data directory and database file if they don't exist.
 */
async function initDatabase() {
  SQL = await initSqlJs();

  const dbDir = path.dirname(config.db.path);
  if (!fs.existsSync(dbDir)) {
    fs.mkdirSync(dbDir, { recursive: true });
  }

  if (fs.existsSync(config.db.path)) {
    const buffer = fs.readFileSync(config.db.path);
    db = new SQL.Database(buffer);
    console.log('[DB] Loaded existing database from', config.db.path);
  } else {
    db = new SQL.Database();
    console.log('[DB] Created new database');
  }

  // Enable WAL mode equivalent and foreign keys
  db.run('PRAGMA journal_mode = DELETE;');
  db.run('PRAGMA foreign_keys = ON;');

  // Helper: run SQL file statement-by-statement, tolerating expected errors
  function runSqlStatements(sql, label) {
    const statements = sql
      .split(';')
      .map((s) => s.replace(/--[^\n]*/g, '').trim())
      .filter((s) => s.length > 0);
    for (const stmt of statements) {
      try {
        db.run(stmt);
      } catch (err) {
        // Ignore expected errors on existing DBs (duplicate column, missing column for index)
        if (err.message.includes('duplicate column') || err.message.includes('no such column')) {
          // Silently skip — will be resolved by migrations
        } else {
          console.warn(`[DB] ${label} warning:`, err.message);
        }
      }
    }
  }

  // Run migrations FIRST so ALTER TABLE adds columns before schema indexes reference them
  const migrationsDir = path.join(__dirname);
  const migrationFiles = fs.readdirSync(migrationsDir)
    .filter((f) => f.startsWith('migration-') && f.endsWith('.sql'))
    .sort();
  for (const mf of migrationFiles) {
    try {
      const sql = fs.readFileSync(path.join(migrationsDir, mf), 'utf-8');
      runSqlStatements(sql, `Migration ${mf}`);
      console.log(`[DB] Migration ${mf} applied`);
    } catch (err) {
      console.warn(`[DB] Migration ${mf} skipped:`, err.message);
    }
  }

  // Run schema (CREATE TABLE IF NOT EXISTS + CREATE INDEX IF NOT EXISTS)
  const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf-8');
  runSqlStatements(schema, 'Schema');
  console.log('[DB] Schema applied');

  // Save to disk
  saveDatabase();

  return db;
}

/**
 * Save the in-memory database to disk.
 * Call this after write operations.
 */
function saveDatabase() {
  if (!db) return;
  const data = db.export();
  const buffer = Buffer.from(data);
  fs.writeFileSync(config.db.path, buffer);
}

/**
 * Execute a query that modifies data (INSERT, UPDATE, DELETE).
 * Automatically saves to disk after execution.
 */
function run(sql, params = []) {
  if (!db) throw new Error('Database not initialized');
  db.run(sql, params);
  saveDatabase();
  return { changes: db.getRowsModified() };
}

/**
 * Execute a SELECT query and return all matching rows.
 */
function all(sql, params = []) {
  if (!db) throw new Error('Database not initialized');
  const stmt = db.prepare(sql);
  if (params.length > 0) stmt.bind(params);

  const rows = [];
  while (stmt.step()) {
    rows.push(stmt.getAsObject());
  }
  stmt.free();
  return rows;
}

/**
 * Execute a SELECT query and return the first matching row.
 */
function get(sql, params = []) {
  const rows = all(sql, params);
  return rows.length > 0 ? rows[0] : null;
}

/**
 * Close the database connection.
 */
function close() {
  if (db) {
    saveDatabase();
    db.close();
    db = null;
    console.log('[DB] Database closed');
  }
}

/**
 * Get the raw database instance (for advanced queries).
 */
function getDb() {
  return db;
}

module.exports = {
  initDatabase,
  saveDatabase,
  run,
  all,
  get,
  close,
  getDb,
};
