'use strict';

/**
 * V2-5.4 — Electron main RBAC session + channel policy.
 * Session is bound per webContents; privileged channels require an active session.
 */

const ROLE_RANK = {
  employee: 1,
  reception: 2,
  accountant: 3,
  admin: 4,
  hq_admin: 5,
  owner: 6,
  custom: 2,
};

/** Channels that anyone (even pre-login) may call — boot / Google bind / license pull. */
const PUBLIC_CHANNELS = new Set([
  'app:getRuntimeInfo',
  'app:consumeLicenseWipeFlag',
  'app:getDeviceFingerprintParts',
  'database:status',
  'database:hydrate',
  'messaging:getStatus',
  'devices:getStatus',
  'devices:listPrinters',
  'backup:getCloudStatus',
  'backup:listCloudProviders',
  'backup:startOAuth',
  'backup:connectGoogle',
  'backup:registerCloudAccount',
  'backup:disconnectCloud',
  'backup:listCloudBackups',
  'backup:downloadCloudBackup',
  'backup:listDbBackups',
  'backup:verifyCloudBackup',
  'backup:verifyDbBackup',
  'backup:v2:health',
  'backup:v2:formatPolicy',
  'backup:v2:gate',
  'cache:getStatus',
  'cache:readLicense',
  'cache:readVersions',
  'cache:readBranchConfig',
  // Pre-login / activation may snapshot license into Electron cache before RBAC bind.
  'cache:writeLicense',
  'cache:writeVersions',
  'cache:writeBranchConfig',
  'communication:getStatus',
  'communication:listProviders',
  'cloudOAuth:getSettings',
  'cloudOAuth:testConnection',
  'license:readActivationBundle',
  'rbac:bindSession',
  'rbac:clearSession',
  'rbac:getSession',
  'dialog:confirmSync',
  'dialog:promptSync',
  // One-time bootstrap only when main users KV is empty (never a general trust path).
  'database:seedUsersIfEmpty',
  'database:enableSqlitePrimary',
]);

/** Minimum role rank (or capability tags) for privileged channels. */
const CHANNEL_POLICY = {
  'database:persistTable': { minRank: 2 },
  'database:persistKv': { minRank: 2 },
  'database:migrateFromBackup': { minRank: 4 },
  'database:exportSnapshot': { minRank: 3 },
  'database:syncOp': { minRank: 2 },
  'database:querySafe': { minRank: 1 },
  'backup:saveLocal': { minRank: 4 },
  // Pre-login license push from activation gate needs public upload; keep destructive restore gated.
  'backup:uploadCloud': { public: true },
  'backup:uploadSyncFile': { minRank: 2 },
  'backup:downloadSyncFile': { minRank: 2 },
  'backup:uploadDbBackup': { minRank: 4 },
  'backup:syncDbBackup': { minRank: 4 },
  'backup:deleteCloudBackup': { minRank: 4 },
  'backup:v2:create': { minRank: 4 },
  'backup:v2:restore': { minRank: 4 },
  'backup:v2:restoreLatest': { minRank: 4 },
  'backup:v2:downloadAndRestore': { minRank: 4 },
  'backup:restoreDbBackup': { minRank: 4 },
  'attachments:validate': { minRank: 2 },
  'attachments:hashBuffer': { minRank: 2 },
  'attachments:writeLocal': { minRank: 2 },
  'attachments:readLocal': { minRank: 2 },
  'attachments:existsLocal': { minRank: 2 },
  'app:wipePersistentLicenseData': { minRank: 6, roles: ['owner'] },
  'license:writeLicenseShard': { minRank: 4 },
  'license:writeActivationBundle': { minRank: 4 },
  'license:updateLicenseIndex': { minRank: 4 },
  'cloudOAuth:saveSettings': { minRank: 4 },
  'cloudOAuth:restoreDefaults': { minRank: 4 },
  'devices:openCashDrawer': { minRank: 2, permissions: ['cash.edit', 'cash.view'] },
  'devices:openCashDrawerDirect': { minRank: 2, permissions: ['cash.edit'] },
  'devices:printThermal': { minRank: 2, permissions: ['reports.print', 'cases.view'] },
  'devices:printA4': { minRank: 2, permissions: ['reports.print'] },
  'devices:exportA4Pdf': { minRank: 2, permissions: ['reports.print'] },
};

const sessions = new Map(); // webContents.id -> session

function rankOf(role) {
  return ROLE_RANK[String(role || '').toLowerCase()] || 0;
}

function getSession(event) {
  const id = event?.sender?.id;
  if (id == null) return null;
  return sessions.get(id) || null;
}

