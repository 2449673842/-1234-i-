import {
  sanitizeLegacyRetireObservationBatch,
  sanitizeLegacyRetireObservationEvent,
  type LegacyRetireObservationEvent,
} from './legacyRetireObservation';

const ENDPOINT = '/api/internal/legacy-retire-observation';
const FLUSH_DELAY_MS = 250;
const MAX_QUEUE_SIZE = 500;
const MAX_BATCH_SIZE = 100;

let queue: LegacyRetireObservationEvent[] = [];
let flushTimer: ReturnType<typeof setTimeout> | null = null;

function observabilityEnabled(): boolean {
  const viteValue = (import.meta as ImportMeta & { env?: Record<string, string | undefined> })
    .env?.VITE_SCIFIGURE_LEGACY_RETIRE_OBSERVABILITY;
  const processValue = typeof process !== 'undefined'
    ? process.env?.VITE_SCIFIGURE_LEGACY_RETIRE_OBSERVABILITY
    : undefined;
  return (viteValue ?? processValue) === '1';
}

function clearTimer() {
  if (!flushTimer) return;
  clearTimeout(flushTimer);
  flushTimer = null;
}

function scheduleFlush() {
  if (flushTimer || !observabilityEnabled()) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    void flushLegacyRetireObservationQueue();
  }, FLUSH_DELAY_MS);
}

export function recordLegacyRetireObservation(input: unknown): void {
  if (!observabilityEnabled()) return;
  const event = sanitizeLegacyRetireObservationEvent(input);
  if (!event) return;
  queue.push(event);
  if (queue.length > MAX_QUEUE_SIZE) {
    queue = queue.slice(queue.length - MAX_QUEUE_SIZE);
  }
  scheduleFlush();
}

export async function flushLegacyRetireObservationQueue(): Promise<void> {
  clearTimer();
  if (!observabilityEnabled() || queue.length === 0) return;
  if (typeof fetch !== 'function') {
    queue = [];
    return;
  }

  const batch = sanitizeLegacyRetireObservationBatch(queue.splice(0, MAX_BATCH_SIZE), MAX_BATCH_SIZE);
  if (batch.length === 0) return;
  try {
    await fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ events: batch }),
      keepalive: true,
    });
  } catch {
    // Observation must never affect editing.
  }

  if (queue.length > 0) scheduleFlush();
}

export function clearLegacyRetireObservationQueue(): void {
  clearTimer();
  queue = [];
}
