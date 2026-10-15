import { z } from 'zod';

export type StartupStage = 'environment' | 'configuration' | 'storage' | 'database' | 'admin' | 'application' | 'listen';
const stages: Record<StartupStage, string> = {
  environment: 'Đọc file .env', configuration: 'Kiểm tra cấu hình', storage: 'Chuẩn bị thư mục lưu file',
  database: 'Kết nối PostgreSQL và cập nhật schema', admin: 'Khởi tạo tài khoản quản trị',
  application: 'Khởi tạo ứng dụng', listen: 'Mở cổng HTTP',
};

export class ConfigurationError extends Error {
  constructor(public readonly problems: string[]) { super(problems.join('\n')); this.name = 'ConfigurationError'; }
}

/** Redact known credentials and connection-string credentials without hiding the failing host/path. */
export function redactStartupText(text: string, env: Record<string, string | undefined>) {
  const secrets = new Set<string>();
  for (const [key, value] of Object.entries(env)) {
    if (value && /(?:PASSWORD|SECRET|TOKEN|API_KEY|PRIVATE_KEY)/i.test(key)) secrets.add(value);
  }
  if (env.DATABASE_URL) {
    try {
      const password = new URL(env.DATABASE_URL).password;
      if (password) { secrets.add(password); try { secrets.add(decodeURIComponent(password)); } catch { /* retain encoded form */ } }
    } catch { secrets.add(env.DATABASE_URL); }
  }
  let result = text;
  for (const secret of [...secrets].sort((a, b) => b.length - a.length)) {
    if (secret.length >= 4) result = result.split(secret).join('[REDACTED]');
  }
  return result
    .replace(/(\b[a-z][a-z0-9+.-]*:\/\/)[^\s/]+@/gi, '$1[REDACTED]@')
    .replace(/([?&](?:key|token|password|secret|api_key|access_token)=)[^&#\s]*/gi, '$1[REDACTED]');
}

function validationProblem(issue: z.core.$ZodIssue, env: Record<string, string | undefined>) {
  const field = issue.path.join('.') || 'Cấu hình';
  if (issue.code === 'invalid_type') return `${field}: ${env[field] === undefined ? 'chưa được cấu hình' : 'sai kiểu dữ liệu'}.`;
  if (issue.code === 'too_small') return `${field}: cần ít nhất ${issue.minimum}${issue.origin === 'string' ? ' ký tự' : ''}.`;
  if (issue.code === 'too_big') return `${field}: tối đa ${issue.maximum}${issue.origin === 'string' ? ' ký tự' : ''}.`;
  if (issue.code === 'invalid_format') return `${field}: ${issue.format === 'email' ? 'email' : issue.format === 'url' ? 'URL' : 'định dạng'} không hợp lệ.`;
  return `${field}: giá trị không hợp lệ. ${issue.code === 'custom' ? issue.message : ''}`.trim();
}

type Detail = Error & { code?: string; address?: string; port?: number; syscall?: string; path?: string; detail?: string; hint?: string; errors?: unknown[] };
function causes(error: unknown, seen = new Set<unknown>()): Detail[] {
  if (seen.has(error) || seen.size >= 12) return [];
  seen.add(error);
  if (!(error instanceof Error)) return [new Error(typeof error === 'string' ? error : 'Lỗi không cung cấp thông tin chi tiết.')];
  const detail = error as Detail;
  return [detail, ...(detail.errors ?? []).flatMap(e => causes(e, seen)), ...(error.cause ? causes(error.cause, seen) : [])];
}

export function formatStartupError(error: unknown, stage: StartupStage, env: Record<string, string | undefined> = process.env) {
  const lines = [`[SimpleDrive] Không thể khởi động.`, `Bước thất bại: ${stages[stage]}.`];
  const errors = causes(error);
  for (const cause of errors) {
    if (cause instanceof z.ZodError) lines.push(...cause.issues.map(issue => `- ${validationProblem(issue, env)}`));
    else if (cause instanceof ConfigurationError) lines.push(...cause.problems.map(problem => `- ${problem}`));
    else {
      lines.push(cause.stack ?? `${cause.name}: ${cause.message}`);
      const details = ['code', 'address', 'port', 'syscall', 'path', 'detail', 'hint'] as const;
      for (const key of details) if (cause[key] !== undefined) lines.push(`  ${key}: ${cause[key]}`);
    }
  }
  const codes = new Set(errors.map(e => e.code));
  if (stage === 'configuration') lines.push('Cách sửa: cập nhật các biến được liệt kê trong .env (hoặc environment của container), rồi chạy lại. SESSION_SECRET cần ít nhất 32 ký tự; ADMIN_PASSWORD cần ít nhất 8 ký tự và không dùng giá trị mẫu.');
  else if (codes.has('ECONNREFUSED')) lines.push('Cách sửa: PostgreSQL chưa nhận kết nối ở địa chỉ/cổng trên. Khi chạy dev trực tiếp, kiểm tra DATABASE_URL trỏ tới localhost:5432 và database đã chạy; hostname db chỉ dùng bên trong Docker Compose.');
  else if (codes.has('ENOTFOUND') || codes.has('EAI_AGAIN')) lines.push('Cách sửa: kiểm tra hostname trong DATABASE_URL và DNS. Chạy dev ngoài Docker không dùng hostname db của Compose.');
  else if (codes.has('28P01')) lines.push('Cách sửa: username/password PostgreSQL không đúng. Kiểm tra DATABASE_URL; đổi POSTGRES_PASSWORD trong .env không tự đổi mật khẩu của database đã có dữ liệu.');
  else if (codes.has('3D000')) lines.push('Cách sửa: database chưa tồn tại. Tạo database tương ứng hoặc sửa tên database trong DATABASE_URL.');
  else if (codes.has('42501')) lines.push('Cách sửa: tài khoản PostgreSQL cần quyền tạo/cập nhật bảng và index trong schema đang dùng.');
  else if (codes.has('EADDRINUSE')) lines.push('Cách sửa: cổng HTTP đã có chương trình khác sử dụng. Dừng tiến trình đó hoặc đổi PORT trong .env.');
  else if (codes.has('EADDRNOTAVAIL')) lines.push('Cách sửa: HOST phải là địa chỉ có trên máy này, ví dụ 127.0.0.1 hoặc 0.0.0.0.');
  else if (codes.has('EACCES') || codes.has('EPERM') || codes.has('EROFS')) lines.push('Cách sửa: kiểm tra quyền của tài khoản chạy ứng dụng đối với đường dẫn được báo; DATA_DIR cần có quyền tạo thư mục và ghi file.');
  else if (stage === 'database') lines.push('Cách sửa: kiểm tra PostgreSQL, DATABASE_URL, SSL/firewall và quyền schema theo lỗi chi tiết ở trên.');
  return redactStartupText(lines.join('\n'), env);
}
