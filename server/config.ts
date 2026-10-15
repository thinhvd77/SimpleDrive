import path from 'node:path';
import { z } from 'zod';
import { ConfigurationError } from './startup-errors.js';
import { employeeCodeSchema } from './employee-code.js';

const number = (fallback: number) => z.coerce.number().int().positive().default(fallback);
const schema = z.object({
  BASE_URL: z.url().default('http://localhost:5173'),
  NODE_ENV: z.enum(['development', 'test', 'production']).default('production'),
  PORT: number(4000), HOST: z.string().default('127.0.0.1'),
  DATABASE_URL: z.string().min(1), SESSION_SECRET: z.string().min(32),
  DATA_DIR: z.string().default('./data/files'),
  MAX_FILE_BYTES: number(2_000_000_000).refine(v => v <= 2_000_000_000, 'Maximum is 2 GB'),
  USER_QUOTA_BYTES: number(20_000_000_000), GLOBAL_QUOTA_BYTES: number(100_000_000_000),
  MIN_FREE_BYTES: z.coerce.number().int().nonnegative().default(20_000_000_000),
  RETENTION_HOURS: number(72), UPLOAD_IDLE_HOURS: number(24),
  IMPORT_CONCURRENCY: number(2).refine(v => v <= 2),
  ADMIN_EMPLOYEE_CODE: employeeCodeSchema.default('ADMIN'), ADMIN_PASSWORD: z.preprocess(v => v === '' ? undefined : v, z.string().min(8).optional()),
  GOOGLE_DRIVE_API_KEY: z.string().optional(),
  NGINX_DOWNLOADS: z.enum(['true', 'false']).default('false'),
});
export type Config = ReturnType<typeof readConfig>;
export function readConfig(env: Record<string, string | undefined> = process.env) {
  const c = schema.parse(env);
  const problems: string[] = [];
  if (c.SESSION_SECRET.startsWith('replace-')) problems.push('SESSION_SECRET: vẫn là giá trị mẫu. Thay bằng chuỗi ngẫu nhiên ít nhất 32 ký tự.');
  if (c.ADMIN_PASSWORD?.startsWith('replace-')) problems.push('ADMIN_PASSWORD: vẫn là giá trị mẫu. Đặt mật khẩu quản trị riêng, ít nhất 8 ký tự.');
  if (problems.length) throw new ConfigurationError(problems);
  const base = new URL(c.BASE_URL);
  if (!['http:', 'https:'].includes(base.protocol) || base.pathname !== '/' || base.search || base.hash || base.username || base.password) throw new ConfigurationError(['BASE_URL: phải là origin HTTP/HTTPS, ví dụ http://localhost:5173; không kèm path, query hoặc thông tin đăng nhập.']);
  return { ...c, BASE_URL: base.origin, DATA_DIR: path.resolve(c.DATA_DIR), secureCookies: base.protocol === 'https:' };
}
