/**
 * Sync Engine — Push on write + Poll every 60s (Cloud V2 Sprint 4).
 */
(function (global) {
  'use strict';

  const PUSH_DEBOUNCE_MS = 2000;
  const DEFAULT_POLL_MS = 15000;

  const CONFIG_FIELD_FILES = {
    settingsVersion: 'settings.json',
    pricesVersion: 'prices.json',
    servicesVersion: 'services.json',
    packagesVersion: 'packages.json',
    usersVersion: 'users.json'
  };

  const TABLE_LAYER = {
    settings: { layer: 'config', file: 'settings.json', table: 'settings' },
    services: { layer: 'config', file: 'services.json', table: 'services' },
    packages: { layer: 'config', file: 'packages.json', table: 'packages' },
    users: { layer: 'config', file: 'users.json', table: 'users' },
    cases: { layer: 'operational', file: 'cases.json', table: 'cases' },
    clientsRegistry: { layer: 'operational', file: 'clients.json', table: 'clientsRegistry' },
    bookings: { layer: 'operational', file: 'bookings.json', table: 'bookings' },
    expenses: { layer: 'operational', file: 'expenses.json', table: 'expenses' },
    attendance: { layer: 'operational', file: 'attendance.json', table: 'attendance' },
    doctors: { layer: 'operational', file: 'doctors.json', table: 'doctors' },
    inventoryItems: { layer: 'operational', file: 'inventory-items.json', table: 'inventoryItems' },
    inventorySuppliers: { layer: 'operational', file: 'inventory-suppliers.json', table: 'inventorySuppliers' },
    inventoryMovements: { layer: 'operational', file: 'inventory-movements.json', table: 'inventoryMovements' }
  };

  let _pollTimer = null;
  let _pushTimers = new Map();
  let _running = false;
  let _handlers = { online: null, offline: null };

  const BENIGN_SYNC_ERRORS = new Set([
    'no_center_id', 'no_remote_versions', 'no_versions_path', 'not_found',
    'offline', 'drive_not_connected', 'no_backup_bridge'
  ]);

  function isBenignSyncError(msg) {
    if (!msg) return true;
    const m = String(msg).toLowerCase();
    if (BENIGN_SYNC_ERRORS.has(m)) return true;
    return /^(no_remote_versions|no_versions_path|not_found|offline|no_center_id)$/i.test(m);
  }

  function isEnabled() {
    if (!global.CloudMeta?.isCloudV2Enabled?.()) return false;
    return global.DriveAdapter?.isConnected?.() !== false && global.DriveAdapter?.isConnected?.();
  }

  function getCenterId() {
    return global.ConfigLayer?.getCenterId?.() || global.CenterId?.getStoredCenterId?.() || '';
  }

  function getBranchId(branchId) {
    return branchId || global.BranchScope?.getActiveBranchId?.() || 'BR-MAIN';
  }

  /** Device-locked branch only — prevents cross-branch pull on poll */
  function getSyncBranchScope() {
    if (global.DeviceConfig?.isBranchLocked?.()) {
      return global.DeviceConfig.getLockedBranchId() || null;
    }
    return null;
  }

  function shouldSyncBranch(branchId) {
    if (!branchId) return true;
    const scope = getSyncBranchScope();
    if (!scope) return true;
    return branchId === scope;
  }

  function checkSyncGuard(options) {
    options = options || {};
    if (!global.CloudMeta?.isCloudV2Enabled?.()) return { ok: true, skipped: true };
    if (options.force) return { ok: true, forced: true };
    // V2-4: revoked/pending devices must not push/pull
    try {
      const deviceId =
        global.DeviceConfig?.getDeviceId?.() ||
        global.DeviceConfig?.load?.()?.deviceUuid ||
        global.LicenseIdentity?.getDeviceId?.();
      if (deviceId && global.DeviceRegistry?.canSync) {
        const cs = global.DeviceRegistry.canSync(null, deviceId);
        if (cs && cs.ok === false) {
          return { ok: false, blocked: true, reason: cs.error || 'device_sync_blocked', ...cs };
        }
      }
    } catch { /* empty */ }
    return global.SyncGuard?.canSync?.(options) || { ok: true };
  }

  function blockIfUnsafePull(result, table) {
    if (result?.blocked || result?.hasConflict) {
      global.SyncGuard?.pause?.('conflict', { table, result });
      global.SyncState?.setError?.('sync_blocked_conflict');
      return { ok: false, blocked: true, table, ...result };
    }
    return result;
  }

  function schedulePush(table, branchId) {
    if (!global.CloudMeta?.isCloudV2Enabled?.()) return;
    branchId = getBranchId(branchId);
    const key = `${table}:${branchId}`;
    if (_pushTimers.has(key)) clearTimeout(_pushTimers.get(key));

    // V2-4/V2-5.2: durable SQLite outbox enqueue with full table payload (never null-only)
    try {
      const centerId = getCenterId();
      const deviceId =
        global.DeviceConfig?.getDeviceId?.() ||
        global.LicenseIdentity?.getDeviceId?.() ||
        'unknown-device';
      const rev =
        Number(global.VersionsIndex?.getTableRevision?.(table, branchId) ||
          global.Repository?._revisions?.[table] ||
          0);
      if (centerId && global.SqliteOutboxBridge?.enqueue) {
        let payload = null;
        try {
          payload = global.Repository?.get?.(table);
        } catch { /* empty */ }
        Promise.resolve(
          global.SqliteOutboxBridge.enqueue({
            center_id: centerId,
            branch_id: branchId,
            table_name: table,
            operation: 'TABLE_BUMP',
            base_revision: Math.max(0, rev - 1),
            new_revision: rev,
            device_id: deviceId,
            payload_json: payload == null ? JSON.stringify([]) : JSON.stringify(payload),
          })
        ).catch(() => { /* never throw into UI */ });
      }
    } catch { /* empty */ }

    _pushTimers.set(key, setTimeout(() => {
      _pushTimers.delete(key);
      pushTable(table, branchId).catch(err => queueFailedPush(table, branchId, err));
    }, PUSH_DEBOUNCE_MS));
  }

  function queueFailedPush(table, branchId, err) {
    const meta = TABLE_LAYER[table] || { layer: 'operational', table };
    global.SyncState?.queuePush?.({
      layer: meta.layer,
      table: meta.table || table,
      branchId,
      revision: global.Repository?.getRevision?.(table) || 0
    });
    const msg = err?.message || String(err || 'push_failed');
        if (!isBenignSyncError(msg)) {
          const handled = global.DriveErrors?.handleFailure?.({ message: msg }) || {};
          if (!handled.classified?.pauseSync) global.SyncState?.setError?.(msg);
        }
  }

  async function pushTable(table, branchId) {
    if (global.LegacyBranchMigration?.isPushBlocked?.()) {
      return { ok: false, blocked: true, reason: 'legacy_branch_migration_required' };
    }
    const guard = checkSyncGuard();
    if (!guard.ok && !guard.skipped) return { ok: false, blocked: true, reason: guard.reason };
    if (!isEnabled()) return { ok: false, skipped: true };
    if (global.LicenseIdentity?.verifyGoogleBinding) {
      const idCheck = await global.LicenseIdentity.verifyGoogleBinding();
    if (!idCheck.ok) {
      const handled = global.DriveErrors?.handleFailure?.(idCheck) || {};
      global.SyncState?.setError?.(idCheck.error || 'google_identity_transfer');
      return { ok: false, error: idCheck.error, identity: idCheck, ...handled };
    }
      if (idCheck.needsBind && global.LicenseIdentity.getConnectedGoogleEmail?.()) {
        await global.LicenseIdentity.bindGoogleAccount(global.LicenseIdentity.getConnectedGoogleEmail());
      }
    }
    branchId = getBranchId(branchId);
    const centerId = getCenterId();
    if (!centerId) return { ok: false, error: 'no_center_id' };

    const meta = TABLE_LAYER[table];
    if (!meta) return { ok: false, error: 'unknown_table' };

    let remotePath;
    let payload;

    if (meta.layer === 'config' || (meta.file === 'settings.json' && table === 'settings')) {
      const pack = global.ConfigLayer?.exportBranchPack?.(branchId);
      if (!pack) return { ok: false, error: 'no_config_pack' };
      if (table === 'settings') {
        const paths = [
          { path: global.ConfigLayer.drivePathForFile(centerId, branchId, 'settings.json'), data: pack.settings },
          { path: global.ConfigLayer.drivePathForFile(centerId, branchId, 'prices.json'), data: pack.prices }
        ];
        for (const item of paths) {
          const r = await global.DriveAdapter.uploadJson(item.path, item.data, { overwrite: true });
          if (!r?.ok) {
            queueFailedPush(table, branchId, new Error(r?.message || r?.error || 'upload_failed'));
            return r;
          }
        }
      } else {
        if (meta.file === 'settings.json') payload = pack.settings;
        else if (meta.file === 'prices.json') payload = pack.prices;
        else if (meta.file === 'services.json') payload = pack.services;
        else if (meta.file === 'packages.json') payload = pack.packages;
        else if (meta.file === 'users.json') payload = pack.users;
        remotePath = global.ConfigLayer?.drivePathForFile?.(centerId, branchId, meta.file);
        const up = await global.DriveAdapter.uploadJson(remotePath, payload, { overwrite: true });
        if (!up?.ok) {
          queueFailedPush(table, branchId, new Error(up?.message || up?.error || 'upload_failed'));
          return up;
        }
      }
    } else {
      payload = global.OperationalLayer?.exportTable?.(table, branchId);
      remotePath = global.OperationalLayer?.drivePathForTable?.(centerId, branchId, table);
      const upOp = await global.DriveAdapter.uploadJson(remotePath, payload, { overwrite: true });
      if (!upOp?.ok) {
        queueFailedPush(table, branchId, new Error(upOp?.message || upOp?.error || 'upload_failed'));
        return upOp;
      }
    }

    global.SyncState?.dequeuePush?.(meta.layer, meta.table || table, branchId);
    global.SyncState?.touchPush?.();
    global.AuditLogger?.logSyncEvent?.('LOCAL_PUSH', {
      entity: table,
      entityId: branchId,
      summary: `رفع ${table} إلى Google Drive`
    });

    const versions = global.VersionsIndex?.toDriveJson?.(
      global.VersionsIndex?.syncFromRepository?.(global.Repository, centerId, branchId)
    );
    await global.DriveAdapter.uploadVersions(centerId, versions, branchId);
    global.DeviceCache?.snapshotFromLocal?.(branchId).catch(() => {});

    emit('synced', { direction: 'push', table, branchId });
    return { ok: true, table, branchId, remotePath };
  }

  async function pushConfigField(field, branchId) {
    branchId = getBranchId(branchId);
    const file = CONFIG_FIELD_FILES[field];
    if (!file) return { ok: false, error: 'unknown_field' };
    const tableMap = {
      settingsVersion: 'settings',
      pricesVersion: 'settings',
      servicesVersion: 'services',
      packagesVersion: 'packages',
      usersVersion: 'users'
    };
    return pushTable(tableMap[field] || 'settings', branchId);
  }

  async function pullConfigFile(branchId, fileName) {
    const guard = checkSyncGuard();
    if (!guard.ok && !guard.skipped) return { ok: false, blocked: true, reason: guard.reason };
    branchId = getBranchId(branchId);
    const centerId = getCenterId();
    const paths = global.DriveLayout?.configBranchFileCandidates?.(centerId, branchId, fileName)
      || [global.ConfigLayer?.drivePathForFile?.(centerId, branchId, fileName)];
    const dl = global.DriveAdapter?.downloadJsonFirst
      ? await global.DriveAdapter.downloadJsonFirst(paths)
      : await global.DriveAdapter.downloadJson(paths[0]);
    if (!dl?.ok) return dl;

    const pack = { branchId };
    if (fileName === 'settings.json') pack.settings = dl.data;
    else if (fileName === 'prices.json') pack.prices = dl.data;
    else if (fileName === 'services.json') pack.services = dl.data;
    else if (fileName === 'packages.json') pack.packages = dl.data;
    else if (fileName === 'users.json') pack.users = dl.data;
    else return { ok: false, error: 'unknown_config_file' };

    return blockIfUnsafePull(global.ConfigLayer?.importBranchPack?.(pack, { branchId, mergeUsers: true }), fileName);
  }

  async function pullOperationalTable(branchId, table) {
    const guard = checkSyncGuard();
    if (!guard.ok && !guard.skipped) return { ok: false, blocked: true, reason: guard.reason };
    branchId = getBranchId(branchId);
    const centerId = getCenterId();
    const paths = global.DriveLayout?.operationalBranchFileCandidates?.(centerId, branchId, table)
      || [global.OperationalLayer?.drivePathForTable?.(centerId, branchId, table)];
    const dl = global.DriveAdapter?.downloadJsonFirst
      ? await global.DriveAdapter.downloadJsonFirst(paths)
      : await global.DriveAdapter.downloadJson(paths[0]);
    if (!dl?.ok) return dl;
    return blockIfUnsafePull(global.OperationalLayer?.importTable?.(table, dl.data, branchId), table);
  }

  async function pullBranchDatabase(branchId) {
    const guard = checkSyncGuard();
    if (!guard.ok && !guard.skipped) return { ok: false, blocked: true, reason: guard.reason };
    branchId = getBranchId(branchId);
    const tables = global.OperationalLayer?.OPERATIONAL_TABLES || [];
    const results = [];
    for (const table of tables) {
      try {
        const r = await pullOperationalTable(branchId, table);
        results.push({ table, ok: !!r?.ok });
      } catch (e) {
        results.push({ table, ok: false, error: e.message });
      }
    }
    return { ok: true, branchId, results };
  }

  async function applyRemoteVersions(remote, options) {
    options = options || {};
    const centerId = getCenterId();
    const local = global.VersionsIndex?.loadLocal?.(centerId);
    const changes = global.VersionsIndex?.diff?.(remote, local) || [];
    const pulled = [];
    const scopeBranch = options.branchId || getSyncBranchScope();

    for (const ch of changes) {
      if (ch.branchId && scopeBranch && ch.branchId !== scopeBranch) continue;
      if (ch.layer === 'branch') {
        const file = CONFIG_FIELD_FILES[ch.field];
        if (file && ch.branchId) {
          await pullConfigFile(ch.branchId, file);
          pulled.push({ type: 'config', file, branchId: ch.branchId });
        } else if (ch.field === 'databaseVersion' && ch.branchId) {
          await pullBranchDatabase(ch.branchId);
          pulled.push({ type: 'operational', branchId: ch.branchId });
        }
      } else if (ch.layer === 'config') {
        const file = CONFIG_FIELD_FILES[ch.field];
        if (file) {
          const bid = scopeBranch || getBranchId();
          await pullConfigFile(bid, file);
          pulled.push({ type: 'config', file, branchId: bid });
        }
      }
    }

    if (remote && typeof remote === 'object') {
      global.VersionsIndex?.saveLocal?.({ ...local, ...remote, centerId: centerId || local?.centerId });
    }

    return { ok: true, changes: changes.length, pulled };
  }

  async function poll() {
    if (!global.CloudMeta?.isCloudV2Enabled?.()) return { ok: false, skipped: true };
    const guard = checkSyncGuard();
    if (!guard.ok && !guard.skipped) return { ok: false, blocked: true, reason: guard.reason };
    if (_running) return { ok: false, busy: true };
    _running = true;
    try {
      const centerId = getCenterId();
      if (!centerId) return { ok: false, error: 'no_center_id' };

      if (!global.DriveAdapter?.isConnected?.()) {
        global.SyncState?.setOnline?.(false);
        global.SyncState?.clearError?.();
        return { ok: false, offline: true };
      }

      if (global.LicenseIdentity?.verifyGoogleBinding) {
        const idCheck = await global.LicenseIdentity.verifyGoogleBinding();
    if (!idCheck.ok) {
      const handled = global.DriveErrors?.handleFailure?.(idCheck) || {};
      global.SyncState?.setError?.(idCheck.error || 'google_identity_transfer');
      return { ok: false, error: idCheck.error, identity: idCheck, ...handled };
    }
      }

      global.SyncState?.setOnline?.(true);
      const branchId = getBranchId();
      const remoteRes = await global.DriveAdapter.downloadVersions(centerId, branchId);
      if (!remoteRes?.ok || !remoteRes.data) {
        global.SyncState?.touchPoll?.();
        const err = remoteRes?.error || 'no_remote_versions';
        if (isBenignSyncError(err)) global.SyncState?.clearError?.();
        else global.SyncState?.setError?.(err);
        return remoteRes || { ok: false, error: 'no_remote_versions' };
      }

      const result = await applyRemoteVersions(remoteRes.data);
      global.SyncState?.touchPoll?.();
      emit('synced', { direction: 'poll', ...result });
      return { ok: true, ...result };
    } catch (e) {
      const msg = e.message || String(e);
        if (!isBenignSyncError(msg)) {
          const handled = global.DriveErrors?.handleFailure?.({ message: msg }) || {};
          if (!handled.classified?.pauseSync) global.SyncState?.setError?.(msg);
        }
      return { ok: false, error: msg };
    } finally {
      _running = false;
    }
  }

  async function flushPending() {
    if (!isEnabled()) return { ok: false, skipped: true };
    const guard = checkSyncGuard();
    const blocked = !!(guard && guard.ok === false && !guard.skipped);
    const state = global.SyncState?.load?.() || {};
    const pending = (state.pendingPushes || []).filter(item =>
      !item.branchId || shouldSyncBranch(item.branchId)
    );
    const results = [];
    if (blocked) {
      // Do not push while revoked/pending, but keep API ok for callers that only need a drain attempt.
      return {
        ok: true,
        blocked: true,
        reason: guard.reason || 'device_sync_blocked',
        flushed: 0,
        results,
      };
    }
    for (const item of pending) {
      const table = item.table;
      if (table) {
        const r = await pushTable(table, item.branchId);
        results.push({ table, ok: !!r?.ok, source: 'memory_queue' });
      }
    }

    // V2-4: also drain durable SQLite outbox via Electron bridge when available
    if (global.SqliteOutboxBridge?.claimPending) {
      try {
        const branchId = getBranchId();
        const claimed = await global.SqliteOutboxBridge.claimPending({
          branch_id: branchId,
          limit: 50,
        });
        const rows = Array.isArray(claimed) ? claimed : claimed?.rows || claimed?.events || [];
        for (const row of rows) {
          try {
            const table = row.table_name || row.table;
            const r = await pushTable(table, row.branch_id || branchId);
            if (r?.ok) {
              if (global.SqliteOutboxBridge.ack) {
                await global.SqliteOutboxBridge.ack(row.event_id, r.fileId || r.remoteFileId || null);
              }
              results.push({ table, ok: true, source: 'sqlite_outbox', eventId: row.event_id });
            } else {
              if (global.SqliteOutboxBridge.fail) {
                await global.SqliteOutboxBridge.fail(row.event_id, r?.error || r?.reason || 'push_failed');
              }
              results.push({ table, ok: false, source: 'sqlite_outbox', eventId: row.event_id });
            }
          } catch (err) {
            if (global.SqliteOutboxBridge.fail) {
              await global.SqliteOutboxBridge.fail(row.event_id, err.message || String(err));
            }
            results.push({
              table: row.table_name || row.table,
              ok: false,
              source: 'sqlite_outbox',
              error: String(err.message || err).slice(0, 200),
            });
          }
        }
      } catch (err) {
        results.push({ ok: false, source: 'sqlite_outbox', error: String(err.message || err).slice(0, 200) });
      }
    }

    return { ok: true, flushed: results.length, results };
  }

  function setPollIntervalMs(ms) {
    const interval = Math.max(5000, Math.min(300000, Number(ms) || DEFAULT_POLL_MS));
    const s = global.SyncState?.load?.() || global.SyncState?.defaultState?.() || {};
    s.pollIntervalMs = interval;
    global.SyncState?.save?.(s);
    if (global.CloudMeta?.isCloudV2Enabled?.()) {
      start({ pollIntervalMs: interval });
    }
    return interval;
  }

  function start(options) {
    options = options || {};
    stop();
    if (!global.CloudMeta?.isCloudV2Enabled?.()) return { ok: false, skipped: true };

    const interval = Number(options.pollIntervalMs)
      || global.SyncState?.load?.()?.pollIntervalMs
      || DEFAULT_POLL_MS;

    _pollTimer = setInterval(() => { poll().catch(() => {}); }, interval);

    if (typeof window !== 'undefined') {
      _handlers.online = () => {
        global.SyncState?.setOnline?.(true);
        flushPending().catch(() => {});
        poll().catch(() => {});
      };
      _handlers.offline = () => global.SyncState?.setOnline?.(false);
      window.addEventListener('online', _handlers.online);
      window.addEventListener('offline', _handlers.offline);
    }

    setTimeout(() => {
      flushPending().catch(() => {});
      poll().catch(() => {});
    }, 3000);

    return { ok: true, pollIntervalMs: interval };
  }

  function stop() {
    if (_pollTimer) {
      clearInterval(_pollTimer);
      _pollTimer = null;
    }
    _pushTimers.forEach(t => clearTimeout(t));
    _pushTimers.clear();
    if (typeof window !== 'undefined' && _handlers.online) {
      window.removeEventListener('online', _handlers.online);
      window.removeEventListener('offline', _handlers.offline);
      _handlers.online = null;
      _handlers.offline = null;
    }
  }

  function getStatus() {
    return {
      enabled: isEnabled(),
      running: !!_pollTimer,
      ...global.SyncState?.getStatus?.()
    };
  }

  const _events = {};

  function on(event, handler) {
    if (!_events[event]) _events[event] = [];
    _events[event].push(handler);
  }

  function emit(event, data) {
    (_events[event] || []).forEach(fn => { try { fn(data); } catch { /* empty */ } });
  }

  global.SyncEngine = {
    PUSH_DEBOUNCE_MS,
    DEFAULT_POLL_MS,
    schedulePush,
    push: pushTable,
    pushTable,
    poll,
    flushPending,
    start,
    stop,
    setPollIntervalMs,
    getSyncBranchScope,
    shouldSyncBranch,
    checkSyncGuard,
    getStatus,
    on,
    pullConfigFile,
    pullOperationalTable,
    pullBranchDatabase,
    applyRemoteVersions
  };
})(typeof window !== 'undefined' ? window : globalThis);
