/**
 * V2-5.10 — Read-only package registry viewer (4 canonical packages + feature gates).
 */
(function (global) {
  'use strict';

  const CANONICAL_IDS = ['01', '02', '03', '04'];

  function loadInlinePackages() {
    const reg = global.FEATURE_REGISTRY || [];
    const caps = global.CAPABILITY_REGISTRY || global.CAP_REGISTRY || [];
    return { features: reg, capabilities: caps };
  }

  async function loadJsonRegistry(kind) {
    const api = typeof global.getCuppingElectron === 'function' ? global.getCuppingElectron() : null;
    if (api?.license?.readRegistry) {
      try {
        return await api.license.readRegistry(kind);
      } catch { /* empty */ }
    }
    return null;
  }

  async function getPackageCatalog() {
    const json = await loadJsonRegistry('package');
    const packages = (json?.packages || []).filter((p) => p && p.visible !== false);
    const canonical = packages.filter((p) => CANONICAL_IDS.includes(p.id));
    const ordered = CANONICAL_IDS.map((id) => canonical.find((p) => p.id === id)).filter(Boolean);
    const rest = packages.filter((p) => !CANONICAL_IDS.includes(p.id));
    return { packages: [...ordered, ...rest], source: json ? 'json' : 'inline', registryVersion: json?.registryVersion };
  }

  function renderSummaryHtml(catalog) {
    catalog = catalog || { packages: [] };
    const rows = (catalog.packages || []).slice(0, 8).map((p) => {
      const feats = (p.featureIds || []).length;
      return `<tr><td>${p.icon || '📦'} ${p.displayNameAr || p.displayName || p.internalName}</td><td dir="ltr">${p.id}</td><td>${feats}</td><td>${p.branches || '—'}</td><td>${p.devices || '—'}</td></tr>`;
    }).join('');
    return `<div style="font-size:13px"><table style="width:100%;border-collapse:collapse;font-size:12px"><thead><tr><th>الباقة</th><th>ID</th><th>ميزات</th><th>فروع</th><th>أجهزة</th></tr></thead><tbody>${rows || '<tr><td colspan="5">—</td></tr>'}</tbody></table></div>`;
  }

  global.PackageRegistryViewer = {
    CANONICAL_IDS,
    loadInlinePackages,
    getPackageCatalog,
    renderSummaryHtml,
  };
})(typeof window !== 'undefined' ? window : globalThis);
