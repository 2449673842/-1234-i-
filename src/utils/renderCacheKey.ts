import { stableHash, stableStringify } from './stableJson';

export interface FigureRenderCacheKeyInput {
  engine: 'python_matplotlib' | 'r_ggplot' | string;
  projectId: string;
  figureId: string;
  script: string;
  dataPayload: unknown;
  figureFingerprint?: string;
  editLog: unknown[];
  renderOptions: unknown;
}

function normalizeEditLogForCache(editLog: unknown[]): unknown[] {
  return editLog.map((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      return entry;
    }

    const { timestamp: _timestamp, requestId: _requestId, ...semanticEntry } = entry as Record<string, unknown>;
    return semanticEntry;
  });
}

export async function buildFigureRenderCacheKey(input: FigureRenderCacheKeyInput): Promise<string> {
  const cacheKeyObject = {
    engine: input.engine,
    projectId: input.projectId,
    figureId: input.figureId,
    scriptHash: await stableHash(input.script || ''),
    dataHash: await stableHash(stableStringify(input.dataPayload || {})),
    figureFingerprint: input.figureFingerprint || '',
    editLogHash: await stableHash(stableStringify(normalizeEditLogForCache(input.editLog || []))),
    renderOptionsHash: await stableHash(stableStringify(input.renderOptions || {})),
  };

  return stableHash(stableStringify(cacheKeyObject));
}
