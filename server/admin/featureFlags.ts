export function adminConsoleEnabled(): boolean {
  return process.env.SCIFIGURE_ADMIN_CONSOLE_ENABLED === '1';
}

export function adminOperationsEnabled(): boolean {
  const explicit = process.env.SCIFIGURE_ADMIN_OPERATIONS_ENABLED;
  return explicit === undefined ? adminConsoleEnabled() : explicit === '1';
}
