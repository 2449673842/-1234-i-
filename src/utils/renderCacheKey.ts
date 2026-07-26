import { stableHash, stableStringify } from './stableJson';

export const FIGURE_RENDER_CACHE_KEY_SCHEMA_VERSION = 2;

export interface FigureRenderCacheAuthority {
  rendererSource?: string;
  rendererImage?: string;
  rendererRuntime?: string;
  rendererPackageContract?: unknown;
  source?: string;
  image?: string;
  runtime?: string;
  packageContract?: unknown;
}

export interface FigureRenderCacheKeyInput {
  engine: 'python_matplotlib' | 'r_ggplot' | string;
  projectId: string;
  figureId: string;
  script: string;
  dataPayload: unknown;
  figureFingerprint?: string;
  editLog: unknown[];
  renderOptions: unknown;
  rendererAuthority?: FigureRenderCacheAuthority;
  rendererSource?: string;
  rendererImage?: string;
  rendererRuntime?: string;
  rendererPackageContract?: unknown;
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

function normalizeRendererAuthority(input: FigureRenderCacheKeyInput): Required<Pick<
  FigureRenderCacheAuthority,
  'rendererSource' | 'rendererImage' | 'rendererRuntime' | 'rendererPackageContract'
>> {
  const authority = input.rendererAuthority || {};

  return {
    rendererSource: input.rendererSource ?? authority.rendererSource ?? authority.source ?? 'unspecified',
    rendererImage: input.rendererImage ?? authority.rendererImage ?? authority.image ?? 'unspecified',
    rendererRuntime: input.rendererRuntime ?? authority.rendererRuntime ?? authority.runtime ?? 'unspecified',
    rendererPackageContract: input.rendererPackageContract ?? authority.rendererPackageContract ?? authority.packageContract ?? 'unspecified',
  };
}

export async function buildFigureRenderCacheKey(input: FigureRenderCacheKeyInput): Promise<string> {
  const cacheKeyObject = {
    cacheSchemaVersion: FIGURE_RENDER_CACHE_KEY_SCHEMA_VERSION,
    engine: input.engine,
    projectId: input.projectId,
    figureId: input.figureId,
    rendererAuthority: normalizeRendererAuthority(input),
    scriptHash: await stableHash(input.script || ''),
    dataHash: await stableHash(stableStringify(input.dataPayload || {})),
    figureFingerprint: input.figureFingerprint || '',
    editLogHash: await stableHash(stableStringify(normalizeEditLogForCache(input.editLog || []))),
    renderOptionsHash: await stableHash(stableStringify(input.renderOptions || {})),
  };

  return stableHash(stableStringify(cacheKeyObject));
}
