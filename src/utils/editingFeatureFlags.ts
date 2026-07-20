export interface EditingFeatureFlags {
  targetResolverShadow: boolean;
  targetResolverLegacyAdapter: boolean;
  generalTargetResolverV2: boolean;
  fontTargetResolverV2: boolean;
  componentTargetResolverV2: boolean;
  paletteTargetResolverV2: boolean;
  crossFigureIdentityV2: boolean;
  crossFigureLegacyScoreAdapter: boolean;
  releaseCandidateId: string;
}

type EditingFeatureEnvironment = Record<string, string | boolean | undefined>;

function booleanFlag(
  environment: EditingFeatureEnvironment,
  name: string,
  defaultValue: boolean,
): boolean {
  const value = environment[name];
  if (value === true || value === '1' || value === 'true') return true;
  if (value === false || value === '0' || value === 'false') return false;
  return defaultValue;
}

function currentEnvironment(): EditingFeatureEnvironment {
  // Vite replaces import.meta.env at build time. Changing these flags requires
  // rebuilding the frontend and deploying a new immutable release.
  return ((import.meta as ImportMeta & {
    env?: EditingFeatureEnvironment;
  }).env) ?? {};
}

export function resolveEditingFeatureFlags(
  environment: EditingFeatureEnvironment = currentEnvironment(),
): EditingFeatureFlags {
  return {
    targetResolverShadow: booleanFlag(
      environment,
      'VITE_SCIFIGURE_TARGET_RESOLVER_SHADOW',
      false,
    ),
    targetResolverLegacyAdapter: booleanFlag(
      environment,
      'VITE_SCIFIGURE_TARGET_RESOLVER_LEGACY_ADAPTER',
      true,
    ),
    generalTargetResolverV2: booleanFlag(
      environment,
      'VITE_SCIFIGURE_GENERAL_TARGET_RESOLVER_V2',
      true,
    ),
    fontTargetResolverV2: booleanFlag(
      environment,
      'VITE_SCIFIGURE_FONT_TARGET_RESOLVER_V2',
      true,
    ),
    componentTargetResolverV2: booleanFlag(
      environment,
      'VITE_SCIFIGURE_COMPONENT_TARGET_RESOLVER_V2',
      true,
    ),
    paletteTargetResolverV2: booleanFlag(
      environment,
      'VITE_SCIFIGURE_PALETTE_TARGET_RESOLVER_V2',
      true,
    ),
    crossFigureIdentityV2: booleanFlag(
      environment,
      'VITE_SCIFIGURE_CROSS_FIGURE_IDENTITY_V2',
      true,
    ),
    crossFigureLegacyScoreAdapter: booleanFlag(
      environment,
      'VITE_SCIFIGURE_CROSS_FIGURE_LEGACY_SCORE_ADAPTER',
      false,
    ),
    releaseCandidateId: String(
      environment.VITE_SCIFIGURE_RELEASE_CANDIDATE_ID || 'local',
    ),
  };
}

export const EDITING_FEATURE_FLAGS = resolveEditingFeatureFlags();
