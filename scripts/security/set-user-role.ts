import { getUserByEmail, logAdminAudit, setUserRoleByEmail, type UserRole } from '../../db';

function readArg(name: string): string | null {
  const index = process.argv.indexOf(`--${name}`);
  if (index < 0) return null;
  return process.argv[index + 1]?.trim() || null;
}

function fail(message: string): never {
  console.error(JSON.stringify({ status: 'error', message }, null, 2));
  process.exit(1);
}

const email = readArg('email')?.toLowerCase();
const role = readArg('role') as UserRole | null;
const reason = readArg('reason') || 'manual_security_provisioning';

if (!email) fail('Missing --email');
if (role !== 'user' && role !== 'admin') fail('Missing or invalid --role; expected user or admin');

const existing = getUserByEmail(email);
if (!existing) fail(`User not found: ${email}`);

const previousRole: UserRole = existing.role === 'admin' ? 'admin' : 'user';
const user = setUserRoleByEmail(email, role);
logAdminAudit({
  actorUserId: null,
  action: 'user_role.set_offline',
  resourceType: 'user',
  resourceId: user.id,
  success: true,
  statusCode: 200,
  metadata: {
    email: user.email,
    previousRole,
    nextRole: user.role,
    reason,
    actor: 'offline_cli',
  },
});

console.log(JSON.stringify({
  status: 'success',
  user: {
    id: user.id,
    email: user.email,
    role: user.role,
  },
  previousRole,
  reason,
}, null, 2));
