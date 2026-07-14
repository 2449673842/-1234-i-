export type AdminSection = 'overview' | 'users' | 'errors' | 'audit';

export interface AdminUserIdentity {
  id: string;
  email: string;
  displayName: string | null;
  role: 'user' | 'admin';
}

export interface AdminOverview {
  counts: {
    users: number;
    projects: number;
    figures: number;
    files: number;
    exports: number;
    errorReports: number;
    openErrors: number;
  };
  activity: {
    activeUsers24h: number;
    renderFailures24h: number;
    adminFailures24h: number;
  };
  process: {
    uptimeSeconds: number;
    rssBytes: number;
    heapUsedBytes: number;
  };
  renderer: {
    active: number;
    queued: number;
    workers: number;
    concurrency: number;
  };
  collectedAt: string;
}

export interface AdminUserRow {
  id: string;
  email: string;
  displayName: string | null;
  role: 'user' | 'admin';
  createdAt: string;
  lastLoginAt: string | null;
  projectCount: number;
  figureCount: number;
  fileCount: number;
  exportCount: number;
  activeSessionCount: number;
  subscriptionPlan: string | null;
  subscriptionStatus: string | null;
  subscriptionEndsAt: string | null;
}

export interface AdminErrorReport {
  id: string;
  userId: string | null;
  userEmail?: string | null;
  source: string;
  severity: 'info' | 'warning' | 'error' | 'critical';
  status: 'open' | 'triaged' | 'resolved' | 'ignored';
  title: string;
  message: string;
  errorCode: string | null;
  route: string | null;
  projectId: string | null;
  figureId: string | null;
  occurrenceCount: number;
  firstSeenAt: string;
  lastSeenAt: string;
  metadata: Record<string, unknown>;
}

export interface AdminAuditLog {
  id: string;
  actorUserId: string | null;
  action: string;
  resourceType: string | null;
  resourceId: string | null;
  success: boolean;
  statusCode: number | null;
  ipAddress: string | null;
  userAgent: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
}

export interface PaginatedResponse<T> {
  status: 'success';
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}

export class AdminApiError extends Error {
  constructor(message: string, public statusCode: number) {
    super(message);
  }
}
