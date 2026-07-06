export type RenderScope = 'local_patch' | 'figure_patch' | 'project_patch' | 'code_patch' | 'data_patch';

export interface FigureRenderJob {
  projectId: string;
  figureId: string;
  requestId: string;
  scope: RenderScope;
  baseRevision: number;
  targetRevision: number;
  editLogHash: string;
  scriptHash: string;
  dataHash: string;
  renderOptionsHash: string;
  createdAt: number;
}

export interface FigureRenderStatus {
  figureId: string;
  status: 'idle' | 'queued' | 'rendering' | 'success' | 'error';
  latestRequestId?: string;
  revision: number;
  message?: string;
}
