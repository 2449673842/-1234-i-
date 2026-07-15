export type AdminSection = 'overview' | 'users' | 'subscriptions' | 'errors' | 'audit';

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
  source: string;
  severity: 'info' | 'warning' | 'error' | 'critical';
  status: 'open' | 'triaged' | 'resolved' | 'ignored';
  title: string;
  message: string;
  component: string | null;
  operation: string | null;
  errorName: string | null;
  errorCode: string | null;
  route: string | null;
  projectId: string | null;
  figureId: string | null;
  occurrenceCount: number;
  firstSeenAt: string;
  lastSeenAt: string;
  metadata: Record<string, unknown>;
}

export interface AdminAiRepairPackage {
  schemaVersion: 'scifigure.error-handoff.v1';
  generatedAt: string;
  eventId: string;
  source: string;
  severity: AdminErrorReport['severity'];
  status: AdminErrorReport['status'];
  title: string;
  message: string;
  errorName: string | null;
  errorCode: string | null;
  component: string | null;
  operation: string | null;
  route: string | null;
  projectId: string | null;
  figureId: string | null;
  clientVersion: string | null;
  userAgentFamily: string | null;
  occurrenceCount: number;
  firstSeenAt: string;
  lastSeenAt: string;
  metadata: Record<string, unknown>;
  suggestedCodeAreas: string[];
  suggestedChecks: string[];
  privacyBoundary: { classification: string; excluded: string[] };
}

export interface AdminSubscriptionRow {
  userId: string;
  email: string;
  displayName: string | null;
  subscriptionId: string | null;
  plan: 'free' | 'pro';
  status: 'active' | 'paused' | 'expired' | 'none';
  startsAt: string | null;
  endsAt: string | null;
  source: string;
  actorUserId: string | null;
  changeReason: string | null;
  adminNote: string | null;
  createdAt: string | null;
  historyCount: number;
}

export interface AdminSubscriptionAdjustment {
  plan: 'free' | 'pro';
  status: 'active' | 'paused' | 'expired';
  endsAt: string | null;
  reason: string;
  adminNote?: string | null;
  requestId: string;
  reauthToken: string;
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
