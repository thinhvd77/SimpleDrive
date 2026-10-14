import { createHash, createHmac, randomBytes, scrypt as scryptCallback, timingSafeEqual, randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import type { Database } from './db.js';
import type { Config } from './config.js';
import type { FastifyRequest } from 'fastify';

const scrypt = promisify(scryptCallback);
export type User = { id: string; email: string; name: string; role: 'admin' | 'employee'; disabled: boolean; quota_bytes: string };
export class HttpError extends Error {
  constructor(public statusCode: number, message: string) { super(message); }
}
export const tokenHash = (token: string) => createHash('sha256').update(token).digest('hex');
export async function hashPassword(password: string) {
  const salt = randomBytes(16).toString('hex');
  const key = await scrypt(password, salt, 64) as Buffer;
  return `${salt}:${key.toString('hex')}`;
}
export async function checkPassword(password: string, hash: string) {
  const [salt, encoded] = hash.split(':');
  const expected = Buffer.from(encoded, 'hex');
  const key = await scrypt(password, salt, 64) as Buffer;
  return expected.length === key.length && timingSafeEqual(expected, key);
}
export function csrfToken(token: string, secret: string) { return createHmac('sha256', secret).update(token).digest('hex'); }
export function assertOrigin(req: FastifyRequest, config: Config) {
  const origin = req.headers.origin;
  if (origin && origin !== config.BASE_URL) throw new HttpError(403, 'Nguồn yêu cầu không được phép.');
}
export async function authenticate(db: Database, req: FastifyRequest, config: Config, mutation = false): Promise<User> {
  const token = req.cookies.sd_session;
  if (!token) throw new HttpError(401, 'Vui lòng đăng nhập.');
  const r = await db.query<User>(`SELECT u.id,u.email,u.name,u.role,u.disabled,u.quota_bytes FROM sessions s
    JOIN users u ON u.id=s.user_id WHERE s.token_hash=$1 AND s.expires_at>now() AND NOT u.disabled`, [tokenHash(token)]);
  const user = r.rows[0];
  if (!user) throw new HttpError(401, 'Phiên đăng nhập đã hết hạn.');
  if (mutation) {
    assertOrigin(req, config);
    const csrf = req.headers['x-csrf-token'];
    const expected = csrfToken(token, config.SESSION_SECRET);
    if (typeof csrf !== 'string' || Buffer.byteLength(csrf) !== Buffer.byteLength(expected) || !timingSafeEqual(Buffer.from(csrf), Buffer.from(expected))) throw new HttpError(403, 'Yêu cầu không hợp lệ. Hãy tải lại trang.');
  }
  return user;
}
export async function bootstrapAdmin(db: Database, config: Config) {
  if (!config.ADMIN_EMAIL || !config.ADMIN_PASSWORD) return;
  const email = config.ADMIN_EMAIL;
  const hash = await hashPassword(config.ADMIN_PASSWORD);
  await db.transaction(async tx => {
    await tx.query('SELECT id FROM capacity WHERE id=1 FOR UPDATE');
    const count = await tx.query<{ n: string }>('SELECT count(*) AS n FROM users');
    if (Number(count.rows[0].n) === 0) await tx.query(`INSERT INTO users(id,email,name,password_hash,role,quota_bytes) VALUES($1,$2,$3,$4,'admin',$5)`, [randomUUID(), email.toLowerCase(), 'Quản trị viên', hash, config.USER_QUOTA_BYTES]);
  });
}
