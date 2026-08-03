const { app, BrowserWindow, ipcMain, Menu, session, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const uninstallPrep = require('./uninstall-prep');
const userdataMigration = require('./userdata-migration');
const pathGuard = require('./security/path-guard');
const V = require('./security/ipc-validate');
const windowPolicy = require('./security/window-policy');
const rbacSession = require('./rbac-session');

/** Fixed userData path — preserves data across rebranding and reinstalls */
const USER_DATA_FOLDER = 'Cupping Center';
const APP_ROOT = path.join(__dirname, '..');
const MAIN_PRELOAD = path.join(__dirname, 'preload.js');
const PRINT_PRELOAD = path.join(__dirname, 'security', 'preload-print.js');

const IS_UNINSTALL_PREP = process.argv.includes('--uninstall-prep');
const IS_UNINSTALL_FULL = process.argv.includes('--uninstall-full');
const WIPE_ONLY_IDX = process.argv.indexOf('--uninstall-wipe-only');
const IS_UNINSTALL_WIPE_ONLY = WIPE_ONLY_IDX >= 0;
const WIPE_ONLY_TARGET = IS_UNINSTALL_WIPE_ONLY
  ? String(process.argv[WIPE_ONLY_IDX + 1] || '').trim()
  : '';
if (WIPE_ONLY_TARGET) {
  app.commandLine.appendSwitch('user-data-dir', WIPE_ONLY_TARGET);
}
if (IS_UNINSTALL_PREP || IS_UNINSTALL_WIPE_ONLY) {
  app.commandLine.appendSwitch('disable-gpu');
}
const pkg = require('../package.json');
const branding = require('../branding.config.json');
const APP_VERSION = pkg.version || '2.0.0';
const APP_PUBLISHER = branding.company?.name || 'NajjarTech';
const APP_PRODUCT_NAME = branding.product?.name || pkg.build?.productName || 'Hijama Management System';
const APP_ICON_PATH = path.join(APP_ROOT, 'build', 'Program-Icon.ico');
const APP_ICON = fs.existsSync(APP_ICON_PATH) ? APP_ICON_PATH : undefined;

// Packaged apps always use a stable userData folder — except wipe-only mode,
// which must target the path passed by uninstall-prep (archive or live root).
// Must run BEFORE any BrowserWindow or DB open.
if (app.isPackaged) {
  if (WIPE_ONLY_TARGET) {
    app.setPath('userData', WIPE_ONLY_TARGET);
  } else {
    app.setPath('userData', path.join(app.getPath('appData'), USER_DATA_FOLDER));
  }
} else if (WIPE_ONLY_TARGET) {
  app.setPath('userData', WIPE_ONLY_TARGET);
} else if (process.env.TDAWI_FORCE_USER_DATA_FOLDER === '1') {
  app.setPath('userData', path.join(app.getPath('appData'), USER_DATA_FOLDER));
}

app.setName(APP_PRODUCT_NAME);

if (process.platform === 'win32') {
  app.setAppUserModelId('com.tadawi.cuppingcenter');
}

app.setAboutPanelOptions({
  applicationName: APP_PRODUCT_NAME,
  applicationVersion: APP_VERSION,
  version: APP_VERSION,
  copyright: branding.company?.copyright || `Copyright © ${new Date().getFullYear()} ${APP_PUBLISHER}. All rights reserved.`,
  credits: `Developed by ${APP_PUBLISHER}\n${branding.company?.tagline || ''}\n${branding.product?.description || ''}\n\nSupport: ${branding.company?.supportEmail || ''}`,
  website: branding.company?.website || 'https://najjartech.com',
});

const {
  saveLocal: backupSaveLocal,
  connectGoogle: backupConnectGoogle,
  registerCloudAccount: backupRegisterCloudAccount,
  uploadCloud: backupUploadCloud,
  uploadSyncFile: backupUploadSyncFile,
  downloadSyncFile: backupDownloadSyncFile,
  disconnectCloud: backupDisconnectCloud,
  listCloudBackups: backupListCloudBackups,
  downloadCloudBackup: backupDownloadCloudBackup,
  deleteCloudBackup: backupDeleteCloudBackup,
  verifyCloudBackup: backupVerifyCloudBackup,
  startOAuth: backupStartOAuth,
  getCloudStatus: backupGetCloudStatus,
  listCloudProviders: backupListCloudProviders,
  pickLocalFolder: backupPickLocalFolder,
  uploadDbBackup: backupUploadDbBackup,
  listDbBackups: backupListDbBackups,
  restoreDbBackup: backupRestoreDbBackup,
  syncDbBackup: backupSyncDbBackup,
  verifyDbBackup: backupVerifyDbBackup,
} = require('./backup');
const { createDeviceCache } = require('./device-cache');

function getDeviceCache() {
  return createDeviceCache(app.getPath('userData'));
}
const {
  listPrinters,
  openCashDrawer,
  openCashDrawerDirect,
  printThermal,
  printA4,
  printWithDialog,
  exportA4Pdf,
  getDeviceStatus,
  writeRaw,
} = require('./devices');
const { sendWhatsApp, sendSMS, getMessagingStatus, gateway } = require('./messaging');

let mainWindow = null;
const IS_PROD = app.isPackaged;
const CLOUD_PROVIDERS = ['google', 'local-folder', 'local-vault', 'onedrive', 'dropbox'];

function assertTrustedSender(event) {
  try {
    const wc = event?.sender;
    if (!wc || wc.isDestroyed()) V.fail('IPC_SENDER', 'sender_destroyed');
    const url = wc.getURL?.() || '';
    if (!url) return;
    if (windowPolicy.isBlankUrl(url)) return;
    if (!windowPolicy.isAppLocalUrl(url, APP_ROOT)) {
      V.fail('IPC_SENDER', 'untrusted_sender');
    }
  } catch (err) {
    if (err.code) throw err;
  }
}

function handle(channel, handler) {
  ipcMain.handle(channel, V.guard(async (event, ...args) => {
    assertTrustedSender(event);
    rbacSession.assertChannelAllowed(event, channel);
    return handler(event, ...args);
  }));
}

async function runUninstallWipeOnlyWindow() {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      try { win?.destroy(); } catch { /* ignore */ }
      reject(new Error('uninstall_wipe_timeout'));
    }, 90_000);

    const finish = (code) => {
      clearTimeout(timeout);
      try { win?.destroy(); } catch { /* ignore */ }
      resolve(code);
    };

    ipcMain.once('uninstall:wipeComplete', () => finish(0));

    const win = new BrowserWindow({
      show: false,
      width: 400,
      height: 300,
      ...(APP_ICON ? { icon: APP_ICON } : {}),
      webPreferences: windowPolicy.secureWebPreferences({
        preloadPath: MAIN_PRELOAD,
        isProd: true,
        sandbox: true,
      }),
    });

    win.webContents.on('did-fail-load', () => finish(1));
    win.loadFile(path.join(APP_ROOT, 'index.html'), {
      query: { uninstallLicenseWipe: '1' },
    }).catch(() => finish(1));
  });
}

