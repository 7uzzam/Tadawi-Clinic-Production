/**
 * Renderer SQLite bridge — V2-5.9 authoritative SoT (no optimistic operational cache).
 *
 * Path:
 *   UI action → SQLite transaction (+ outbox) → success → mirror cache + memory
 * On failure:
 *   no success UI, no divergent cache, no outbox (tx rolled back), reload last commit
 */
(function (global) {
  'use strict';

  const CORE_TABLES = ['clientsRegistry', 'cases', 'bookings', 'doctors', 'attendance', 'expenses'];
  const KV_MIRROR = [
    'users', 'settings', 'packages', 'services', 'otRecords', 'budget', 'invoiceCounter',
    'clientFileCounter', 'nextSessions', 'employeeLeaveRequests', 'employeeLedgerAccruals',
    'employeeLedgerPayments', 'employeeLedgerEntries', 'importHistory',
    // V2-5.10 Category B: inventory synced tables → SQLite KV until dedicated tables land
    'inventoryItems', 'inventorySuppliers', 'inventoryMovements',
    // sync/attachment meta (not LS-only)
    '__tdw_conflict_queue__',
    '__tdw_conflict_archive__',
    '__tdw_attachment_manifest__',
  ];
  const OPERATIONAL_KEYS = new Set(CORE_TABLES.concat([
    'users', 'settings', 'packages', 'services',
    'inventoryItems', 'inventorySuppliers', 'inventoryMovements',
    '__tdw_conflict_queue__',
    '__tdw_attachment_manifest__',
  ]));
  const UI_ONLY_KEYS = new Set([
    '__tdw_ui_theme__', '__tdw_ui_lang__', '__tdw_last_tab__', '__tdw_wizard_ui__',
  ]);

  const state = {
    ready: false,
    sqlitePrimary: false,
    lastError: null,
    status: null,
    lastCommitted: {},
    pendingKeys: new Set(),
  };

  function api() {
    return global.cuppingElectron?.database || global.tadawi?.database || null;
  }

  function rawSet(k, v) {
    if (typeof DB !== 'undefined' && DB.__rawSet) return DB.__rawSet(k, v);
    if (typeof DB !== 'undefined' && DB.set && !DB.__sqliteWriteThrough) return DB.set(k, v);
    try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* empty */ }
  }

  function syncMemory(tableKey, value) {
    if (tableKey === 'clientsRegistry') global.clientsRegistry = value;
    else if (tableKey === 'cases') global.cases = value;
    else if (tableKey === 'bookings') global.bookings = value;
    else if (tableKey === 'doctors') global.doctors = value;
    else if (tableKey === 'attendance') global.attendance = value;
    else if (tableKey === 'expenses') global.expenses = value;
    else if (tableKey === 'users') global.users = value;
    else if (tableKey === 'services') global.services = value;
    else if (tableKey === 'packages') global.packages = value;
    else if (tableKey === 'settings' && value && !Array.isArray(value)) global.settings = value;
  }

  function rememberCommit(key, value) {
    try {
      state.lastCommitted[key] = typeof structuredClone === 'function'
        ? structuredClone(value)
        : JSON.parse(JSON.stringify(value));
    } catch {
      state.lastCommitted[key] = value;
    }
  }

  function restoreLastCommit(key) {
    if (!Object.prototype.hasOwnProperty.call(state.lastCommitted, key)) return false;
    const prev = state.lastCommitted[key];
    rawSet(key, prev);
    syncMemory(key, prev);
    return true;
  }

  function collectSnapshotFromLocal() {
    const snap = {};
    const read = (k, def) => {
      if (typeof DB !== 'undefined' && (DB.__rawSet || DB.get)) {
        try {
          if (DB.get) return DB.get(k, def);
        } catch { /* empty */ }
      }
      try {
        const raw = localStorage.getItem(k);
        return raw ? JSON.parse(raw) : def;
      } catch { return def; }
    };
    snap.clientsRegistry = read('clientsRegistry', []);
    snap.cases = read('cases', []);
    snap.bookings = read('bookings', []);
    snap.doctors = read('doctors', []);
    snap.attendance = read('attendance', []);
    snap.expenses = read('expenses', []);
    for (const k of KV_MIRROR) snap[k] = read(k, k.endsWith('Counter') ? 0 : (k === 'settings' ? {} : []));
    if (typeof buildFullBackupObject === 'function') {
      try {
        const full = buildFullBackupObject();
        return { ...snap, ...full };
      } catch { /* use snap */ }
    }
    return snap;
  }

  async function migrateAndEnable(options) {
    const db = api();
    if (!db) return { ok: false, error: 'database_api_unavailable' };
    const snapshot = options?.snapshot || collectSnapshotFromLocal();
    const report = await db.migrateFromBackup(snapshot, {
      sourceLabel: options?.sourceLabel || 'localStorage',
      dryRun: !!options?.dryRun,
    });
    if (!report?.ok) return report;
    if (options?.dryRun) return report;
    try { await db.enableSqlitePrimary?.(); } catch { /* empty */ }
    return hydrateIntoMemory();
  }

  async function ensureSqlitePrimaryEnabled() {
    const db = api();
    if (!db) return { ok: false, error: 'database_api_unavailable' };
    if (state.sqlitePrimary) return { ok: true, already: true };
    try {
      const st = await db.enableSqlitePrimary?.();
      state.status = st || (await db.status?.());
      state.sqlitePrimary = !!(state.status && state.status.sqlitePrimary);
      if (state.sqlitePrimary) installWriteThrough();
      return { ok: !!state.sqlitePrimary, status: state.status };
    } catch (e) {
      return { ok: false, error: String(e?.message || e) };
    }
  }

  async function hydrateIntoMemory() {
    const db = api();
    if (!db) return { ok: false, error: 'database_api_unavailable' };
    const res = await db.hydrate();
    if (!res?.ok) return res;
    const data = res.data || {};
    state.status = res.status;
    state.sqlitePrimary = !!(res.status && res.status.sqlitePrimary);
    if (!state.sqlitePrimary) {
      try {
        await db.enableSqlitePrimary?.();
        const st = await db.status?.();
        state.status = st;
        state.sqlitePrimary = !!(st && st.sqlitePrimary);
      } catch { /* empty */ }
    }

    const apply = (k, v) => {
      rememberCommit(k, v);
      rawSet(k, v);
      syncMemory(k, v);
    };
    apply('clientsRegistry', data.clientsRegistry || []);
    apply('cases', data.cases || []);
    apply('bookings', data.bookings || []);
    apply('doctors', data.doctors || []);
    apply('attendance', data.attendance || []);
    apply('expenses', data.expenses || []);
    for (const k of KV_MIRROR) {
      if (data[k] !== undefined) apply(k, data[k]);
    }

    state.ready = true;
    installWriteThrough();
    return { ok: true, status: state.status, report: res, sqlitePrimary: state.sqlitePrimary };
  }

  function buildOutboxEntry(tableKey, records) {
    const centerId =
      global.ConfigLayer?.getCenterId?.() ||
      global.CenterId?.getStoredCenterId?.() ||
      global.LicenseCloud?.loadLocal?.()?.centerId ||
      '';
    const branchId =
      global.BranchContexts?.getOperationalWriteBranch?.() ||
      global.BranchScope?.getActiveBranchId?.() ||
      'BR-MAIN';
    const deviceId =
      global.DeviceConfig?.getDeviceId?.() ||
      global.DeviceConfig?.load?.()?.deviceUuid ||
      'unknown-device';
    if (!centerId) return null;
    return {
      center_id: centerId,
      branch_id: branchId,
      table_name: tableKey,
      operation: 'TABLE_BUMP',
      base_revision: 0,
      new_revision: Date.now(),
      device_id: deviceId,
      payload_json: JSON.stringify(records ?? null),
    };
  }

  /**
   * Authoritative operational commit. Cache/memory updated ONLY after SQLite success.
   */
  async function commitOperational(tableKey, records, options) {
    options = options || {};
    const db = api();
    if (!db) return { ok: false, error: 'database_api_unavailable' };
    if (!state.sqlitePrimary) {
      const en = await ensureSqlitePrimaryEnabled();
      if (!en.ok) return { ok: false, error: en.error || 'sqlite_primary_required' };
    }
    if (global.LegacyBranchMigration?.isPushBlocked?.()) {
      return { ok: false, error: 'legacy_branch_migration_required' };
    }
    const list = Array.isArray(records) ? records : [];
    state.pendingKeys.add(tableKey);
    try {
      const entry = buildOutboxEntry(tableKey, list);
      let res;
      if (entry && db.syncOp) {
        res = await db.syncOp({
          op: 'enqueueAtomicPersistTable',
          tableKey,
          records: list,
          entry,
        });
      } else {
        res = await db.persistTable(tableKey, list);
      }
      if (res && res.ok === false) {
        state.lastError = res.error || 'commit_failed';
        restoreLastCommit(tableKey);
        return { ok: false, error: state.lastError, res };
      }
      rememberCommit(tableKey, list);
      rawSet(tableKey, list);
      syncMemory(tableKey, list);
      state.lastError = null;
      return { ok: true, tableKey, count: list.length, authoritative: true };
    } catch (e) {
      state.lastError = String(e?.message || e);
      restoreLastCommit(tableKey);
      return { ok: false, error: state.lastError };
    } finally {
      state.pendingKeys.delete(tableKey);
    }
  }

  async function commitKv(key, value) {
    const db = api();
    if (!db) return { ok: false, error: 'database_api_unavailable' };
    if (!state.sqlitePrimary) {
      const en = await ensureSqlitePrimaryEnabled();
      if (!en.ok) return { ok: false, error: en.error || 'sqlite_primary_required' };
    }
    state.pendingKeys.add(key);
    try {
      const res = await db.persistKv(key, value);
      if (res && res.ok === false) {
        state.lastError = res.error || 'kv_persist_failed';
        restoreLastCommit(key);
        return { ok: false, error: state.lastError };
      }
      rememberCommit(key, value);
      rawSet(key, value);
      syncMemory(key, value);
      state.lastError = null;
      return { ok: true, key, authoritative: true };
    } catch (e) {
      state.lastError = String(e?.message || e);
      restoreLastCommit(key);
      return { ok: false, error: state.lastError };
    } finally {
      state.pendingKeys.delete(key);
    }
  }

  /**
   * Async authoritative setter for UI call sites.
   */
  async function setAuthoritative(key, value) {
    if (UI_ONLY_KEYS.has(key)) {
      rawSet(key, value);
      return { ok: true, uiOnly: true };
    }
    if (CORE_TABLES.includes(key)) return commitOperational(key, Array.isArray(value) ? value : []);
    if (KV_MIRROR.includes(key) || OPERATIONAL_KEYS.has(key)) return commitKv(key, value);
    rawSet(key, value);
    return { ok: true, local: true };
  }

  function installWriteThrough() {
    if (typeof DB === 'undefined') return;
    if (!DB.__rawSet) {
      // Prefer unbridged raw if DbBridge wrapped DB.
      const candidate = DB.raw?.set ? DB.raw.set.bind(DB.raw) : DB.set.bind(DB);
      DB.__rawSet = candidate;
    }
    if (DB.__sqliteWriteThrough) {
      // Re-install to drop optimistic paths after upgrades.
      DB.__sqliteWriteThrough = false;
    }
    const baseRaw = DB.__rawSet;
    DB.set = function sqliteAuthoritativeSet(k, v) {
      if (UI_ONLY_KEYS.has(k)) {
        baseRaw(k, v);
        return true;
      }
      const db = api();
      // Browser/unit without Electron: local only, never invent outbox.
      if (!db || !state.sqlitePrimary) {
        baseRaw(k, v);
        rememberCommit(k, v);
        return true;
      }
      // Operational keys: NEVER optimistic cache. Fire authoritative commit; cache only on success.
      if (CORE_TABLES.includes(k) || OPERATIONAL_KEYS.has(k) || KV_MIRROR.includes(k)) {
        const run = CORE_TABLES.includes(k)
          ? commitOperational(k, Array.isArray(v) ? v : [])
          : commitKv(k, v);
        Promise.resolve(run).then((res) => {
          if (!res?.ok) {
            try {
              global.notify?.(
                '⚠️ فشل الحفظ في SQLite — أُعيدت آخر حالة معتمدة (' + (res?.error || 'commit_failed') + ')',
                'danger'
              );
            } catch { /* empty */ }
          }
        });
        // Return false-ish signal: sync callers must not assume success.
        // Value is NOT written to LS until commit resolves.
        return false;
      }
      baseRaw(k, v);
      return true;
    };
    DB.__sqliteWriteThrough = true;
    DB.__noOptimisticOperational = true;
    DB.commitOperational = commitOperational;
    DB.setAuthoritative = setAuthoritative;
    DB.restoreLastCommit = restoreLastCommit;
  }

  async function status() {
    const db = api();
    if (!db) return { ok: false, error: 'database_api_unavailable' };
    state.status = await db.status();
    state.sqlitePrimary = !!(state.status && state.status.sqlitePrimary);
    return state.status;
  }

  function isPrimary() {
    return !!state.sqlitePrimary;
  }

  global.SqliteBridge = {
    migrateAndEnable,
    hydrateIntoMemory,
    ensureSqlitePrimaryEnabled,
    commitOperational,
    commitKv,
    setAuthoritative,
    restoreLastCommit,
    status,
    isPrimary,
    collectSnapshotFromLocal,
    CORE_TABLES,
    KV_MIRROR,
    OPERATIONAL_KEYS,
    getState: () => ({
      ready: state.ready,
      sqlitePrimary: state.sqlitePrimary,
      lastError: state.lastError,
      pending: Array.from(state.pendingKeys),
      hasLastCommitted: Object.keys(state.lastCommitted),
    }),
    getLastError: () => state.lastError,
  };
})(typeof window !== 'undefined' ? window : global);
