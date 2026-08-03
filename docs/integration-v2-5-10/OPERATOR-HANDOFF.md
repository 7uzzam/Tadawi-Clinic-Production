# Operator Handoff — Engineering complete; your turn for live UAT

**Date:** 2026-08-03  
**Production SoT:** https://github.com/7uzzam/Tadawi-Clinic-Production  
**Archive:** https://github.com/7uzzam/Cupping-System-Management  

## What engineering finished (do not wait on more code)

- Category B offline architecture / UX / maintainability closed  
- Backup V1 customer path disabled  
- CenterSetup demoted; BootFlow + Owner Hub own customer paths  
- Conflict UI / ops strip bugs fixed  
- Remaining common modals → `modal-shell`  
- CI publishes Setup EXE to **GitHub Releases** (not large Actions Artifacts)  
- Clean production tree seeded on this repo (no source-release tarballs)

**Production Candidate: NO** until your live A–E evidence on Installed Setup EXE from **this** repo.  
**Scores:** baseline Overall **58** — do not inflate without independent re-score after A–E.

---

## Your Setup EXE (ready now — this repo)

| Field | Value |
|-------|--------|
| Release | https://github.com/7uzzam/Tadawi-Clinic-Production/releases/tag/uat-v2-5-10-30817956273 |
| Asset | `HijamaManagement-Setup-2.0.1.exe` |
| SHA-256 | `db62fd5e3a989d7e7a5c4e6df737626b321d50520a5216d3cf20a379159bbcb5` |
| Commit | `6bbd614` (setup-state fix) |
| Direct download | https://github.com/7uzzam/Tadawi-Clinic-Production/releases/download/uat-v2-5-10-30817956273/HijamaManagement-Setup-2.0.1.exe |

Mobile tip: open Releases → download EXE → send to Windows PCs.  
Details: `MOBILE-QUOTA-AND-EXE-DELIVERY.md` · Quick card: `OPERATOR-AE-QUICK-CARD.md`

> Prefer newest `uat-v2-5-10-<run_id>` prerelease on **this** repo if a newer main publish appears. Do **not** use archive-repo EXE links as SoT proof.

---

## What you do last (Category A)

1. Install Setup EXE on **Device A** and **Device B** (clean profile).  
2. Follow `OPERATOR-LIVE-UAT.md` order: **A → B → C → D → E**.  
3. Fill evidence packs → `npm run v2-5-10:validate-ae` exit 0.  
4. Only then flip Requirements / Release Gate / Production Candidate.  

## Explicitly not your engineering backlog right now

Do **not** ask agents to:
- Declare Production Candidate without A–E  
- Delete the archive repo  
- Inflate quality scores to 90+  
- Rewrite history without an explicit request  
- Delete V1 Electron internals before Scenario C proof  

Vision / status pack:
- `END-OF-PROGRAM-VISION-REPORT-AR.md`
- `CURRENT-STATUS.md`
- `CATEGORY-B-COMPLETION-REPORT.md`
