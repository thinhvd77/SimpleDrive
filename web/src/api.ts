export type User = {
  id: string;
  employeeCode: string;
  name: string;
  role: "admin" | "employee";
  quota: number;
  disabled: boolean;
  used?: number;
};
export type Session = {
  user: User;
  csrf: string;
  limits: {
    maxFileBytes: number;
    retentionHours: number;
    driveEnabled: boolean;
  };
};
export type DriveFile = {
  id: string;
  ownerId: string;
  name: string;
  source: string;
  status: string;
  size: number;
  reserved: number;
  received: number;
  sha256: string | null;
  error: string | null;
  createdAt: string;
  expiresAt: string | null;
};
export async function api<T>(
  path: string,
  options: RequestInit = {},
  csrf?: string,
): Promise<T> {
  const response = await fetch(`/api${path}`, {
    ...options,
    credentials: "same-origin",
    headers: {
      ...(options.body ? { "Content-Type": "application/json" } : {}),
      ...(csrf ? { "X-CSRF-Token": csrf } : {}),
      ...options.headers,
    },
  });
  const body = await response.json().catch(() => ({}));
  if (response.status === 401 && path !== "/auth/login")
    window.dispatchEvent(new Event("simpledrive:unauthorized"));
  if (!response.ok)
    throw new Error(body.message ?? "Không thể kết nối tới máy chủ.");
  return body as T;
}
export const bytes = (n: number) =>
  n >= 1e9
    ? `${(n / 1e9).toLocaleString("vi-VN", { maximumFractionDigits: 1 })} GB`
    : n >= 1e6
      ? `${(n / 1e6).toLocaleString("vi-VN", { maximumFractionDigits: 1 })} MB`
      : n >= 1e3
        ? `${(n / 1e3).toLocaleString("vi-VN", { maximumFractionDigits: 1 })} KB`
        : `${n} B`;
export const date = (value: string) =>
  new Intl.DateTimeFormat("vi-VN", {
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
