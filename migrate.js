/**
 * Database Migration Script
 * Run: node migrate.js
 */
const fs = require('fs');
const path = require('path');

// Load .env
try {
  const envPath = path.join(__dirname, '.env');
  if (fs.existsSync(envPath)) {
    fs.readFileSync(envPath, 'utf8').split('\n').forEach(line => {
      const [key, ...val] = line.split('=');
      if (key && key.trim() && !key.startsWith('#')) {
        process.env[key.trim()] = val.join('=').trim();
      }
    });
  }
} catch {}

console.log('Migration script — PostgreSQL tables');
console.log('=====================================');

if (!process.env.DATABASE_URL) {
  console.log('DATABASE_URL not set. Using db.json file storage.');
  console.log('To use PostgreSQL:');
  console.log('  1. Create a PostgreSQL database (e.g. on Railway)');
  console.log('  2. Set DATABASE_URL in .env');
  console.log('  3. Run: node migrate.js');
  process.exit(0);
}

const TABLES = `
CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  email VARCHAR(255) NOT NULL UNIQUE,
  password_hash VARCHAR(255) NOT NULL,
  api_token TEXT NOT NULL,
  name VARCHAR(255) DEFAULT '',
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS sessions (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  session_token VARCHAR(64) NOT NULL UNIQUE,
  created_at TIMESTAMP DEFAULT NOW(),
  expires_at TIMESTAMP NOT NULL
);

CREATE TABLE IF NOT EXISTS notifications (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type VARCHAR(50) NOT NULL DEFAULT 'low_stock',
  title VARCHAR(255) NOT NULL,
  message TEXT NOT NULL,
  sku VARCHAR(100),
  is_read BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS shipping_config (
  id SERIAL PRIMARY KEY,
  token_hash VARCHAR(64) NOT NULL,
  country VARCHAR(10) NOT NULL,
  days INTEGER DEFAULT 30,
  UNIQUE(token_hash, country)
);

CREATE TABLE IF NOT EXISTS inventory_delta (
  id SERIAL PRIMARY KEY,
  token_hash VARCHAR(64) NOT NULL,
  sku VARCHAR(100) NOT NULL,
  delta INTEGER DEFAULT 0,
  updated_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(token_hash, sku)
);

CREATE TABLE IF NOT EXISTS webhook_logs (
  id SERIAL PRIMARY KEY,
  token_hash VARCHAR(64) NOT NULL,
  order_id VARCHAR(100),
  status VARCHAR(100),
  classification VARCHAR(50),
  sku VARCHAR(100),
  qty INTEGER DEFAULT 1,
  action VARCHAR(50),
  customer VARCHAR(200),
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS orders_cache (
  id SERIAL PRIMARY KEY,
  token_hash VARCHAR(64) NOT NULL,
  order_data JSONB NOT NULL,
  saved_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS product_groups (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  group_name VARCHAR(255) NOT NULL,
  skus TEXT[] NOT NULL DEFAULT '{}',
  created_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(user_id, group_name)
);

CREATE TABLE IF NOT EXISTS todos (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title VARCHAR(500) NOT NULL,
  description TEXT DEFAULT '',
  done BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS user_settings (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  setting_key VARCHAR(100) NOT NULL,
  setting_value JSONB NOT NULL DEFAULT '{}',
  updated_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(user_id, setting_key)
);

CREATE INDEX IF NOT EXISTS idx_product_groups_user ON product_groups(user_id);
CREATE INDEX IF NOT EXISTS idx_todos_user ON todos(user_id);
CREATE INDEX IF NOT EXISTS idx_user_settings ON user_settings(user_id);
CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
CREATE INDEX IF NOT EXISTS idx_sessions_token ON sessions(session_token);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id);
CREATE INDEX IF NOT EXISTS idx_webhook_logs_token ON webhook_logs(token_hash);
CREATE INDEX IF NOT EXISTS idx_inventory_delta_token ON inventory_delta(token_hash);
CREATE INDEX IF NOT EXISTS idx_orders_cache_token ON orders_cache(token_hash);
`;

async function runMigration() {
  try {
    const { Pool } = require('pg');
    const pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: process.env.DATABASE_URL.includes('localhost')
        ? false
        : { rejectUnauthorized: false },
    });
    console.log('Connecting to PostgreSQL...');
    await pool.query(TABLES);
    console.log('All tables created successfully!');
    await pool.end();
  } catch (e) {
    console.error('Migration failed:', e.message);
    console.log('\nSQL to execute manually:');
    console.log(TABLES);
    process.exit(1);
  }
}

runMigration();
