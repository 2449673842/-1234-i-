export const PLAN_ENTITLEMENT_POLICY_VERSION = 'draft-2026-07-15';

export type ProductPlan = 'anonymous' | 'free' | 'pro';
export type EntitlementEnforcementMode = 'observe' | 'enforce';

export interface PlanCapabilities {
  workspace: boolean;
  projectCreate: boolean;
  dataUpload: boolean;
  pythonRender: boolean;
  rRender: boolean;
  figureEditing: boolean;
  scientificExport: boolean;
  subplotExport: boolean;
  compositionProjects: boolean;
  aiPromptWorkflow: boolean;
  managedAiRewrite: boolean;
  priorityRenderQueue: boolean;
}

export interface PlanLimits {
  maxProjects: number | null;
  maxFilesPerUpload: number;
  maxFileBytes: number;
  maxRenderRequestsPerMinute: number;
  maxStoredBytes: number | null;
}

export interface PlanEntitlements {
  policyVersion: string;
  enforcementMode: EntitlementEnforcementMode;
  plan: ProductPlan;
  capabilities: PlanCapabilities;
  limits: PlanLimits;
  pendingCommercialReview: boolean;
}

const authenticatedCapabilities: PlanCapabilities = {
  workspace: true,
  projectCreate: true,
  dataUpload: true,
  pythonRender: true,
  rRender: true,
  figureEditing: true,
  scientificExport: true,
  subplotExport: true,
  compositionProjects: true,
  aiPromptWorkflow: true,
  managedAiRewrite: false,
  priorityRenderQueue: false,
};

const currentGlobalLimits: PlanLimits = {
  maxProjects: null,
  maxFilesPerUpload: 20,
  maxFileBytes: 50 * 1024 * 1024,
  maxRenderRequestsPerMinute: 30,
  maxStoredBytes: null,
};

export function resolvePlanEntitlements(input: { authenticated: boolean; isPro: boolean }): PlanEntitlements {
  const plan: ProductPlan = !input.authenticated ? 'anonymous' : input.isPro ? 'pro' : 'free';
  return {
    policyVersion: PLAN_ENTITLEMENT_POLICY_VERSION,
    enforcementMode: 'observe',
    plan,
    capabilities: input.authenticated
      ? { ...authenticatedCapabilities }
      : Object.fromEntries(Object.keys(authenticatedCapabilities).map(key => [key, false])) as unknown as PlanCapabilities,
    limits: { ...currentGlobalLimits },
    pendingCommercialReview: true,
  };
}
