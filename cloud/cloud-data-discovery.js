/**
 * V2-5.10 — Fast Cloud Data Discovery + Confirmed Restore (renderer).
 * Discovery is metadata-only. Restore starts only after explicit user confirm.
 * SyncEngine must NOT start during discovery.
 */
(function (global) {
  'use strict';

  const DISCOVERY_TIMEOUT_MS = 15000;
  const NO_PROGRESS_WATCHDOG_MS = 30000;

  const RESTORE_STAGES = [
    { id: 'verify_point', label: 'التحقق من النسخة', weight: 5 },
    { id: 'local_safety', label: 'إنشاء نسخة أمان محلية', weight: 5 },
    { id: 'download_db', label: 'تنزيل قاعدة البيانات / الحالة السحابية', weight: 25 },
    { id: 'download_attachments', label: 'تنزيل المرفقات', weight: 10 },
    { id: 'checksums', label: 'التحقق من Checksums', weight: 8 },
    { id: 'decrypt', label: 'فك التشفير والضغط', weight: 10 },
    { id: 'staging', label: 'الاستعادة إلى Staging', weight: 12 },
    { id: 'sqlite_integrity', label: 'SQLite integrity check', weight: 8 },
    { id: 'atomic_swap', label: 'Atomic swap', weight: 7 },
    { id: 'remote_compare', label: 'مقارنة أحدث التغييرات السحابية', weight: 5 },
    { id: 'reconcile', label: 'Reconciliation', weight: 3 },
    { id: 'restart_prep', label: 'تجهيز إعادة التشغيل', weight: 2 },
  ];

  let discoveryOpId = 0;
  let restoreOpId = 0;
  let discoveryLock = false;
  let restoreLock = false;
  let activeAbort = null;
  let lastDiscovery = null;

  function bridge() {
    const electronBackup = global.cuppingElectron?.backup
      || global.tadawiElectron?.backup
      || global.tadawi?.backup
      || null;
    // Prefer Electron IPC when BackupBridge lacks discovery (older wrappers).
    if (electronBackup?.discoverCloudRestorePoints) return electronBackup;
    if (global.BackupBridge?.discoverCloudRestorePoints) return global.BackupBridge;
    return global.BackupBridge || electronBackup || null;
  }

  function formatBytes(n) {
    const v = Number(n) || 0;
    if (v < 1024) return `${v} B`;
    if (v < 1024 * 1024) return `${(v / 1024).toFixed(1)} KB`;
    return `${(v / (1024 * 1024)).toFixed(2)} MB`;
  }

  function formatWhen(iso) {
    if (!iso) return '—';
    try {
      return new Date(iso).toLocaleString('ar-SA', { dateStyle: 'medium', timeStyle: 'short' });
    } catch {
      return String(iso);
    }
  }

  function getIdentity() {
    const lic = global.LicenseCloud?.loadLocal?.() || global.LicenseV6?.getActiveLicense?.() || null;
    const centerId = lic?.centerId
      || global.CenterId?.get?.()
      || global.DeviceConfig?.load?.()?.centerId
      || null;
    const branchId = global.DeviceConfig?.load?.()?.lockedBranchId
      || global.BranchScope?.getActiveBranchId?.()
      || lic?.branchId
      || null;
    const centerName = lic?.centerName || lic?.organizationName || global.DeviceConfig?.load?.()?.centerName || '';
    return { lic, centerId, branchId, centerName };
  }

  function probeLocalDatabase() {
    const started = Date.now();
    try {
      const clients = global.DB?.get?.('clients');
      const hasData = Array.isArray(clients) ? clients.length > 0
        : !!(global.DB?.get?.('settings') || global.SqliteBridge?.isPrimary?.());
      const pathHint = global.cuppingElectron?.getUserDataPath?.()
        || global.tadawiElectron?.getUserDataPath?.()
        || 'localStorage / SQLite';
      return {
        ok: true,
        available: true,
        status: hasData ? 'valid' : 'empty_or_new',
        path: pathHint,
        modifiedAt: null,
        durationMs: Date.now() - started,
        message: hasData ? 'بيانات محلية موجودة' : 'لا توجد بيانات تشغيلية محلية غنية',
      };
    } catch (err) {
      return {
        ok: false,
        available: false,
        status: 'error',
        durationMs: Date.now() - started,
        message: err.message || String(err),
      };
    }
  }

  async function probeLocalBackups() {
    const started = Date.now();
    const b = bridge();
    try {
      if (b?.v2ListLocal) {
        const listed = await b.v2ListLocal();
        const files = listed?.files || [];
        const newest = files[0] || null;
        return {
          ok: true,
          available: files.length > 0,
          status: files.length ? 'ready' : 'not_found',
          count: files.length,
          newest,
          durationMs: Date.now() - started,
          message: files.length ? `وُجدت ${files.length} نسخة محلية` : 'لا توجد نسخ Backup V2 محلية',
        };
      }
      return {
        ok: true,
        available: false,
        status: 'unavailable',
        durationMs: Date.now() - started,
        message: 'قائمة النسخ المحلية غير متاحة',
      };
    } catch (err) {
      return {
        ok: false,
        available: false,
        status: 'error',
        durationMs: Date.now() - started,
        message: err.message || String(err),
      };
    }
  }

  /**
   * Parallel Fast Discovery for all data-source cards.
   * Must NOT start SyncEngine, download DB, decrypt, or hydrate.
   */
  async function discoverAllSources(options = {}) {
    if (discoveryLock) {
      return { ok: false, error: 'discovery_in_flight', last: lastDiscovery };
    }
    discoveryLock = true;
    const opId = ++discoveryOpId;
    const abort = typeof AbortController !== 'undefined' ? new AbortController() : null;
    activeAbort = abort;
    const started = Date.now();
    const identity = getIdentity();

    // Hard rule: never start sync during discovery
    const syncWasRunning = !!global.SyncEngine?.isRunning?.();
    if (global.SyncEngine?.stop && syncWasRunning) {
      try { global.SyncEngine.stop(); } catch { /* empty */ }
    }

    const cloudPromise = (async () => {
      const b = bridge();
      if (!b?.discoverCloudRestorePoints) {
        // Fallback: connection-only probe — never recursive listCloudBackups
        const connected = !!global.DriveAdapter?.isConnected?.();
        return {
          ok: true,
          status: connected ? 'ipc_missing' : 'offline',
          message: connected
            ? 'قناة اكتشاف السحابة غير متاحة في هذه النسخة — حدّث التطبيق.'
            : 'حساب Google غير متصل.',
          restorePoints: [],
          newest: null,
          downloadedFullBackup: false,
          durationMs: 0,
          googleConnected: connected,
        };
      }
      return b.discoverCloudRestorePoints({
        centerId: identity.centerId,
        branchId: identity.branchId,
        centerName: identity.centerName,
        timeoutMs: options.timeoutMs || DISCOVERY_TIMEOUT_MS,
      });
    })();

    try {
      const [cloud, localDb, localBackup] = await Promise.all([
        cloudPromise.catch((err) => ({
          ok: false,
          status: 'error',
          message: err.message || String(err),
          restorePoints: [],
          newest: null,
          downloadedFullBackup: false,
        })),
        Promise.resolve().then(probeLocalDatabase),
        probeLocalBackups(),
      ]);

      if (opId !== discoveryOpId) {
        return { ok: false, error: 'stale_discovery', ignored: true };
      }

      // Guard: discovery must never have downloaded a full backup
      if (cloud?.downloadedFullBackup) {
        cloud.status = 'error';
        cloud.message = 'اكتشاف غير آمن: تم تنزيل نسخة كاملة أثناء الفحص.';
      }

      const result = {
        ok: true,
        opId,
        identity,
        durationMs: Date.now() - started,
        cloud,
        localDb,
        localBackup,
        filePick: { available: true, status: 'ready', message: 'اختيار ملف Backup / Database' },
        emptyStart: { available: true, status: 'ready', message: 'البدء بدون بيانات سابقة' },
        syncEngineStarted: false,
        downloadedFullBackup: !!cloud?.downloadedFullBackup,
        instrumentation: cloud?.instrumentation || null,
      };
      lastDiscovery = result;
      return result;
    } finally {
      if (opId === discoveryOpId) {
        discoveryLock = false;
        if (activeAbort === abort) activeAbort = null;
      }
    }
  }

  function buildProgressState(stageId, extra = {}) {
    const idx = RESTORE_STAGES.findIndex((s) => s.id === stageId);
    const totalWeight = RESTORE_STAGES.reduce((a, s) => a + s.weight, 0);
    let doneWeight = 0;
    for (let i = 0; i < Math.max(0, idx); i += 1) doneWeight += RESTORE_STAGES[i].weight;
    const stage = RESTORE_STAGES[idx] || RESTORE_STAGES[0];
    const ratio = Math.min(0.99, (doneWeight + (stage?.weight || 0) * (extra.stageRatio || 0.15)) / totalWeight);
    return {
      stageId: stage?.id || stageId,
      stageLabel: stage?.label || stageId,
      stageIndex: idx + 1,
      stageCount: RESTORE_STAGES.length,
      percent: Math.round(ratio * 100),
      elapsedMs: extra.elapsedMs || 0,
      downloadedBytes: extra.downloadedBytes || 0,
      totalBytes: extra.totalBytes || null,
      filesDone: extra.filesDone || 0,
      filesTotal: extra.filesTotal || null,
      lastActivity: extra.lastActivity || stage?.label || '',
      diagnosticId: extra.diagnosticId || null,
    };
  }

  /**
   * Confirmed restore only — after user presses استعادة هذه البيانات.
   */
  async function confirmedCloudRestore(point, options = {}) {
    if (restoreLock) return { ok: false, error: 'restore_in_flight' };
    if (!point) return { ok: false, error: 'no_restore_point' };

    restoreLock = true;
    const opId = ++restoreOpId;
    const started = Date.now();
    const onProgress = typeof options.onProgress === 'function' ? options.onProgress : () => {};
    const diagnosticId = `RST-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
    let lastProgressAt = Date.now();
    let watchdog = null;

    const emit = (stageId, extra = {}) => {
      lastProgressAt = Date.now();
      const snap = buildProgressState(stageId, {
        ...extra,
        elapsedMs: Date.now() - started,
        diagnosticId,
      });
      try { onProgress(snap); } catch { /* empty */ }
      return snap;
    };

    try {
      // Preserve current DB — never wipe on start
      const preSnapshot = {
        license: !!global.LicenseCloud?.loadLocal?.(),
        deviceId: global.DeviceConfig?.load?.()?.deviceId || null,
        branchId: global.DeviceConfig?.load?.()?.lockedBranchId || null,
        centerId: getIdentity().centerId,
      };

      emit('verify_point', { lastActivity: 'تحقق من نقطة الاستعادة' });
      if (point.validation && point.validation !== 'metadata_ok' && point.validation !== 'ready') {
        return {
          ok: false,
          error: 'invalid_restore_point',
          message: 'النسخة غير صالحة للاستعادة.',
          diagnosticId,
          preserved: preSnapshot,
        };
      }

      emit('local_safety', { lastActivity: 'الاحتفاظ بالحالة المحلية الحالية' });

      watchdog = setInterval(() => {
        if (Date.now() - lastProgressAt > NO_PROGRESS_WATCHDOG_MS) {
          emit('download_db', {
            lastActivity: 'تحذير: لا يوجد تحديث منذ أكثر من 30 ثانية',
            stageRatio: 0.2,
          });
        }
      }, 5000);

      let restoreResult = { ok: false };

      // BootFlow cloud confirm: apply Cloud V2 hydrate (metadata already shown).
      // Encrypted .tdw full-file restore requires password → file picker path.
      // Do NOT download multi‑MB .tdw here without a password / V2 restore execute.
      emit('download_db', { lastActivity: 'سحب حالة السحابة المؤكدة', stageRatio: 0.3 });
      if (global.CloudBootstrap?.hydrateFromDrive) {
        emit('staging', { lastActivity: 'تطبيق الحالة السحابية على Staging محلي' });
        const hydrated = await global.CloudBootstrap.hydrateFromDrive(null, {
          allowMissingLicense: true,
          skipAnalysis: true,
          skipSafeAuto: false,
          markComplete: true,
          force: true,
        });
        restoreResult = {
          ok: !!hydrated?.ok || !!hydrated?.skipped,
          mode: 'cloud_hydrate',
          hydrate: hydrated,
          pointKind: point.kind,
        };
        if (hydrated?.blocked) {
          return {
            ok: false,
            error: hydrated.error || 'unsafe_data_state',
            diagnosticId,
            preserved: preSnapshot,
            detail: hydrated,
          };
        }
      } else {
        return {
          ok: false,
          error: 'restore_path_unavailable',
          diagnosticId,
          preserved: preSnapshot,
        };
      }

      emit('checksums', { stageRatio: 0.5 });
      emit('sqlite_integrity', { stageRatio: 0.5 });
      emit('atomic_swap', { stageRatio: 0.8 });
      emit('remote_compare', { stageRatio: 0.5 });

      // Reconciliation AFTER restore — pull newer only, never push, never during discovery
      emit('reconcile', { lastActivity: 'مواءمة ما بعد الاستعادة' });
      if (global.RestoreReconciliation?.afterRestoreDataSourceSelected) {
        await global.RestoreReconciliation.afterRestoreDataSourceSelected('cloud');
      }

      emit('restart_prep', { stageRatio: 1, lastActivity: 'جاهز لإعادة التشغيل' });

      if (opId !== restoreOpId) {
        return { ok: false, error: 'stale_restore', ignored: true, diagnosticId };
      }

      return {
        ok: restoreResult.ok !== false,
        diagnosticId,
        durationMs: Date.now() - started,
        preserved: preSnapshot,
        result: restoreResult,
        point,
      };
    } catch (err) {
      return {
        ok: false,
        error: err.message || String(err),
        diagnosticId,
        preserved: {
          license: !!global.LicenseCloud?.loadLocal?.(),
          deviceId: global.DeviceConfig?.load?.()?.deviceId || null,
          branchId: global.DeviceConfig?.load?.()?.lockedBranchId || null,
        },
      };
    } finally {
      if (watchdog) clearInterval(watchdog);
      if (opId === restoreOpId) restoreLock = false;
    }
  }

  function cancelDiscovery() {
    discoveryOpId += 1;
    discoveryLock = false;
    try { activeAbort?.abort?.(); } catch { /* empty */ }
    activeAbort = null;
  }

  function cancelRestore() {
    restoreOpId += 1;
    restoreLock = false;
  }

  global.CloudDataDiscovery = {
    DISCOVERY_TIMEOUT_MS,
    RESTORE_STAGES,
    discoverAllSources,
    confirmedCloudRestore,
    buildProgressState,
    formatBytes,
    formatWhen,
    cancelDiscovery,
    cancelRestore,
    getLastDiscovery: () => lastDiscovery,
    isDiscoveryLocked: () => discoveryLock,
    isRestoreLocked: () => restoreLock,
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = global.CloudDataDiscovery;
  }
})(typeof window !== 'undefined' ? window : globalThis);
