import { Database } from 'bun:sqlite';

export type ClientRecord = {
  id: string;
  token: string | null;
  tunnelType: string;
  subdomain: string | null;
  publicPort: number | null;
  localPort: number;
  connectedAt: string;
  disconnectedAt: string | null;
};

export class AugerDb {
  private db: Database;

  constructor(path: string) {
    this.db = new Database(path);
    this.db.exec('PRAGMA journal_mode = WAL;');
  }

  init(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS clients (
        id TEXT PRIMARY KEY,
        token TEXT,
        tunnel_type TEXT,
        subdomain TEXT,
        public_port INTEGER,
        local_port INTEGER,
        connected_at TEXT,
        disconnected_at TEXT
      );
    `);
  }

  insertClient(record: ClientRecord): void {
    const stmt = this.db.prepare(`
      INSERT INTO clients (
        id,
        token,
        tunnel_type,
        subdomain,
        public_port,
        local_port,
        connected_at,
        disconnected_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(
      record.id,
      record.token,
      record.tunnelType,
      record.subdomain,
      record.publicPort,
      record.localPort,
      record.connectedAt,
      record.disconnectedAt
    );
  }

  markDisconnected(id: string, disconnectedAt: string): void {
    const stmt = this.db.prepare('UPDATE clients SET disconnected_at = ? WHERE id = ?');
    stmt.run(disconnectedAt, id);
  }
}
