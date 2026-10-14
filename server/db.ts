import pg from 'pg';

export interface Result<T = Record<string, unknown>> { rows: T[]; rowCount: number | null }
export interface Queryable { query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<Result<T>> }
export interface Database extends Queryable {
  transaction<T>(fn: (db: Queryable) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}
export class PgDatabase implements Database {
  private pool: pg.Pool;
  constructor(url: string) { this.pool = new pg.Pool({ connectionString: url, max: 10 }); }
  async query<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<Result<T>> {
    const result = await this.pool.query(sql, params); return { rows: result.rows as T[], rowCount: result.rowCount };
  }
  async transaction<T>(fn: (db: Queryable) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try { await client.query('BEGIN'); const result = await fn({ query: async (sql, params) => { const r = await client.query(sql, params); return { rows: r.rows, rowCount: r.rowCount }; } }); await client.query('COMMIT'); return result; }
    catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
  }
  async close() { await this.pool.end(); }
}

export async function migrate(db: Database) {
  await db.transaction(async tx => {
    // A row lock serializes both schema setup and all capacity reservations.
    await tx.query('CREATE TABLE IF NOT EXISTS capacity (id integer PRIMARY KEY CHECK (id = 1))');
    await tx.query('INSERT INTO capacity(id) VALUES (1) ON CONFLICT DO NOTHING');
    await tx.query('SELECT id FROM capacity WHERE id=1 FOR UPDATE');
    await tx.query(`CREATE TABLE IF NOT EXISTS users (
      id uuid PRIMARY KEY, email text NOT NULL UNIQUE, name text NOT NULL,
      password_hash text NOT NULL, role text NOT NULL CHECK(role IN ('admin','employee')),
      disabled boolean NOT NULL DEFAULT false, quota_bytes bigint NOT NULL CHECK(quota_bytes>0),
      created_at timestamptz NOT NULL DEFAULT now()
    )`);
    await tx.query(`CREATE TABLE IF NOT EXISTS sessions (
      token_hash text PRIMARY KEY, user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      expires_at timestamptz NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
    )`);
    await tx.query(`CREATE TABLE IF NOT EXISTS files (
      id uuid PRIMARY KEY, owner_id uuid NOT NULL REFERENCES users(id), name text NOT NULL,
      source text NOT NULL CHECK(source IN ('upload','url','drive')), source_url text,
      status text NOT NULL CHECK(status IN ('pending','uploading','queued','downloading','verifying','ready','failed','deleting','deleted','expired')),
      size_bytes bigint NOT NULL DEFAULT 0, reserved_bytes bigint NOT NULL DEFAULT 0,
      received_bytes bigint NOT NULL DEFAULT 0, sha256 text, expected_md5 text,
      error text, attempts integer NOT NULL DEFAULT 0,
      created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
      expires_at timestamptz, lease_until timestamptz
    )`);
    await tx.query('CREATE INDEX IF NOT EXISTS files_owner ON files(owner_id, created_at DESC)');
    await tx.query('CREATE INDEX IF NOT EXISTS files_work ON files(status, created_at)');
    await tx.query(`CREATE TABLE IF NOT EXISTS audit (
      id bigserial PRIMARY KEY, user_id uuid REFERENCES users(id), action text NOT NULL,
      file_id uuid, detail text, created_at timestamptz NOT NULL DEFAULT now()
    )`);
  });
}
