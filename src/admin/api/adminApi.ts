import type {
  AdminAuditLog,
  AdminErrorReport,
  AdminOverview,
  AdminUserIdentity,
  AdminUserRow,
  PaginatedResponse,
} from '../types';
import { AdminApiError } from '../types';

async function readJson<T>(response: Response): Promise<T> {
  const data = await response.json().catch(() => null);
  if (!response.ok) {
    if (response.status === 403) window.dispatchEvent(new CustomEvent('scifigure:admin-access-revoked'));
    throw new AdminApiError(data?.message || `请求失败 (${response.status})`, response.status);
  }
  return data as T;
}

function queryString(input: Record<string, string | number | undefined>): string {
  const params = new URLSearchParams();
  Object.entries(input).forEach(([key, value]) => {
    if (value !== undefined && String(value).trim()) params.set(key, String(value));
  });
  const value = params.toString();
  return value ? `?${value}` : '';
}

export const adminApi = {
  async currentUser(): Promise<AdminUserIdentity> {
    const response = await fetch('/api/auth/me');
    const data = await readJson<{ user: AdminUserIdentity }>(response);
    if (!data?.user) throw new AdminApiError('请先登录', 401);
    return data.user;
  },

  async overview(): Promise<AdminOverview> {
    const response = await fetch('/api/admin/overview');
    const data = await readJson<{ overview: AdminOverview }>(response);
    return data.overview;
  },

  async users(input: { page: number; pageSize: number; query?: string; role?: string }): Promise<PaginatedResponse<AdminUserRow>> {
    const response = await fetch(`/api/admin/users${queryString(input)}`);
    return readJson<PaginatedResponse<AdminUserRow>>(response);
  },

  async errorReports(input: { page: number; pageSize: number; query?: string; source?: string; severity?: string; status?: string }): Promise<PaginatedResponse<AdminErrorReport>> {
    const response = await fetch(`/api/admin/error-reports${queryString(input)}`);
    return readJson<PaginatedResponse<AdminErrorReport>>(response);
  },

  async auditLogs(limit = 100): Promise<AdminAuditLog[]> {
    const response = await fetch(`/api/admin/audit-logs?limit=${Math.max(1, Math.min(500, limit))}`);
    const data = await readJson<{ logs: AdminAuditLog[] }>(response);
    return data.logs;
  },
};