function bindSession(event, claim) {
  claim = claim || {};
  const id = event?.sender?.id;
  if (id == null) return { ok: false, error: 'no_sender' };
  const userId = String(claim.userId || claim.id || '').trim();
  const role = String(claim.role || '').trim().toLowerCase();
  if (!userId) return { ok: false, error: 'user_id_required' };
  if (!ROLE_RANK[role] && role !== 'custom') return { ok: false, error: 'invalid_role' };

  // Authoritative lookup from main-process KV. Renderer claims are NEVER trusted when KV is empty.
  let authoritativeRole = role;
  let branchScope = Array.isArray(claim.branchScope) ? claim.branchScope.slice() : ['*'];
  let permissions = claim.permissions && typeof claim.permissions === 'object' ? claim.permissions : null;
  // Synthetic developer account is never stored in KV users (local support only).
  const isDevAccount = userId === '__dev__' && (role === 'admin' || role === 'owner');
  if (!isDevAccount) {
    if (typeof claim.lookupUsers !== 'function') {
      return { ok: false, error: 'authoritative_lookup_required', action: 'refresh_users' };
    }
    let users = [];
    try {
      users = claim.lookupUsers() || [];
    } catch {
      return { ok: false, error: 'authoritative_lookup_failed', action: 'refresh_users' };
    }
    if (!users.length) {
      // DENY — caller must seedUsersIfEmpty then retry. Never trust renderer claim.
      return { ok: false, error: 'users_kv_empty', action: 'refresh_users' };
    }
    const real = users.find((u) => u && String(u.id) === userId && u.active !== false);
    if (!real) return { ok: false, error: 'user_not_found', action: 'refresh_users' };
    if (real.active === false) return { ok: false, error: 'user_disabled' };
    authoritativeRole = String(real.role || '').toLowerCase();
    if (Array.isArray(real.branchScope)) branchScope = real.branchScope.slice();
    if (real.permissions) permissions = real.permissions;
    if (role && role !== authoritativeRole) {
      return { ok: false, error: 'tampered_role', expected: authoritativeRole, claimed: role };
    }
  }

  const session = {
    userId,
    role: authoritativeRole,
    branchScope,
    permissions,
    boundAt: new Date().toISOString(),
    rank: rankOf(authoritativeRole),
  };
  sessions.set(id, session);
  return { ok: true, session: { userId: session.userId, role: session.role, boundAt: session.boundAt } };
}

function clearSession(event) {
  const id = event?.sender?.id;
  if (id != null) sessions.delete(id);
  return { ok: true };
}

function sessionAllowsChannel(session, channel) {
  if (PUBLIC_CHANNELS.has(channel)) return { ok: true, public: true };
  const policy = CHANNEL_POLICY[channel];
  if (policy && policy.public === true) return { ok: true, public: true };
  if (!policy) {
    // Unknown privileged channel: require any authenticated session.
    if (!session) return { ok: false, error: 'rbac_session_required' };
    return { ok: true };
  }
  if (!session) return { ok: false, error: 'rbac_session_required' };
  if (Array.isArray(policy.roles) && policy.roles.length) {
    if (!policy.roles.includes(session.role)) {
      return { ok: false, error: 'rbac_role_denied', required: policy.roles, role: session.role };
    }
  }
  if (policy.minRank != null && session.rank < policy.minRank) {
    return { ok: false, error: 'rbac_rank_denied', minRank: policy.minRank, rank: session.rank };
  }
  if (Array.isArray(policy.permissions) && policy.permissions.length) {
    // Managers/owner bypass permission tags.
    if (session.rank >= 4) return { ok: true };
    const perms = session.permissions || {};
    const ok = policy.permissions.some((p) => perms[p]);
    if (!ok) return { ok: false, error: 'rbac_permission_denied', permissions: policy.permissions };
  }
  return { ok: true };
}

function assertChannelAllowed(event, channel) {
  if (PUBLIC_CHANNELS.has(channel)) return { ok: true, public: true };
  const session = getSession(event);
  const gate = sessionAllowsChannel(session, channel);
  if (!gate.ok) {
    const err = new Error(gate.error || 'rbac_denied');
    err.code = gate.error || 'RBAC_DENIED';
    err.ok = false;
    err.rbac = gate;
    throw err;
  }
  return gate;
}

function assertBranchInSession(event, branchId) {
  if (!branchId) return { ok: true };
  const session = getSession(event);
  if (!session) return { ok: false, error: 'rbac_session_required' };
  const scope = session.branchScope || [];
  if (scope.includes('*') || scope.includes(branchId)) return { ok: true };
  return { ok: false, error: 'branch_access_denied', branchId };
}

module.exports = {
  ROLE_RANK,
  PUBLIC_CHANNELS,
  CHANNEL_POLICY,
  bindSession,
  clearSession,
  getSession,
  sessionAllowsChannel,
  assertChannelAllowed,
  assertBranchInSession,
  rankOf,
};
