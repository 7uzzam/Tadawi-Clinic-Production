/**
 * V2-5.10 — Fast Cloud Data Discovery (Main process).
 * Metadata-only probes with hard timeouts. NEVER downloads DB/backups/attachments.
 */
'use strict';

const drivePaths = require('./cloud-drive-paths');

const DISCOVERY_OVERALL_MS = 15000;
const PER_REQUEST_MS = 10000;

function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const err = new Error(`discovery_timeout:${label}`);
      err.code = 'DISCOVERY_TIMEOUT';
      err.label = label;
      reject(err);
    }, ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function nowIso() {
  return new Date().toISOString();
}

function startTrace(op) {
  return {
    op,
    startedAt: nowIso(),
    startedMs: Date.now(),
    steps: [],
  };
}

function pushStep(trace, name, startMs, result) {
  const endedMs = Date.now();
  trace.steps.push({
    op: name,
    startedAt: new Date(startMs).toISOString(),
    endedAt: new Date(endedMs).toISOString(),
    durationMs: endedMs - startMs,
    requests: result?.requests || 1,
    bytes: result?.bytes || 0,
    ok: result?.ok !== false,
    result: result?.status || (result?.ok === false ? 'fail' : 'ok'),
    detail: result?.detail || result?.message || null,
  });
}

/**
 * Shallow list of files in ONE folder (no recursion).
 */
async function listFolderShallow(googleDrive, folderPath, { pageSize = 50, maxPages = 2 } = {}) {
  const { oauth2 } = await googleDrive.getAuthedClient();
  const parts = String(folderPath || '').split('/').filter(Boolean);
  const parentId = await googleDrive.resolveFolderPath(oauth2, parts, { create: false });
  if (parts.length && !parentId) {
    return { ok: true, items: [], folderMissing: true, requests: 1 };
  }
  const driveApi = require('./cloud-providers/google-drive-api');
  const items = [];
  let pageToken;
  let pages = 0;
  let requests = 1; // resolveFolderPath counted roughly
  do {
    pages += 1;
    const q = [
      parentId ? `'${parentId}' in parents` : "'root' in parents",
      'trashed=false',
    ].join(' and ');
    const res = await driveApi.listFiles(oauth2, {
      q,
      fields: 'nextPageToken,files(id,name,size,modifiedTime,md5Checksum,mimeType)',
      orderBy: 'modifiedTime desc',
      pageSize,
      pageToken,
    });
    requests += 1;
    for (const f of res.files || []) {
      if (f.mimeType === 'application/vnd.google-apps.folder') continue;
      items.push({
        id: f.id,
        name: f.name,
        path: `${folderPath}/${f.name}`,
        size: Number(f.size || 0),
        modifiedAt: f.modifiedTime || null,
        md5: f.md5Checksum || null,
        isMain: drivePaths.isMainBackupName(f.name),
        isBackupV2: /\.tdw$/i.test(f.name) || drivePaths.isDbBackupName(f.name),
      });
    }
    pageToken = res.nextPageToken;
  } while (pageToken && pages < maxPages);
  return { ok: true, items, truncated: !!pageToken, requests };
}

async function probeFileMeta(googleDrive, remotePath) {
  const { oauth2 } = await googleDrive.getAuthedClient();
  const file = await googleDrive.findFileByPath(oauth2, remotePath);
  if (!file) return { ok: true, found: false, requests: 1 };
  return {
    ok: true,
    found: true,
    requests: 1,
    bytes: Number(file.size || 0),
    item: {
      id: file.id,
      name: file.name,
      path: remotePath,
      size: Number(file.size || 0),
      modifiedAt: file.modifiedTime || null,
      md5: file.md5Checksum || null,
    },
  };
}

/**
 * Discover restore points for a center/branch without downloading payloads.
 */
