/**
 * Branch Scope (user account) + activeBranchId session.
 * Device branch lock is sync/diagnostics only — permissions use user.branchScope.
 */
(function (global) {
  'use strict';

  const ACTIVE_BRANCH_KEY = '__tdw_active_branch__';
  const DEFAULT_BRANCH_ID = 'BR-MAIN';

  const ROLE_DEFAULTS = {
    reception: { branchScope: null, canSwitchBranch: false },
    employee: { branchScope: null, canSwitchBranch: false },
    doctor: { branchScope: null, canSwitchBranch: false },
    accountant: { branchScope: ['*'], canSwitchBranch: true },
    branch_manager: { branchScope: null, canSwitchBranch: false },
    admin: { branchScope: ['*'], canSwitchBranch: true },
    owner: { branchScope: ['*'], canSwitchBranch: true },
    hq_admin: { branchScope: ['*'], canSwitchBranch: true }
  };

  function getDeviceBranchId() {
    if (global.DeviceConfig?.isBranchLocked?.()) {
      return global.DeviceConfig.getLockedBranchId() || DEFAULT_BRANCH_ID;
    }
    return global.DeviceConfig?.getLockedBranchId?.() || DEFAULT_BRANCH_ID;
  }

  function getActiveBranchId() {
    try {
      const raw = sessionStorage.getItem(ACTIVE_BRANCH_KEY);
      if (raw) return raw;
    } catch { /* empty */ }
    return getDeviceBranchId() || DEFAULT_BRANCH_ID;
  }

  function setActiveBranchId(branchId) {
    if (!branchId) return;
    try { sessionStorage.setItem(ACTIVE_BRANCH_KEY, branchId); } catch { /* empty */ }
    global.activeBranchId = branchId;
  }

  function clearActiveBranchId() {
    try { sessionStorage.removeItem(ACTIVE_BRANCH_KEY); } catch { /* empty */ }
    global.activeBranchId = getDeviceBranchId() || DEFAULT_BRANCH_ID;
  }

  function defaultScopeForRole(role) {
    const d = ROLE_DEFAULTS[role] || ROLE_DEFAULTS.reception;
    if (d.branchScope === null) {
      return { branchScope: [DEFAULT_BRANCH_ID], canSwitchBranch: !!d.canSwitchBranch };
    }
    return { branchScope: d.branchScope.slice(), canSwitchBranch: !!d.canSwitchBranch };
  }

  function applyDefaultScopeToUser(user) {
    if (!user || typeof user !== 'object') return user;
    if (Array.isArray(user.branchScope) && user.branchScope.length) return user;
    const defs = defaultScopeForRole(user.role);
    user.branchScope = defs.branchScope;
    user.canSwitchBranch = user.canSwitchBranch != null ? !!user.canSwitchBranch : defs.canSwitchBranch;
    return user;
  }

  function migrateUsersScope(users) {
    if (!Array.isArray(users)) return users;
    return users.map(u => applyDefaultScopeToUser({ ...u }));
  }

  function getUserBranchScope(user) {
    if (!user) return [];
    applyDefaultScopeToUser(user);
    const scope = Array.isArray(user.branchScope) ? user.branchScope : [];
    if (scope.length) return scope;
    return defaultScopeForRole(user.role).branchScope;
  }

  function canUserSwitchBranch(user) {
    if (!user) return false;
    applyDefaultScopeToUser(user);
    return !!user.canSwitchBranch;
  }

  function userCanAccessBranch(user, branchId) {
    if (!branchId) return true;
    const scope = getUserBranchScope(user);
    if (scope.includes('*')) return true;
    return scope.includes(branchId);
  }

  function filterByBranch(records, branchId) {
    if (!Array.isArray(records)) return records;
    branchId = branchId || getActiveBranchId();
    if (!branchId) return records.slice();
    return records.filter(r => {
      if (!r || typeof r !== 'object') return false;
      if (r.branchId) return r.branchId === branchId;
      // No silent BR-MAIN attribution when LegacyBranchMigration says unresolved.
      if (global.LegacyBranchMigration?.resolveLegacyBranchId) {
        const resolved = global.LegacyBranchMigration.resolveLegacyBranchId(r);
        if (resolved == null) return false;
        return resolved === branchId;
      }
      return branchId === DEFAULT_BRANCH_ID;
    });
  }

  /**
   * UI view filter:
   * - Device locked → locked branch only
   * - Owner Branch Mode → selected branch only (new branches start empty)
   * - Owner Mode overview → all records (Hub/analytics)
   * - Normal staff → active branch
   */
  function filterForActiveView(records) {
    if (!Array.isArray(records)) return [];
    if (global.DeviceConfig?.isBranchLocked?.()) {
      return filterByBranch(records, global.DeviceConfig.getLockedBranchId() || DEFAULT_BRANCH_ID);
    }
    if (global.OwnerBranchMode?.isBranchMode?.()) {
      return filterByBranch(records, global.OwnerBranchMode.getBranchId() || getActiveBranchId());
    }
    if (
      global.OwnerBranchMode?.isOwnerMode?.()
      && (global.RolePolicy?.isOrganizationOwner?.(global.currentUser)
        || String(global.currentUser?.role || '').toLowerCase() === 'owner')
    ) {
      return records.slice();
    }
    return filterByBranch(records, getActiveBranchId());
  }

  function ensureRecordBranch(record, branchId) {
    if (!record || typeof record !== 'object') return record;
    if (!record.branchId) {
      record.branchId = branchId || getActiveBranchId() || DEFAULT_BRANCH_ID;
    }
    const centerId = global.DeviceConfig?.getCenterIdFromConfig?.() || global.CenterId?.getStoredCenterId?.();
    if (centerId && !record.centerId) record.centerId = centerId;
    return record;
  }

  function guardBranchAccess(user, branchId, actionLabel) {
    if (userCanAccessBranch(user, branchId)) return true;
    if (typeof global.notify === 'function') {
      global.notify(actionLabel || '⛔ لا يمكنك الوصول لهذا الفرع', 'danger');
    }
    return false;
  }

  const TRUSTED_WRITE_SOURCES = new Set([
    'import',
    'import_legacy',
    'conflict_resolve',
    'wipe',
    'bootstrap',
    'sync',
    'poll',
    'push',
    'migration'
  ]);

  function assertWriteAllowed(user, branchId, options) {
    options = options || {};
    if (options.skipBranchGuard) return { ok: true, skipped: true };
    if (options.source && TRUSTED_WRITE_SOURCES.has(options.source)) {
      return { ok: true, skipped: true, source: options.source };
    }
    // V2-5.4: unauthenticated writes are denied (no silent skip).
    if (!user) {
      return { ok: false, error: 'not_authenticated', branchId: branchId || null };
    }
    // Prefer authoritative user (ignore forged role/scope on currentUser).
    let effective = user;
    if (global.RbacGuard?.resolveAuthoritativeUser) {
      effective = global.RbacGuard.resolveAuthoritativeUser(user) || user;
    }
    // V2-5.9: Owner Mode (cross-branch overview) is operational read-only unless explicit write flag.
    if (
      options.allowOwnerModeWrite !== true
      && global.OwnerBranchMode?.isOwnerMode?.()
      && (global.RolePolicy?.isOrganizationOwner?.(effective) || String(effective.role || '').toLowerCase() === 'owner')
    ) {
      return { ok: false, error: 'owner_mode_readonly', branchId: branchId || null };
    }
    // Authoritative write context — not deviceBound / not reporting-only selection.
    if (global.BranchContexts?.assertOperationalWriteContext && options.skipWriteContext !== true) {
      const ctx = global.BranchContexts.assertOperationalWriteContext({ user: effective });
      if (!ctx.ok) {
        return { ok: false, error: ctx.error || 'operational_write_branch_required', branchId: branchId || null };
      }
      if (branchId && ctx.branchId && branchId !== ctx.branchId && options.allowCrossWrite !== true) {
        return { ok: false, error: 'write_branch_mismatch', branchId, writeBranch: ctx.branchId };
      }
      if (!branchId) branchId = ctx.branchId;
    }
    if (!branchId) return { ok: true, user: effective };
    if (userCanAccessBranch(effective, branchId)) return { ok: true, branchId, user: effective };
    try {
      global.RbacGuard?.auditDenial?.({
        userId: effective.id, role: effective.role, resource: branchId,
        reason: 'branch_access_denied', entity: 'branch',
      });
    } catch { /* empty */ }
    return { ok: false, error: 'branch_access_denied', branchId };
  }

  function filterByUserScope(records, user) {
    if (!Array.isArray(records)) return records;
    const scope = getUserBranchScope(user);
    if (!scope.length || scope.includes('*')) return records.slice();
    return records.filter((r) => {
      if (!r || typeof r !== 'object') return false;
      const bid = r.branchId || DEFAULT_BRANCH_ID;
      return scope.includes(bid);
    });
  }

  /** Branches the user may activate/select (license enrolled ∩ membership scope). */
  function listAuthorizedBranches(user, doc) {
    doc = doc || global.LicenseCloud?.loadLocal?.() || {};
    const enrolled = (doc.branches || []).filter((b) => b && b.active !== false);
    if (!user) return enrolled.slice();
    const scope = getUserBranchScope(user);
    if (!scope.length || scope.includes('*')) return enrolled.slice();
    return enrolled.filter((b) => scope.includes(b.id));
  }

  function initSessionBranch() {
    const user = global.currentUser;
    if (!user) {
      global.activeBranchId = getActiveBranchId();
      return;
    }
    const scope = getUserBranchScope(user);
    const preferred = scope.includes('*')
      ? (getDeviceBranchId() || DEFAULT_BRANCH_ID)
      : (scope[0] || DEFAULT_BRANCH_ID);
    if (!canUserSwitchBranch(user)) {
      setActiveBranchId(preferred);
      return;
    }
    const current = getActiveBranchId();
    if (!userCanAccessBranch(user, current)) {
      setActiveBranchId(preferred);
    } else {
      global.activeBranchId = current;
    }
  }

  global.BranchScope = {
    ACTIVE_BRANCH_KEY,
    DEFAULT_BRANCH_ID,
    ROLE_DEFAULTS,
    getDeviceBranchId,
    getActiveBranchId,
    setActiveBranchId,
    clearActiveBranchId,
    defaultScopeForRole,
    applyDefaultScopeToUser,
    migrateUsersScope,
    getUserBranchScope,
    canUserSwitchBranch,
    userCanAccessBranch,
    filterByBranch,
    filterForActiveView,
    filterByUserScope,
    listAuthorizedBranches,
    ensureRecordBranch,
    guardBranchAccess,
    assertWriteAllowed,
    TRUSTED_WRITE_SOURCES,
    initSessionBranch
  };

  global.activeBranchId = getActiveBranchId();
  global.filterByBranch = filterByBranch;
})(typeof window !== 'undefined' ? window : globalThis);