function hardenWindowForProduction(win) {
  if (!IS_PROD || !win?.webContents) return;

  win.setMenuBarVisibility(false);
  win.setAutoHideMenuBar(true);

  win.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return;
    const key = String(input.key || '').toLowerCase();
    const ctrl = !!(input.control || input.meta);
    const shift = !!input.shift;
    const blocked =
      key === 'f12' ||
      (ctrl && shift && (key === 'i' || key === 'j' || key === 'c')) ||
      (ctrl && key === 'u');
    if (blocked) event.preventDefault();
  });

  win.webContents.on('devtools-opened', () => {
    win.webContents.closeDevTools();
  });

  win.webContents.on('context-menu', (event) => {
    event.preventDefault();
  });
}

function attachWindowOpenPolicy(parentWin) {
  parentWin.webContents.setWindowOpenHandler(({ url, features }) => {
    const kind = windowPolicy.classifyWindowOpen(url, APP_ROOT);

    if (kind === 'external') {
      windowPolicy.openExternalSafe(url).catch(() => {});
      return { action: 'deny' };
    }

    if (kind === 'deny') {
      return { action: 'deny' };
    }

    let width = kind === 'print' ? 920 : 1024;
    let height = kind === 'print' ? 800 : 768;
    const wMatch = /width=(\d+)/i.exec(features || '');
    const hMatch = /height=(\d+)/i.exec(features || '');
    if (wMatch) width = parseInt(wMatch[1], 10) || width;
    if (hMatch) height = parseInt(hMatch[1], 10) || height;

    // Print / about:blank and queue display: limited print preload — never main preload
    return {
      action: 'allow',
      overrideBrowserWindowOptions: {
        show: true,
        width,
        height,
        autoHideMenuBar: IS_PROD,
        webPreferences: windowPolicy.secureWebPreferences({
          preloadPath: PRINT_PRELOAD,
          isProd: IS_PROD,
          sandbox: true,
        }),
      },
    };
  });

  parentWin.webContents.on('did-create-window', (childWin) => {
    windowPolicy.attachNavigationGuards(childWin.webContents, { appRoot: APP_ROOT, isMain: false });
    if (IS_PROD) hardenWindowForProduction(childWin);
  });
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1024,
    minHeight: 700,
    title: `${APP_PRODUCT_NAME} — ${APP_PUBLISHER}`,
    ...(APP_ICON ? { icon: APP_ICON } : {}),
    autoHideMenuBar: IS_PROD,
    webPreferences: windowPolicy.secureWebPreferences({
      preloadPath: MAIN_PRELOAD,
      isProd: IS_PROD,
      sandbox: true,
    }),
  });

  if (IS_PROD) {
    Menu.setApplicationMenu(null);
    mainWindow.setMenuBarVisibility(false);
    mainWindow.setAutoHideMenuBar(true);
    hardenWindowForProduction(mainWindow);
  }

  windowPolicy.attachNavigationGuards(mainWindow.webContents, { appRoot: APP_ROOT, isMain: true });
  attachWindowOpenPolicy(mainWindow);

  mainWindow.loadFile(path.join(APP_ROOT, 'index.html'));

  mainWindow.webContents.on('did-finish-load', () => {
    gateway.initGateway({}, mainWindow).catch(() => {});
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

app.whenReady().then(async () => {
  const ses = session.defaultSession;
  windowPolicy.applyPermissionPolicy(ses);
  windowPolicy.applyContentSecurityPolicy(ses);

  if (IS_UNINSTALL_WIPE_ONLY) {
    try {
      await runUninstallWipeOnlyWindow();
      app.exit(0);
    } catch {
      app.exit(1);
    }
    return;
  }
  if (IS_UNINSTALL_PREP) {
    try {
      const result = await uninstallPrep.runUninstallPrep({
        userDataRoot: app.getPath('userData'),
        execPath: process.execPath,
        fullRemoval: IS_UNINSTALL_FULL,
      });
      app.exit(result.ok ? 0 : 1);
    } catch {
      app.exit(1);
    }
    return;
  }

  // DATA-001..006: migrate legacy userData into canonical Cupping Center (once).
  if (!IS_UNINSTALL_WIPE_ONLY && (app.isPackaged || process.env.TDAWI_FORCE_USER_DATA_FOLDER === '1')) {
    try {
      const canonical = app.getPath('userData');
      const mig = userdataMigration.migrateUserDataIfNeeded({
        canonicalRoot: canonical,
        appData: app.getPath('appData'),
        localAppData: process.env.LOCALAPPDATA || '',
        log: (...args) => console.log(...args),
        integrityCheckDb: (dbPath) => {
          try {
            const Database = require('better-sqlite3');
            const db = new Database(dbPath, { readonly: true, fileMustExist: true });
            const row = db.prepare('PRAGMA integrity_check').get();
            const ok = row && String(row.integrity_check || Object.values(row)[0]).toLowerCase() === 'ok';
            try { db.close(); } catch { /* ignore */ }
            return { ok, detail: row };
          } catch (err) {
            return { ok: false, detail: String(err && err.message) };
          }
        },
      });
      if (!mig.ok) {
        console.error('[userdata-migration] blocked startup safely:', mig.error || mig);
      }
    } catch (err) {
      console.error('[userdata-migration] unexpected error (continuing with canonical path):', err.message);
    }
  }

  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

let _isQuitting = false;
function gracefulShutdown(reason) {
  if (_isQuitting) return;
  _isQuitting = true;
  try {
    console.log('[quit] gracefulShutdown:', reason || 'unknown');
  } catch { /* ignore */ }
  try {
    const dbService = require('./database/service');
    dbService.close?.();
  } catch { /* ignore */ }
  try {
    for (const win of BrowserWindow.getAllWindows()) {
      try {
        if (!win.isDestroyed()) win.destroy();
      } catch { /* ignore */ }
    }
  } catch { /* ignore */ }
}

app.on('before-quit', () => {
  gracefulShutdown('before-quit');
});
app.on('will-quit', () => {
  gracefulShutdown('will-quit');
});
app.on('quit', () => {
  gracefulShutdown('quit');
});

// ── Devices ──────────────────────────────────────────────
handle('devices:listPrinters', () => listPrinters());
handle('devices:printThermal', (_e, html, opts) => {
  const safeHtml = V.asHtml(html);
  return printThermal(safeHtml, V.asObject(opts));
});
handle('devices:printA4', (_e, html, opts) => {
  const safeHtml = V.asHtml(html);
  return printA4(safeHtml, V.asObject(opts));
});
handle('devices:exportA4Pdf', (_e, html, opts) => {
  const safeHtml = V.asHtml(html);
  return exportA4Pdf(safeHtml, V.asObject(opts));
});
handle('devices:printWithDialog', (_e, html, opts) => {
  const safeHtml = V.asHtml(html);
  return printWithDialog(safeHtml, V.asObject(opts));
});
handle('devices:openCashDrawer', (_e, opts) => openCashDrawer(V.asObject(opts)));
handle('devices:openCashDrawerDirect', (_e, opts) => openCashDrawerDirect(V.asObject(opts)));
handle('devices:getStatus', (_e, saved) => getDeviceStatus(V.asObject(saved)));
handle('devices:writeRaw', (_e, printerName, buffer) => {
  const name = V.asString(printerName, { name: 'printerName', max: 256, required: true, allowEmpty: false });
  return writeRaw(name, V.asBufferish(buffer));
});

// ── Messaging ────────────────────────────────────────────
handle('messaging:sendWhatsApp', (_e, phone, text, config, meta) =>
  sendWhatsApp(
    V.asString(phone, { name: 'phone', max: 40, required: true }),
    V.asString(text, { name: 'text', max: 10000, required: true }),
    V.asObject(config),
    V.asObject(meta)
  ));
handle('messaging:sendSMS', (_e, phone, text, config, meta) =>
  sendSMS(
    V.asString(phone, { name: 'phone', max: 40, required: true }),
    V.asString(text, { name: 'text', max: 2000, required: true }),
    V.asObject(config),
    V.asObject(meta)
  ));
handle('messaging:getStatus', (_e, config) => getMessagingStatus(V.asObject(config)));

// ── Communication gateway ────────────────────────────────
handle('communication:listProviders', () => gateway.listBuiltinProviders());
handle('communication:testProvider', (_e, provider) =>
  gateway.testProvider(V.asObject(provider, { required: true })));
handle('communication:send', (_e, config, payload) =>
  gateway.sendMessage(V.asObject(config), V.asObject(payload, { required: true })));
handle('communication:getStatus', (_e, config) => gateway.getGatewayStatus(V.asObject(config)));
handle('communication:processQueue', (_e, config) => gateway.processQueueNow(V.asObject(config)));
handle('communication:getQueue', () => gateway.getQueueItems(80));
handle('communication:clearQueue', (_e, status) =>
  gateway.clearQueue(V.asOptionalString(status, { name: 'status', max: 40 })));
handle('communication:init', (_e, config) => {
  if (mainWindow) return gateway.initGateway(V.asObject(config), mainWindow);
  return { ok: false };
});

// ── Backup ───────────────────────────────────────────────
handle('backup:saveLocal', async (_e, payload, filename, localPath) => {
  const data = V.asPayload(payload);
  const name = V.asString(filename, { name: 'filename', max: 200, required: true });
  const hint = V.asOptionalString(localPath, { name: 'localPath', max: 500 });
  return backupSaveLocal(data, name, hint);
});

handle('backup:connectGoogle', async (_e, email, provider) =>
  backupConnectGoogle(
    V.asEmail(email),
    V.asEnum(provider, CLOUD_PROVIDERS, { defaultValue: 'google' })
  ));

handle('backup:registerCloudAccount', async (_e, email, provider) =>
  backupRegisterCloudAccount(
    V.asEmail(email, { required: true }),
    V.asEnum(provider, CLOUD_PROVIDERS, { defaultValue: 'google' })
  ));

handle('backup:uploadCloud', async (_e, payload, filename, provider, meta) =>
  backupUploadCloud(
    V.asPayload(payload),
    V.asString(filename, { name: 'filename', max: 200, required: true }),
    V.asEnum(provider, CLOUD_PROVIDERS, { defaultValue: 'google' }),
    V.asObject(meta)
  ));

handle('backup:uploadSyncFile', async (_e, payload, filename, provider, folder) =>
  backupUploadSyncFile(
    V.asPayload(payload),
    V.asString(filename, { name: 'filename', max: 200, required: true }),
    V.asEnum(provider, CLOUD_PROVIDERS, { defaultValue: 'google' }),
    V.asOptionalString(folder, { name: 'folder', max: 200 })
  ));

handle('backup:downloadSyncFile', async (_e, filename, provider, folder) =>
  backupDownloadSyncFile(
    V.asString(filename, { name: 'filename', max: 200, required: true }),
    V.asEnum(provider, CLOUD_PROVIDERS, { defaultValue: 'google' }),
    V.asOptionalString(folder, { name: 'folder', max: 200 })
  ));

handle('backup:disconnectCloud', async (_e, provider) =>
  backupDisconnectCloud(V.asEnum(provider, CLOUD_PROVIDERS, { defaultValue: 'google' })));

handle('backup:listCloudBackups', async (_e, provider, prefix) =>
  backupListCloudBackups(
    V.asEnum(provider, CLOUD_PROVIDERS, { defaultValue: 'google' }),
    V.asOptionalString(prefix, { name: 'prefix', max: 200 })
  ));

handle('backup:downloadCloudBackup', async (_e, remotePath, provider) => {
  const rp = V.asString(remotePath, { name: 'remotePath', max: 1000, required: true });
  if (pathGuard.hasTraversal(rp)) V.fail('PATH_TRAVERSAL', 'remote_path_traversal');
  return backupDownloadCloudBackup(rp, V.asEnum(provider, CLOUD_PROVIDERS, { defaultValue: 'google' }));
});

handle('backup:deleteCloudBackup', async (_e, remotePath, provider) => {
  const rp = V.asString(remotePath, { name: 'remotePath', max: 1000, required: true });
  if (pathGuard.hasTraversal(rp)) V.fail('PATH_TRAVERSAL', 'remote_path_traversal');
  return backupDeleteCloudBackup(rp, V.asEnum(provider, CLOUD_PROVIDERS, { defaultValue: 'google' }));
});

handle('backup:verifyCloudBackup', async (_e, remotePath, expectedHash, provider) => {
  const rp = V.asString(remotePath, { name: 'remotePath', max: 1000, required: true });
  if (pathGuard.hasTraversal(rp)) V.fail('PATH_TRAVERSAL', 'remote_path_traversal');
  return backupVerifyCloudBackup(
    rp,
    V.asString(expectedHash, { name: 'expectedHash', max: 128, required: true }),
    V.asEnum(provider, CLOUD_PROVIDERS, { defaultValue: 'google' })
  );
});

handle('backup:startOAuth', async (_e, provider, opts) =>
  backupStartOAuth(
    V.asEnum(provider, CLOUD_PROVIDERS, { defaultValue: 'google' }),
    V.asObject(opts)
  ));

handle('backup:getCloudStatus', async (_e, provider) =>
  backupGetCloudStatus(V.asEnum(provider, CLOUD_PROVIDERS, { defaultValue: 'google' })));

handle('backup:listCloudProviders', async () => backupListCloudProviders());

handle('backup:pickLocalFolder', async () => backupPickLocalFolder());

handle('backup:uploadDbBackup', async (_e, password, meta) =>
  backupUploadDbBackup(
    V.asString(password, { name: 'password', max: 200, required: true, allowEmpty: false }),
    V.asObject(meta)
  ));

handle('backup:listDbBackups', async (_e, meta) => backupListDbBackups(V.asObject(meta)));

handle('backup:restoreDbBackup', async (_e, remotePath, password, relaunch) => {
  const rp = V.asString(remotePath, { name: 'remotePath', max: 1000, required: true });
  if (pathGuard.hasTraversal(rp)) V.fail('PATH_TRAVERSAL', 'remote_path_traversal');
  const result = await backupRestoreDbBackup(
    rp,
    V.asString(password, { name: 'password', max: 200, required: true, allowEmpty: false })
  );
  if (result.ok && result.needRestart && relaunch !== false) {
    app.relaunch();
    app.exit(0);
  }
  return result;
});

handle('backup:syncDbBackup', async (_e, password, meta) =>
  backupSyncDbBackup(
    V.asString(password, { name: 'password', max: 200, required: true, allowEmpty: false }),
    V.asObject(meta)
  ));

handle('backup:verifyDbBackup', async (_e, remotePath, expectedHash) => {
  const rp = V.asString(remotePath, { name: 'remotePath', max: 1000, required: true });
  if (pathGuard.hasTraversal(rp)) V.fail('PATH_TRAVERSAL', 'remote_path_traversal');
  return backupVerifyDbBackup(
    rp,
    V.asString(expectedHash, { name: 'expectedHash', max: 128, required: true })
  );
});

// Attachments lifecycle IPC (local blob store)
require('./attachments-ipc').registerAttachmentsIpc(handle);

// Hybrid Backup V2 (main-process; feature flag HYBRID_BACKUP_V2, default on)
const dbServiceForBackup = require('./database/service');
require('./backup-v2-ipc').registerBackupV2Ipc({
  handle,
  V,
  getUserDataPath: () => app.getPath('userData'),
  appVersion: APP_VERSION,
  app,
  closeDatabase: async () => {
    dbServiceForBackup.close?.();
  },
  reopenDatabase: async () => {
    dbServiceForBackup.ensureDb?.();
  },
  getLiveIdentity: () => {
    try {
      const userData = app.getPath('userData');
      const settingsPath = path.join(userData, 'settings', 'app.json');
      let settings = {};
      if (fs.existsSync(settingsPath)) {
        settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8')) || {};
      }
      const cloud = settings.cloudV2 || settings.cloud || {};
      const centerId = String(cloud.centerId || settings.centerId || '').slice(0, 128);
      const branchId = String(cloud.branchId || settings.branchId || settings.activeBranchId || '').slice(0, 128);
      return {
        centerId,
        organizationId: String(cloud.organizationId || centerId || '').slice(0, 128),
        branchId,
        authorizedBranchIds: branchId ? [branchId] : [],
        deviceId: String(cloud.deviceId || settings.deviceId || '').slice(0, 128),
        centerName: String(settings.centerName || cloud.centerName || '').slice(0, 200),
        deviceName: String(settings.deviceName || cloud.deviceName || '').slice(0, 200),
      };
    } catch {
      return {};
    }
  },
});

// ── Device cache ─────────────────────────────────────────
handle('cache:writeBranchConfig', async (_e, centerId, branchId, pack) =>
  getDeviceCache().writeBranchConfig(
    pathGuard.safeId(centerId, 'centerId'),
    pathGuard.safeId(branchId, 'branchId'),
    V.asObject(pack, { required: true })
  ));

handle('cache:readBranchConfig', async (_e, centerId, branchId) =>
  getDeviceCache().readBranchConfig(
    pathGuard.safeId(centerId, 'centerId'),
    pathGuard.safeId(branchId, 'branchId')
  ));

handle('cache:writeLicense', async (_e, centerId, doc) =>
  getDeviceCache().writeLicense(
    pathGuard.safeId(centerId, 'centerId'),
    V.asObject(doc, { required: true })
  ));

handle('cache:readLicense', async (_e, centerId) =>
  getDeviceCache().readLicense(pathGuard.safeId(centerId, 'centerId')));

handle('cache:writeVersions', async (_e, centerId, versions) =>
  getDeviceCache().writeVersions(
    pathGuard.safeId(centerId, 'centerId'),
    V.asObject(versions, { required: true })
  ));

handle('cache:readVersions', async (_e, centerId) =>
  getDeviceCache().readVersions(pathGuard.safeId(centerId, 'centerId')));

handle('cache:getStatus', async (_e, centerId) =>
  getDeviceCache().getStatus(pathGuard.safeId(centerId, 'centerId')));

const LICENSE_WIPE_FLAG = '.license-wipe-on-launch';

function rmDirSafe(dir) {
  if (!dir || !fs.existsSync(dir)) return;
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch { /* ignore */ }
}

function wipePersistentLicenseData(userDataRoot) {
  const root = userDataRoot || app.getPath('userData');
  // Prefer shared uninstall-prep helper when available
  if (typeof uninstallPrep.wipeChromiumLicenseStorage === 'function') {
    uninstallPrep.wipeChromiumLicenseStorage(root);
  }
  [
    'CloudVault', 'cache', 'Local Storage', 'Session Storage', 'IndexedDB',
    'Code Cache', 'GPUCache', 'blob_storage', 'databases', 'Service Worker',
    'Cookies', 'Network', 'WebStorage'
  ].forEach((sub) => rmDirSafe(path.join(root, sub)));
  [
    'cloud-oauth.config.json', 'cloud-oauth.developer.json',
    'communication-queue.json', LICENSE_WIPE_FLAG, 'Preferences', 'Local State'
  ].forEach((f) => {
    try {
      const p = path.join(root, f);
      if (fs.existsSync(p)) fs.unlinkSync(p);
    } catch { /* ignore */ }
  });
}

handle('app:consumeLicenseWipeFlag', () => {
  try {
    const flagPath = path.join(app.getPath('userData'), LICENSE_WIPE_FLAG);
    if (fs.existsSync(flagPath)) {
      fs.unlinkSync(flagPath);
      wipePersistentLicenseData();
      return { wipe: true };
    }
  } catch { /* ignore */ }
  return { wipe: false };
});

handle('app:wipePersistentLicenseData', () => {
  try {
    wipePersistentLicenseData();
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

handle('app:writeUninstallCenterMeta', (_e, payload) => {
  try {
    const doc = uninstallPrep.writeUninstallCenterMeta(app.getPath('userData'), V.asObject(payload));
    return { ok: !!doc, meta: doc };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

handle('app:getRuntimeInfo', () => ({
  environment: app.isPackaged ? 'Production' : 'Development',
  appVersion: APP_VERSION,
  buildVersion: APP_VERSION,
  dbSchemaVersion: branding.product?.dbSchemaVersion ?? 3,
  electron: process.versions.electron,
  chromium: process.versions.chrome,
  node: process.versions.node,
  productName: APP_PRODUCT_NAME,
  company: APP_PUBLISHER,
  security: {
    contextIsolation: true,
    nodeIntegration: false,
    sandbox: true,
    webSecurity: true,
  },
}));

handle('app:getDeviceFingerprintParts', () => {
  const os = require('os');
  const crypto = require('crypto');
  const hash = (s) => crypto.createHash('sha256').update(String(s || '')).digest('hex').slice(0, 16);
  return {
    ok: true,
    platform: process.platform,
    arch: process.arch,
    hostnameHash: hash(os.hostname()),
    userDataHash: hash(app.getPath('userData')),
  };
});

handle('app:openExternal', async (_e, url) => {
  const target = V.asString(url, { name: 'url', max: 2000, required: true, allowEmpty: false });
  return windowPolicy.openExternalSafe(target);
});

const dbService = require('./database/service');

function lookupUsersFromKv() {
  try {
    const hydrated = dbService.hydrate();
    const data = hydrated?.data || {};
    if (Array.isArray(data.users)) return data.users;
    // users often live in kv export
    for (const [k, v] of Object.entries(data)) {
      if (k === 'users' && Array.isArray(v)) return v;
    }
    return [];
  } catch {
    return [];
  }
}

handle('rbac:bindSession', (e, claim) => {
  const payload = V.asObject(claim, { name: 'claim', required: true, maxKeys: 40 });
  return rbacSession.bindSession(e, {
    ...payload,
    lookupUsers: lookupUsersFromKv,
  });
});
handle('rbac:clearSession', (e) => rbacSession.clearSession(e));
handle('rbac:getSession', (e) => {
  const s = rbacSession.getSession(e);
  return s
    ? { ok: true, session: { userId: s.userId, role: s.role, boundAt: s.boundAt } }
    : { ok: false, error: 'no_session' };
});

/** Sync native confirm — used by renderer window.confirm polyfill (logout, deletes, …). */
ipcMain.on('dialog:confirmSync', (event, message) => {
  try {
    assertTrustedSender(event);
    const win = BrowserWindow.fromWebContents(event.sender);
    const res = dialog.showMessageBoxSync(win || undefined, {
      type: 'question',
      buttons: ['إلغاء', 'تأكيد'],
      defaultId: 1,
      cancelId: 0,
      noLink: true,
      title: 'تأكيد',
      message: String(message || 'هل أنت متأكد؟').slice(0, 2000),
    });
    event.returnValue = res === 1;
  } catch {
    event.returnValue = false;
  }
});

/** Sync native prompt (simple single-line) — Electron has no window.prompt. */
ipcMain.on('dialog:promptSync', (event, message, defaultValue) => {
  try {
    assertTrustedSender(event);
    const win = BrowserWindow.fromWebContents(event.sender);
    // MessageBox cannot collect text; return null and let renderer use async modal.
    // Kept as channel for future custom prompt window; currently always null.
    void win;
    void message;
    void defaultValue;
    event.returnValue = null;
  } catch {
    event.returnValue = null;
  }
});

handle('database:status', () => dbService.getStatus());
handle('database:hydrate', () => dbService.hydrate());
handle('database:persistTable', (e, tableKey, records) => {
  const key = V.asString(tableKey, { name: 'tableKey', max: 64, required: true, allowEmpty: false });
  if (!Array.isArray(records)) V.fail('IPC_TYPE', 'records_must_be_array');
  if (records.length > 200000) V.fail('IPC_TOO_LARGE', 'records_too_many');
  // Reject cross-branch payloads when session scope is limited.
  const session = rbacSession.getSession(e);
  if (session && Array.isArray(session.branchScope) && !session.branchScope.includes('*')) {
    for (const row of records) {
      const bid = row && row.branchId;
      if (bid && !session.branchScope.includes(bid)) {
        V.fail('RBAC_BRANCH', 'branch_access_denied');
      }
    }
  }
  return dbService.persistTable(key, records);
});
handle('database:persistKv', (_e, key, value) => {
  const k = V.asString(key, { name: 'key', max: 128, required: true, allowEmpty: false });
  return dbService.persistKv(k, value);
});
handle('database:seedUsersIfEmpty', (_e, users) => {
  if (!Array.isArray(users)) V.fail('IPC_TYPE', 'users_must_be_array');
  if (users.length > 5000) V.fail('IPC_TOO_LARGE', 'users_too_many');
  return dbService.seedUsersIfEmpty(users);
});
handle('database:enableSqlitePrimary', () => dbService.enableSqlitePrimary());
handle('database:migrateFromBackup', (_e, snapshot, options) => {
  V.asObject(snapshot, { name: 'snapshot', required: true, maxKeys: 200 });
  return dbService.migrateFromBackupObject(snapshot, V.asObject(options));
});
handle('database:querySafe', (_e, request) => dbService.querySafe(V.asObject(request, { required: true })));
handle('database:exportSnapshot', () => ({ ok: true, data: dbService.exportSnapshot() }));
handle('database:syncOp', (_e, request) => {
  const req = V.asObject(request, { required: true, maxKeys: 40 });
  const op = V.asString(req.op, { name: 'op', max: 64, required: true, allowEmpty: false });
  return dbService.syncOp({ ...req, op });
});

const cloudOAuthConfig = require('./cloud-oauth-config');

handle('cloudOAuth:getSettings', () => cloudOAuthConfig.getPublicSettings());
handle('cloudOAuth:saveSettings', (_e, payload) =>
  cloudOAuthConfig.saveDeveloperSettings(V.asObject(payload)));
handle('cloudOAuth:restoreDefaults', () => cloudOAuthConfig.restoreDeveloperDefaults());
handle('cloudOAuth:testConnection', () => cloudOAuthConfig.testConnection());

const licenseData = require('./license-data');

handle('license:writeLicenseShard', (_e, licenseId, record) => {
  try {
    const id = pathGuard.safeId(licenseId, 'licenseId');
    const file = licenseData.writeLicenseShard(id, V.asObject(record, { required: true }));
    return { ok: true, path: file };
  } catch (err) {
    return { ok: false, error: err.code || err.message, message: err.message };
  }
});

handle('license:writeActivationBundle', (_e, licenseId, bundle) => {
  try {
    const id = pathGuard.safeId(licenseId, 'licenseId');
    const file = licenseData.writeActivationBundle(id, V.asObject(bundle, { required: true }));
    return { ok: true, path: file };
  } catch (err) {
    return { ok: false, error: err.code || err.message, message: err.message };
  }
});

handle('license:readActivationBundle', (_e, licenseId) => {
  try {
    const id = pathGuard.safeId(licenseId, 'licenseId');
    return licenseData.readActivationBundle(id);
  } catch {
    return null;
  }
});

handle('license:writeCustomPackage', (_e, cp) => {
  try {
    const file = licenseData.writeCustomPackage(V.asObject(cp, { required: true }));
    return { ok: true, path: file };
  } catch (err) {
    return { ok: false, error: err.code || err.message, message: err.message };
  }
});

handle('license:updateLicenseIndex', (_e, index) => {
  try {
    const signed = licenseData.updateLicenseIndex(V.asObject(index, { required: true }));
    return { ok: true, registryVersion: signed.registryVersion };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

handle('license:appendPackageToRegistry', (_e, pkgDef) => {
  try {
    const signed = licenseData.appendPackageToRegistry(V.asObject(pkgDef, { required: true }));
    return { ok: true, count: signed.packages.length };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});
