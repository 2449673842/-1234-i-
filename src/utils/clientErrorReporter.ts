export type ClientErrorSource = 'client' | 'render' | 'export' | 'import' | 'editor';

export interface ClientErrorReportInput {
  source: ClientErrorSource;
  severity?: 'info' | 'warning' | 'error' | 'critical';
  title: string;
  message: string;
  component?: string | null;
  operation?: string | null;
  errorCode?: string | null;
  projectId?: string | null;
  figureId?: string | null;
  metadata?: Record<string, string | number | boolean | null | undefined>;
}

const recentReports = new Map<string, number>();
const REPORT_DEDUPE_MS = 30_000;

function sanitizeClientText(value: unknown, maxLength: number): string {
  return String(value ?? '')
    .replace(/[A-Za-z]:\\[^\s'"<>]+/g, '[local-path]')
    .replace(/\/(?:home|Users|var|srv|opt|etc)\/[^\s'"<>]+/g, '[local-path]')
    .replace(/([?&](?:token|key|secret|code)=)[^&\s]+/gi, '$1[redacted]')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLength);
}

export async function reportClientError(input: ClientErrorReportInput): Promise<boolean> {
  const title = sanitizeClientText(input.title, 160);
  const message = sanitizeClientText(input.message, 1200);
  if (!title || !message) return false;

  const dedupeKey = `${input.source}:${input.component || ''}:${input.operation || ''}:${input.errorCode || ''}:${title}:${message}`;
  const now = Date.now();
  if (now - (recentReports.get(dedupeKey) || 0) < REPORT_DEDUPE_MS) return true;
  recentReports.set(dedupeKey, now);

  try {
    const response = await fetch('/api/error-reports', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      keepalive: true,
      body: JSON.stringify({
        source: input.source,
        severity: input.severity || 'error',
        title,
        message,
        component: sanitizeClientText(input.component, 120) || null,
        operation: sanitizeClientText(input.operation, 120) || null,
        errorCode: sanitizeClientText(input.errorCode, 80) || null,
        route: window.location.pathname.slice(0, 240),
        projectId: sanitizeClientText(input.projectId, 120) || null,
        figureId: sanitizeClientText(input.figureId, 120) || null,
        userAgent: navigator.userAgent.slice(0, 300),
        metadata: Object.fromEntries(
          Object.entries(input.metadata || {}).slice(0, 12).map(([key, value]) => [
            sanitizeClientText(key, 60),
            typeof value === 'string' ? sanitizeClientText(value, 240) : value,
          ]),
        ),
      }),
    });
    return response.ok;
  } catch {
    return false;
  }
}

export function installGlobalErrorReporting(): () => void {
  const onError = (event: ErrorEvent) => {
    void reportClientError({
      source: 'client',
      title: '页面运行错误',
      message: event.message || '浏览器报告了未知运行错误',
      component: 'window',
      operation: 'runtime.error',
      errorCode: 'window_error',
      metadata: { line: event.lineno || null, column: event.colno || null },
    });
  };
  const onUnhandledRejection = (event: PromiseRejectionEvent) => {
    const reason = event.reason instanceof Error ? event.reason.message : String(event.reason || '未知 Promise 异常');
    void reportClientError({
      source: 'client',
      title: '未处理的异步错误',
      message: reason,
      component: 'window',
      operation: 'runtime.unhandled_rejection',
      errorCode: 'unhandled_rejection',
    });
  };
  window.addEventListener('error', onError);
  window.addEventListener('unhandledrejection', onUnhandledRejection);
  return () => {
    window.removeEventListener('error', onError);
    window.removeEventListener('unhandledrejection', onUnhandledRejection);
  };
}
