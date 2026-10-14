import { createReadStream } from 'node:fs';
import { mkdir, statfs, unlink } from 'node:fs/promises';
import path from 'node:path';
import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from 'node:crypto';
import type { Config } from './config.js';
import type { Database, Queryable } from './db.js';
import { HttpError, type User } from './auth.js';

export interface FileRow {
  id: string; owner_id: string; name: string; source: 'upload' | 'url' | 'drive'; source_url: string | null;
  status: string; size_bytes: string; reserved_bytes: string; received_bytes: string; sha256: string | null;
  expected_md5: string | null; error: string | null; attempts: number;
  created_at: Date; updated_at: Date; expires_at: Date | null; lease_until: Date | null;
}
export const validId = (id: string) => /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(id);
export function filePath(config: Config, id: string) {
  if (!validId(id)) throw new HttpError(400, 'Mã file không hợp lệ.');
  return path.join(config.DATA_DIR, id);
}
export function cleanName(name: string) {
  const clean = name.replace(/[\\/\u0000-\u001f\u007f]/g, '_').trim().slice(0, 200);
  if (!clean || clean === '.' || clean === '..') throw new HttpError(400, 'Tên file không hợp lệ.');
  return clean;
}
export function seal(value: string, secret: string) {
  const key = createHash('sha256').update(secret).digest(); const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  return Buffer.concat([iv, cipher.update(value), cipher.final(), cipher.getAuthTag()]).toString('base64');
}
export function unseal(value: string, secret: string) {
  const bytes = Buffer.from(value, 'base64');
  const decipher = createDecipheriv('aes-256-gcm', createHash('sha256').update(secret).digest(), bytes.subarray(0, 12));
  decipher.setAuthTag(bytes.subarray(-16));
  return Buffer.concat([decipher.update(bytes.subarray(12, -16)), decipher.final()]).toString();
}
export async function initializeStorage(config: Config) { await mkdir(config.DATA_DIR, { recursive: true, mode: 0o750 }); }
export async function audit(db: Queryable, userId: string | null, action: string, fileId?: string, detail?: string) {
  await db.query('INSERT INTO audit(user_id,action,file_id,detail) VALUES($1,$2,$3,$4)', [userId, action, fileId ?? null, detail ?? null]);
}
export async function reserveFile(db: Database, config: Config, user: User, options: { name: string; size: number; source: FileRow['source']; url?: string }) {
  if (!Number.isSafeInteger(options.size) || options.size < 1 || options.size > config.MAX_FILE_BYTES) throw new HttpError(413, 'Mỗi file phải có dung lượng từ 1 byte đến 2 GB.');
  const id = randomUUID(); const name = cleanName(options.name);
  return db.transaction(async tx => {
    await tx.query('SELECT id FROM capacity WHERE id=1 FOR UPDATE');
    const quota = await tx.query<{ quota_bytes: string; disabled: boolean }>('SELECT quota_bytes,disabled FROM users WHERE id=$1', [user.id]);
    if (quota.rows[0]?.disabled || !quota.rows[0]) throw new HttpError(403, 'Tài khoản đã bị khóa.');
    const usage = await tx.query<{ total: string; own: string; outstanding: string }>(`SELECT COALESCE(sum(reserved_bytes),0) AS total,
      COALESCE(sum(CASE WHEN owner_id=$1 THEN reserved_bytes ELSE 0 END),0) AS own,
      COALESCE(sum(GREATEST(reserved_bytes-received_bytes,0)),0) AS outstanding FROM files`, [user.id]);
    const u = usage.rows[0];
    if (Number(u.own) + options.size > Number(quota.rows[0].quota_bytes)) throw new HttpError(409, 'Bạn đã dùng hết hạn mức lưu trữ. Hãy xóa file cũ.');
    if (Number(u.total) + options.size > config.GLOBAL_QUOTA_BYTES) throw new HttpError(507, 'Trạm trung chuyển đã hết hạn mức lưu trữ.');
    const disk = await statfs(config.DATA_DIR);
    if (disk.bavail * disk.bsize < config.MIN_FREE_BYTES + Number(u.outstanding) + options.size) throw new HttpError(507, 'Ổ đĩa không còn đủ dung lượng an toàn.');
    const status = options.source === 'upload' ? 'pending' : 'queued';
    const row = await tx.query<FileRow>(`INSERT INTO files(id,owner_id,name,source,source_url,status,size_bytes,reserved_bytes)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`, [id, user.id, name, options.source, options.url ? seal(options.url, config.SESSION_SECRET) : null, status, options.source === 'upload' ? options.size : 0, options.size]);
    await audit(tx, user.id, options.source === 'upload' ? 'upload_created' : 'import_created', id);
    return row.rows[0];
  });
}
export async function ownedFile(db: Queryable, id: string, user: User): Promise<FileRow> {
  if (!validId(id)) throw new HttpError(404, 'Không tìm thấy file.');
  const row = await db.query<FileRow>('SELECT * FROM files WHERE id=$1 AND (owner_id=$2 OR $3=true)', [id, user.id, user.role === 'admin']);
  if (!row.rows[0]) throw new HttpError(404, 'Không tìm thấy file.');
  return row.rows[0];
}
export function publicFile(f: FileRow) {
  return { id: f.id, ownerId: f.owner_id, name: f.name, source: f.source, status: f.status,
    size: Number(f.size_bytes), reserved: Number(f.reserved_bytes), received: Number(f.received_bytes),
    sha256: f.sha256, error: f.error, createdAt: f.created_at, expiresAt: f.expires_at };
}
export async function removeBytes(config: Config, id: string) {
  for (const suffix of ['', '.json', '.part']) {
    try { await unlink(filePath(config, id) + suffix); }
    catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
  }
}
export async function checksums(config: Config, id: string, signal?: AbortSignal) {
  const sha = createHash('sha256'), md5 = createHash('md5');
  for await (const chunk of createReadStream(filePath(config, id), { signal })) { sha.update(chunk); md5.update(chunk); }
  return { sha256: sha.digest('hex'), md5: md5.digest('hex') };
}