async function discoverCloudRestorePoints(options = {}) {
  const googleDrive = require('./cloud-providers/google-drive');
  const trace = startTrace('cloud_fast_discovery');
  const centerId = String(options.centerId || '').trim();
  const branchId = String(options.branchId || '').trim();
  const centerName = String(options.centerName || '').trim();
  const overallMs = Math.min(Number(options.timeoutMs) || DISCOVERY_OVERALL_MS, 20000);

  const out = {
    ok: true,
    mode: 'fast_discovery',
    centerId: centerId || null,
    branchId: branchId || null,
    centerName: centerName || null,
    googleConnected: false,
    restorePoints: [],
    newest: null,
    status: 'unknown',
    message: null,
    durationMs: 0,
    timedOut: false,
    downloadedBytes: 0,
    downloadedFullBackup: false,
    syncEngineStarted: false,
    instrumentation: trace,
  };

  const overallDeadline = Date.now() + overallMs;

  async function step(name, fn, budgetMs = PER_REQUEST_MS) {
    const remaining = overallDeadline - Date.now();
    if (remaining <= 0) {
      const err = new Error('discovery_timeout:overall');
      err.code = 'DISCOVERY_TIMEOUT';
      throw err;
    }
    const start = Date.now();
    try {
      const result = await withTimeout(fn(), Math.min(budgetMs, remaining), name);
      pushStep(trace, name, start, result && typeof result === 'object' ? result : { ok: true });
      return result;
    } catch (err) {
      pushStep(trace, name, start, {
        ok: false,
        status: err.code || 'error',
        detail: err.message || String(err),
      });
      throw err;
    }
  }

  try {
    // 1) Google connection / token
    const status = await step('oauth_status', async () => {
      const s = await googleDrive.getStatus();
      return {
        ok: !!s?.connected && !s?.needsReauth,
        status: s?.needsReauth ? 'needs_reauth' : (s?.connected ? 'connected' : 'disconnected'),
        detail: s?.email || null,
        requests: 1,
        raw: s,
      };
    });
    out.googleConnected = !!status?.ok;
    if (!out.googleConnected) {
      out.status = status?.status === 'needs_reauth' ? 'token_expired' : 'offline';
      out.message = status?.status === 'needs_reauth'
        ? 'انتهت صلاحية جلسة Google — أعد الربط ثم أعد المحاولة.'
        : 'حساب Google غير متصل.';
      out.ok = true;
      out.durationMs = Date.now() - trace.startedMs;
      trace.endedAt = nowIso();
      trace.durationMs = out.durationMs;
      return out;
    }

    if (!centerId) {
      out.status = 'missing_center';
      out.message = 'لا يوجد centerId محلي للبحث عن بيانات سحابية.';
      out.durationMs = Date.now() - trace.startedMs;
      trace.endedAt = nowIso();
      trace.durationMs = out.durationMs;
      return out;
    }

    // 2) Shallow backup folder probes (Auto + Manual) — NO recursion, NO download
    const backupFolders = [
      drivePaths.buildV2Path(centerId, 'Backups', 'Auto'),
      drivePaths.buildV2Path(centerId, 'Backups', 'Manual'),
      drivePaths.buildV2Path(centerId, 'Backups'),
    ];
    if (centerName) {
      backupFolders.push(`${drivePaths.DRIVE_APP_FOLDER}/${drivePaths.sanitizeCenter(centerName)}`);
    }

    const seen = new Set();
    for (const folder of backupFolders) {
      if (Date.now() >= overallDeadline) break;
      try {
        const listed = await step(`list_shallow:${folder}`, () => listFolderShallow(googleDrive, folder, {
          pageSize: 40,
          maxPages: 1,
        }), PER_REQUEST_MS);
        for (const item of listed.items || []) {
          if (!item.isBackupV2 && !/\.tdw$/i.test(item.name) && !drivePaths.isDbBackupName(item.name)) continue;
          if (seen.has(item.id || item.path)) continue;
          seen.add(item.id || item.path);
          out.restorePoints.push({
            kind: 'backup_file',
            source: 'cloud_backup',
            id: item.id,
            name: item.name,
            path: item.path,
            sizeBytes: item.size || 0,
            modifiedAt: item.modifiedAt,
            md5: item.md5,
            centerId,
            branchId: branchId || null,
            schemaVersion: null,
            revision: null,
            attachmentCount: null,
            recordCount: null,
            validation: 'metadata_ok',
          });
        }
      } catch (err) {
        if (err.code === 'DISCOVERY_TIMEOUT') throw err;
        // folder missing / access — continue other probes
      }
    }

    // 3) Sync checkpoint / versions.json metadata only (file meta, not full table sync)
    const versionsPath = drivePaths.buildV2SyncVersionsPath(centerId);
    try {
      const meta = await step('versions_meta', () => probeFileMeta(googleDrive, versionsPath), PER_REQUEST_MS);
      if (meta.found) {
        out.restorePoints.push({
          kind: 'sync_checkpoint',
          source: 'cloud_sync',
          id: meta.item.id,
          name: meta.item.name,
          path: meta.item.path,
          sizeBytes: meta.item.size || 0,
          modifiedAt: meta.item.modifiedAt,
          md5: meta.item.md5,
          centerId,
          branchId: branchId || null,
          schemaVersion: null,
          revision: 'versions.json',
          attachmentCount: null,
          recordCount: null,
          validation: 'metadata_ok',
        });
      }
    } catch (err) {
      if (err.code === 'DISCOVERY_TIMEOUT') throw err;
    }

    // Prefer newest backup_file; else sync checkpoint
    out.restorePoints.sort((a, b) => String(b.modifiedAt || '').localeCompare(String(a.modifiedAt || '')));
    const newestBackup = out.restorePoints.find((p) => p.kind === 'backup_file') || null;
    const newestAny = out.restorePoints[0] || null;
    out.newest = newestBackup || newestAny;

    if (!out.newest) {
      out.status = 'not_found';
      out.message = 'لم يتم العثور على بيانات سحابية لهذا الفرع.';
    } else {
      out.status = 'ready';
      out.message = 'وُجدت نقطة استعادة سحابية — أكّد قبل التنزيل.';
    }
  } catch (err) {
    if (err.code === 'DISCOVERY_TIMEOUT') {
      out.timedOut = true;
      out.status = 'timeout';
      out.message = 'تجاوز فحص السحابة المهلة (15 ثانية). أعد المحاولة أو اختر مصدراً آخر.';
      out.ok = true; // discovery completed with timeout outcome — not a crash
    } else {
      out.ok = false;
      out.status = 'error';
      out.message = err.message || String(err);
    }
  }

  out.durationMs = Date.now() - trace.startedMs;
  trace.endedAt = nowIso();
  trace.durationMs = out.durationMs;
  out.instrumentation = trace;
  return out;
}

module.exports = {
  DISCOVERY_OVERALL_MS,
  PER_REQUEST_MS,
  withTimeout,
  listFolderShallow,
  probeFileMeta,
  discoverCloudRestorePoints,
};
