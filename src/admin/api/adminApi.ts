import type {
  AdminAuditLog,
  AdminAiRepairPackage,
  AdminErrorReport,
  AdminOverview,
  AdminSubscriptionAdjustment,
  AdminSubscriptionRow,
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

  async errorRepairPackage(id: string): Promise<AdminAiRepairPackage> {
    const response = await fetch(`/api/admin/error-reports/${encodeURIComponent(id)}/ai-handoff`);
    const data = await readJson<{ repairPackage: AdminAiRepairPackage }>(response);
    return data.repairPackage;
  },

  async errorRepairMarkdown(id: string): Promise<string> {
    const response = await fetch(`/api/admin/error-reports/${encodeURIComponent(id)}/ai-handoff?format=markdown`);
    if (!response.ok) await readJson(response);
    return response.text();
  },

  async subscriptions(input: { page: number; pageSize: number; query?: string }): Promise<PaginatedResponse<AdminSubscriptionRow>> {
    const response = await fetch(`/api/admin/subscriptions${queryString(input)}`);
    return readJson<PaginatedResponse<AdminSubscriptionRow>>(response);
  },

  async reauth(password: string): Promise<{ reauthToken: string; expiresAt: string }> {
    const response = await fetch('/api/admin/reauth', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password }),
    });
    return readJson<{ status: 'success'; reauthToken: string; expiresAt: string }>(response);
  },

  async adjustSubscription(userId: string, input: AdminSubscriptionAdjustment): Promise<{ replayed: boolean }> {
    const response = await fetch(`/api/admin/users/${encodeURIComponent(userId)}/subscription`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    });
    return readJson<{ status: 'success'; replayed: boolean }>(response);
  },

  async auditLogs(limit = 100): Promise<AdminAuditLog[]> {
    const response = await fetch(`/api/admin/audit-logs?limit=${Math.max(1, Math.min(500, limit))}`);
    const data = await readJson<{ logs: AdminAuditLog[] }>(response);
    return data.logs;
  },
};
