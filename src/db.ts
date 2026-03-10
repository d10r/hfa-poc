import Database from 'better-sqlite3'
import path from 'path'

let db: Database.Database | null = null

interface ColumnInfo {
  name: string
}

export function getDb(): Database.Database {
  if (!db) {
    const dbPath = process.env.DATABASE_PATH || path.join(process.cwd(), 'data.db')
    db = new Database(dbPath)
    db.pragma('journal_mode = WAL')
    initTables(db)
  }
  return db
}

function initTables(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS devices (
      id TEXT PRIMARY KEY,
      endpoint TEXT NOT NULL,
      p256dh TEXT NOT NULL,
      auth TEXT NOT NULL,
      agent_address TEXT,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS notifications (
      id TEXT PRIMARY KEY,
      device_id TEXT NOT NULL,
      pending_request_id TEXT,
      message TEXT NOT NULL,
      response TEXT,
      created_at INTEGER NOT NULL,
      responded_at INTEGER,
      FOREIGN KEY (device_id) REFERENCES devices(id),
      FOREIGN KEY (pending_request_id) REFERENCES pending_requests(id)
    );

    CREATE TABLE IF NOT EXISTS agents (
      address TEXT PRIMARY KEY,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS pending_requests (
      id TEXT PRIMARY KEY,
      agent_address TEXT NOT NULL,
      forwarder_address TEXT NOT NULL,
      macro_address TEXT NOT NULL,
      params TEXT NOT NULL,
      signer TEXT NOT NULL,
      signature TEXT NOT NULL,
      message TEXT NOT NULL,
      action_description TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      notification_count INTEGER NOT NULL DEFAULT 0,
      response TEXT,
      tx_hash TEXT,
      error TEXT,
      created_at INTEGER NOT NULL,
      executed_at INTEGER,
      responded_at INTEGER,
      FOREIGN KEY (agent_address) REFERENCES agents(address)
    );

    CREATE INDEX IF NOT EXISTS idx_notifications_device ON notifications(device_id);
    CREATE INDEX IF NOT EXISTS idx_pending_requests_agent ON pending_requests(agent_address);
    CREATE INDEX IF NOT EXISTS idx_devices_agent ON devices(agent_address);
  `)

  ensureColumn(db, 'notifications', 'pending_request_id', 'TEXT')
  ensureColumn(db, 'pending_requests', 'status', "TEXT NOT NULL DEFAULT 'pending'")
  ensureColumn(db, 'pending_requests', 'notification_count', 'INTEGER NOT NULL DEFAULT 0')
  ensureColumn(db, 'pending_requests', 'tx_hash', 'TEXT')
  ensureColumn(db, 'pending_requests', 'error', 'TEXT')
  ensureColumn(db, 'pending_requests', 'executed_at', 'INTEGER')

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_notifications_pending_request ON notifications(pending_request_id);
  `)
}

function ensureColumn(db: Database.Database, tableName: string, columnName: string, definition: string): void {
  const columns = db.prepare(`PRAGMA table_info(${tableName})`).all() as ColumnInfo[]
  const hasColumn = columns.some(column => column.name === columnName)
  if (!hasColumn) {
    db.exec(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${definition}`)
  }
}

export function closeDb(): void {
  if (db) {
    db.close()
    db = null
  }
}
