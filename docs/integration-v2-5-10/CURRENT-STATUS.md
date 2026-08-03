# V2-5.10 Current Status (canonical)

**Updated:** 2026-08-03 (Production SoT cutover — early migration by owner decision)  
**Production SoT:** https://github.com/7uzzam/Tadawi-Clinic-Production  
**Archive (dev history only):** https://github.com/7uzzam/Cupping-System-Management  
**Seed tip:** former branch `cursor/v2-5-10-quality-consolidation-c2ea` (clean tip; no source tarballs)

## Verdict

| Question | Answer |
|----------|--------|
| Ready for production | **NO** |
| Production Candidate | **NO** |
| Release Gate | **FAIL** until A–E evidence on Installed Setup EXE from **this** repo |
| Requirements | **0/40 PASS · 40 UNVERIFIED** |
| Category A | **BLOCKED** on live operator proof (Devices A/B) |
| Scenario C (cloud restore) | **FAIL** until retest on discovery-fix EXE |
| Setup / Sync / Owner password | **FAIL** on prior build — fix landed; retest on new Installed EXE |
| Category B | **COMPLETE** (offline engineering) |
| Offline engineering backlog | SetupState + Sync readiness + Owner password persist + Ready CTA cleanup shipped 2026-08-03 — see `SETUP-STATE-SYNC-AUTH-FIX.md` |
| Scores refreshed? | **NO** — Overall baseline **58** (do not inflate without independent re-score after A–E) |
| Repository role | **This repo = Production SoT** · old repo = **archive** (do not delete) |

## Repository roles

| Repo | Role |
|------|------|
| `Tadawi-Clinic-Production` | Production Source of Truth · CI · Releases · UAT evidence home |
| `Cupping-System-Management` | Development / audit **archive** only |

Owner migrated **before** Production Candidate. Live UAT A–E runs here. Migration does **not** skip A–E and does **not** declare PC.

## Canonical reports

1. **`OPERATOR-HANDOFF.md`** — start here (EXE link + remaining steps)  
2. `OPERATOR-LIVE-UAT.md` — Category A protocol (A→E)  
3. `END-OF-PROGRAM-VISION-REPORT.md` / `END-OF-PROGRAM-VISION-REPORT-AR.md`  
4. `CATEGORY-B-COMPLETION-REPORT.md`  
5. `PRODUCTION-CANDIDATE-CHECKLIST.md`  
6. `docs/repository-transition/RELEASE-MIGRATION-PLAN.md`

## Setup EXE delivery

- Channel: **GitHub Releases** prerelease tags `uat-v2-5-10-<run_id>` on **this** repo  
- Current UAT: https://github.com/7uzzam/Tadawi-Clinic-Production/releases/tag/uat-v2-5-10-30817956273  
- SHA-256: `db62fd5e3a989d7e7a5c4e6df737626b321d50520a5216d3cf20a379159bbcb5`  
- Prefer newest UAT prerelease if a newer main publish appears  
- Do **not** rely on large Actions `setup-exe` artifacts  
- Mobile: `MOBILE-QUOTA-AND-EXE-DELIVERY.md`  
- Note: CI job may end red while A–E UNVERIFIED — Release publish still succeeded

## Next (operator only)

1. Download Installed Setup EXE from this repo’s Releases + verify SHA-256  
2. Live UAT A→E on two Windows devices  
3. `npm run v2-5-10:validate-ae` (or `node scripts/windows-uat/validate-ae-evidence-pack.cjs`) exit 0  
4. Then Requirements 40/40 → Release Gate → Production Candidate **only from evidence**
