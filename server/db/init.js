/**
 * Database initialization script.
 * Run with: npm run db:init
 */
const { initDatabase, close } = require('./db');

async function main() {
  console.log('Initializing pushIT database...');
  await initDatabase();
  console.log('Database initialized successfully.');
  close();
}

main().catch((err) => {
  console.error('Failed to initialize database:', err);
  process.exit(1);
});
