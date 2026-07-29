const REPLAY_CONFLICT_TYPES = new Set([
  'missing_gid',
  'identity_mismatch',
  'ambiguous_identity',
  'unsupported_prop',
  'no_setter',
]);

const LEGACY_TYPED_REPLAY_WARNING = /^\s*(?:\[\s*)?(?:missing_gid|identity_mismatch|ambiguous_identity|unsupported_prop|no_setter|unsupported_[a-z0-9_.-]+|apply_error(?::[a-z0-9_.-]+)?)(?:\s*\])?(?:\s*[:=-]|\s|$)/i;

export function isRendererReplayConflictWarning(warning: unknown): boolean {
  if (warning && typeof warning === 'object') {
    const type = String((warning as { type?: unknown }).type || '').trim().toLowerCase();
    return REPLAY_CONFLICT_TYPES.has(type)
      || type.startsWith('unsupported_')
      || type.startsWith('apply_error:');
  }

  if (typeof warning !== 'string') return false;
  return LEGACY_TYPED_REPLAY_WARNING.test(warning);
}
