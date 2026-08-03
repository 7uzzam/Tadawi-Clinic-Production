/**
 * Synced Write — single gateway for synced table writes and backup restore.
 */
(function (global) {
  'use strict';

  const LOCAL_ONLY_KEYS = new Set([
    'otRecords', 'clientFileCounter', 'hardwareLog', 'messageLog', 'nextSessions',
    'employeeLeaveRequests', 'employeeLedgerAccruals', 'employeeLedgerPayments',
    'employeeLedgerEntries', 'importHistory', 'communicationWebhookLog',
    'invoiceCounter', 'backupLog', 'backupRegistry', 'budget', 'systemLogs',
    'logCounter', 'logsPageSize', 'cashDrawerSession', 'preImportBackup',
    'importStudioLog', 'activityLog'
  ]);

  function ensureBridge() {
    global.DbBridge?.install?.();
    return global.Repository;
  }

  function syncedTables() {
    return new Set(global.DbBridge?.syncedTables?.() || global.Repository?.SYNCED_TABLES || []);
  }

  function isSyncedTable(table) {
    return syncedTables().has(table);
  }

  function syncGlobalVar(table, value) {
    if (table === 'cases') global.cases = value;
    else if (table === 'clientsRegistry') global.clientsRegistry = value;
    else if (table === 'bookings') global.bookings = value;
    else if (table === 'users') global.users = value;
    else if (table === 'doctors') global.doctors = value;
    else if (table === 'services') global.services = value;
    else if (table === 'packages') global.packages = value;
    else if (table === 'settings' && value && !Array.isArray(value)) global.settings = value;
    else if (table === 'expenses') global.expenses = value;
    else if (table === 'attendance') global.attendance = value;
    else if (table === 'inventoryItems') global.inventoryItems = value;
    else if (table === 'inventorySuppliers') global.inventorySuppliers = value;
    else if (table === 'inventoryMovements') global.inventoryMovements = value;
  }

  async function setTable(table, value, options) {
    options = options || {};
    ensureBridge();
    if (global.LegacyBranchMigration?.isPushBlocked?.() && isSyncedTable(table)) {
      return { ok: false, error: 'legacy_branch_migration_required' };
    }
    // Authoritative SQLite first when available — no optimistic cache.
    if (global.SqliteBridge?.setAuthoritative && (
      global.SqliteBridge.CORE_TABLES?.includes?.(table)
      || global.SqliteBridge.OPERATIONAL_KEYS?.has?.(table)
      || ['users', 'settings', 'packages', 'services'].includes(table)
    )) {
      const res = await global.SqliteBridge.setAuthoritative(table, value);
      if (!res?.ok) return { ok: false, error: res?.error || 'sqlite_commit_failed', via: 'sqlite' };
      syncGlobalVar(table, value);
      if (isSyncedTable(table) && global.Repository?.setAll && options.skipRepo !== true) {
        try { global.Repository.setAll(table, value, { ...options, skipOutbox: true }); } catch { /* empty */ }
      }
      return { ok: true, via: 'sqlite_authoritative', table };
    }
    if (isSyncedTable(table)) {
      if (!global.Repository?.setAll) return { ok: false, error: 'no_repository' };
      global.Repository.setAll(table, value, options);
      syncGlobalVar(table, value);
      return { ok: true, via: 'repository', table };
    }
    global.DbBridge?.rawDb?.()?.set?.(table, value) || global.DB?.set?.(table, value);
    return { ok: true, via: 'local', table };
  }

  async function upsertRecord(table, record, options) {
    options = options || {};
    ensureBridge();
    if (!isSyncedTable(table)) {
      return { ok: false, error: 'not_synced_table' };
    }
    if (global.LegacyBranchMigration?.isPushBlocked?.()) {
      return { ok: false, error: 'legacy_branch_migration_required' };
    }
    if (!global.Repository?.upsert) return { ok: false, error: 'no_repository' };
    const r = global.Repository.upsert(table, record, options);
    const all = global.Repository.get(table);
    if (global.SqliteBridge?.setAuthoritative && global.SqliteBridge.CORE_TABLES?.includes?.(table)) {
      const commit = await global.SqliteBridge.setAuthoritative(table, all);
      if (!commit?.ok) {
        try { global.SqliteBridge.restoreLastCommit?.(table); } catch { /* empty */ }
        return { ok: false, error: commit?.error || 'sqlite_commit_failed', via: 'sqlite' };
      }
    }
    syncGlobalVar(table, all);
    return r;
  }

  function applyLocalOnlyPayload(data) {
    if (!data || typeof data !== 'object') return [];
    const applied = [];
    Object.keys(data).forEach(key => {
      if (LOCAL_ONLY_KEYS.has(key) && data[key] != null) {
        global.DB?.set?.(key, data[key]);
        if (key === 'invoiceCounter') global.invoiceCounter = data[key];
        if (key === 'clientFileCounter') global.clientFileCounter = data[key];
        applied.push(key);
      }
    });
    if (data.license?.meta) {
      try { localStorage.setItem('__tdw_lic_meta__', data.license.meta); } catch { /* empty */ }
      applied.push('license.meta');
    }
    if (data.license?.data) {
      try { localStorage.setItem('__tdw_lic__', data.license.data); } catch { /* empty */ }
      applied.push('license.data');
    }
    return applied;
  }

  function wipeTable(table, emptyValue) {
    ensureBridge();
    const val = emptyValue != null ? emptyValue : (table.includes('Counter') ? 1 : []);
    if (isSyncedTable(table)) {
      global.SyncGuard?.pause?.('admin_wipe', { table });
      const r = setTable(table, val, { source: 'wipe' });
      global.SyncGuard?.resume?.({ state: 'local_only' });
      return r;
    }
    global.DbBridge?.rawDb?.()?.set?.(table, val);
    return { ok: true, via: 'local', table };
  }

  function restoreLocalExtensions(data) {
    if (!data || typeof data !== 'object') return;
    if (typeof global.extRestoreData === 'function') global.extRestoreData(data);
    if (typeof global.extRestoreLedgerData === 'function') global.extRestoreLedgerData(data);
    if (typeof global.extRestoreLeaveData === 'function') global.extRestoreLeaveData(data);
  }

  async function restoreFromBackup(data, meta) {
    meta = meta || {};
    ensureBridge();
    if (!global.RestoreStaging?.stageBackup) {
      return { ok: false, error: 'no_restore_staging' };
    }

    const staged = global.RestoreStaging.stageBackup(data, meta);
    const comparison = global.RestoreStaging.compareWithLocal(staged);

    global.AuditLogger?.logSyncEvent?.('MANUAL_RESTORE', {
      summary: 'بدء استعادة نسخة احتياطية عبر محرك الدمج',
      source: meta.source || 'backup'
    });

    if (comparison.hasConflict) {
      if (!global.RolePolicy?.isManager?.(global.currentUser)) {
        global.notify?.('⛔ لا يمكن الاستعادة — تواصل مع المدير', 'danger');
        return { ok: false, error: 'manager_required', comparison };
      }
      global.SyncGuard?.pause?.('restore_conflict', comparison);
      return { ok: false, error: 'conflict', needsReview: true, comparison };
    }

    const merged = global.RestoreStaging.applyStagedMerge({
      manual: true,
      branchId: meta.branchId,
      keepStaging: false
    });

    if (!merged.ok) return merged;

    Object.keys(global.RestoreStaging.SYNCED_MAP || {}).forEach(table => {
      if (global.Repository?.get) syncGlobalVar(table, global.Repository.get(table));
    });

    const localOnly = applyLocalOnlyPayload(data);
    restoreLocalExtensions(data);

    return { ok: true, merged, localOnly, comparison };
  }

  global.SyncedWrite = {
    LOCAL_ONLY_KEYS,
    ensureBridge,
    isSyncedTable,
    setTable,
    upsertRecord,
    wipeTable,
    restoreFromBackup,
    restoreLocalExtensions,
    applyLocalOnlyPayload,
    syncGlobalVar
  };
})(typeof window !== 'undefined' ? window : globalThis);
