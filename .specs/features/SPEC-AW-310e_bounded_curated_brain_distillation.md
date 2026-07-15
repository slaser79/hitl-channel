---
id: SPEC-AW-310e
title: "Empire Brain — Bounded-Curated Model + Librarian Distillation (end the page-size-cap war)"
status: "Approved"
owner: "agent_workflows"
created_by: "xo"
approved_by: "ceo"
approved_at: 2026-05-29
last_updated: 2026-05-29
products: ["agent_workflows", "hitl-app", "hitl-shin-relay", "ai_homeworkmarker", "voice_chat", "resume-tailor", "shin-web", "hitl-web", "hitl-cli", "hitl-channel", "shin_hedge_fund_trader", "ai_assistant"]
depends_on: [".specs/features/SPEC-AW-310_empire_brain.md", ".specs/features/SPEC-AW-310d_brain_great_ingestion_uplift.md"]
---

# 1. Executive Summary

SPEC-AW-310d AC13 declared a **fixed per-page cap** (≤20 KB / ≤500 lines) on brain pages, on the assumption — stated in its own rationale — that pages "stay small" via the §4.2 Reference-Don't-Copy rule, with a grandfather allowlist "expected to be empty or near-empty."

That assumption did not hold. The brain librarian is **append-only**: it accumulates every session's lessons into monthly rolling files and grows the curated pages via RCA appends. The result is a standing contradiction — the *doctrine* says the brain is bounded and curated, the *implementation* grows it without bound — which has produced a recurring fire we keep patching at the symptom level:

- **#2700** drain the grandfather list (3 pages over cap), **#2773** `test_brain_page_size_budget` red on main (90 KB page), **#2822** librarian skips malformed pending, **#2855** librarian commits to main ungated → on 2026-05-29 a **+1-line aggregate overshoot left main CI red ~12 h**, cascading red to all 9 open PRs. Four open issues in 30 days, all on the same wound. Each was "fixed" by bumping the aggregate budget (7500→7800→7900), grandfathering another page, or draining a list — never by removing the contradiction.

**CEO decision (2026-05-29): affirm the bounded-curated model.** The brain exists to be *loaded* by agents on every invocation; an unbounded page is cost with no payoff. This spec makes the cap permanently achievable by (a) physically separating the raw append-buffer ("journal") from curated knowledge, (b) having the librarian **distill** aged entries into durable principles rather than append forever, and (c) gating brain commits so an overshoot can never reach `main`. It supersedes 310d's "fixed cap + grandfather + hope" enforcement model with "bounded cap + active distillation + commit gate."

# 2. CEO Business Outcomes

- [ ] **BO1 — Brain stays bounded and cheap-to-load.** Total curated brain stays under a fixed budget that does not ratchet upward over time; every agent invocation pays a bounded, predictable context cost.
- [ ] **BO2 — No more brain-budget outages.** A brain/librarian commit can never leave `main` CI red; an over-budget condition is blocked or auto-distilled before it reaches `main`, and a red `main` is alerted within one cycle.
- [ ] **BO3 — The recurring fire is closed, not patched.** The #2700 / #2773 / #2822 / #2855 family is resolved structurally; the aggregate budget is frozen (no further bumps) and the grandfather allowlist is retired.
- [ ] **BO4 — Institutional memory stays usable.** Distillation preserves durable principles (and retains raw entries in the journal), so bounding the brain improves signal rather than losing knowledge.

# 3. User Stories

- [ ] As an **agent** loading a brain page, I want it bounded and distilled, so the lesson is usable and the context cost is predictable.
- [ ] As the **XO**, I want a brain/librarian commit that would breach budget to be blocked or auto-corrected before `main`, so I never spend a shift on a 12 h silent red-main.
- [ ] As a **developer** running `pytest` locally, I want the brain guards to see the same files CI sees, so a local pass means a CI pass.
- [ ] As the **CEO**, I want the brain's total size to stay flat as the empire matures, so memory cost does not grow unbounded.

# 4. Technical Implementation

## 4.1 Two-class brain model (the core change)

Brain content splits into two explicitly-typed classes:

1. **Curated pages** — `.specs/brain/{lessons,entities,decisions,products}/*.md` (no date suffix). Durable, distilled, **agent-loaded**, **guard-policed** (per-page ≤20 KB / 500 lines + a frozen aggregate budget). The ONLY thing the guards police and agents load.
2. **Journal / append-buffer** — the raw monthly accumulation: today's `*-YYYY-MM.md` monthly rolling files (and any future shard form). Relocated to a **normative** journal directory **`.specs/brain/_journal/`**, **gitignored**, **NOT curated**, **NOT guard-policed**, **NOT loaded wholesale**. It is a buffer the librarian distills *from*, then rotates/archives. (Note: there is no `.partN` overflow mechanism today — the only overflow is the monthly rolling file via `_get_rolling_lesson_path`, `brain.py:1323`.)

**Relocation is real work** — the implementer must update: `_get_rolling_lesson_path` and `_is_rolling_lesson_file` (`brain.py:1307,1323`) to write/recognise under `_journal/`, the `.gitignore:138` glob (`.specs/brain/lessons/*-[0-9][0-9][0-9][0-9]-[0-9][0-9].md` → the `_journal/` path), and any rolling-file reader.

The fix for the 2026-05-29 incident's local-vs-CI divergence (the U1 "near-miss": local pytest failed on gitignored rolling files CI never sees) falls out of this: the guards police only Class 1, and explicitly **exclude gitignored/untracked files and the journal class** — so a local run equals a CI run. (`BrainLibrarian._check_page_size_budget` already filters rolling files via `_is_rolling_lesson_file`, `brain.py:1887` — the real fix target is the two raw-glob pytest walkers; see AC2.)

## 4.2 Librarian distills, not appends — deterministic default (resolves former Open Q1)

The distillation engine is **deterministic and rule-based**, NOT an LLM/agent invocation — this preserves SPEC-AW-310d r3's CEO-locked architecture ("the Librarian is a native_call pipeline, not an agent role"; `run_brain_librarian_maintenance()` stays a pure Python pipeline) and keeps the commit-gate (§4.3) mechanically CI-assertable.

**Committable default algorithm** (the only thing the commit-gate and AC3 test depend on):
- New session knowledge lands in the **journal** first (Class 2), never directly on a curated page.
- When a curated page would exceed cap, the librarian **preserves the newest N `*Added:`-dated sections in full** and **collapses each older dated section to a one-line principle stub + a pointer to its journal location** (`see _journal/<file>#<anchor>`). The raw section is retained verbatim in the journal for provenance — nothing is destroyed.
- The transform is pure string/section manipulation on dated sections (`ADDED_DATE_RE` already exists, `brain.py`); given the same page + N it produces byte-identical output → the AC3 regression test asserts pass/fail mechanically.

**Optional LLM enrichment is a SEPARATE, non-CI-gating pass:** a later enhancement MAY replace the one-line stub with a higher-quality summarized principle, but it runs outside the commit-gate path and its absence never blocks a commit or fails CI. BO4 ("preserves durable principles") is met by the deterministic default (recent lessons stay full; aged ones become a principle stub + retrievable journal pointer); enrichment improves the stub, it is not required for it.

## 4.3 Commit gating (closes #2855)

`run_brain_librarian_maintenance()` and any direct brain-commit path (`_persist_brain_and_notify` → `git push origin HEAD:refs/heads/main`, `native_calls.py:715,728` — verified to push ungated today) MUST, before committing to `main`:
1. Run the page-size **and aggregate** guards against the **committed tree it is about to produce**.
   - **Prerequisite (extend the existing SSOT):** `src/agent_workflows/utils/brain_size.py` **already exists** as the page-size single-source-of-truth (`PageSizeRow`, `iter_brain_pages`, `measure_page`, limits — already imported by `native_calls.py`, `brain_status.py`, `brain_split.py`). Only the **aggregate** budget is missing: it + the total-lines computation live ONLY in `tests/test_empire_brain_phase2.py:27,89-109` (`MAX_PHASE2_AGGREGATE_LINES`, not importable). This spec **ADDS the aggregate constant + tree-measurement to the existing `brain_size.py`, reusing `iter_brain_pages`/`measure_page`**, consumed by BOTH the CI pytest AND the pre-push gate — and applies `git ls-files` tracked-only filtering to the aggregate walk (AC2). Do NOT create a second helper. The per-page guard also already exists and is reusable (`BrainLibrarian._check_page_size_budget`, ~`brain.py:1873`).
2. If over budget: auto-distill (§4.2) to bring it under, OR refuse to commit (best-effort, log + XO flood-alert, reusing the existing `>500-ingest` notifier pattern, `native_calls.py:652,762`) — never commit a known-red tree.
3. **Red-main watcher (new):** a watcher polls the GitHub Actions API for the latest `push`-event workflow conclusion on `main`; on `failure` it alerts XO (empire-mgmt / inbox) within **≤1 CoS daemon wake cycle (≤15 min)**. This is a NEW detection path — the existing `_maybe_notify_brain_size_violations` (`test_brain_size_alerts.py`) watches page *size*, not CI *run status*; the spec states whether to extend that notifier or add a sibling.

## 4.4 Retirements

- **Grandfather allowlist** (`tests/fixtures/brain_page_size_grandfathered.txt`, currently 3 entries — all gitignored rolling files) — retired once distillation keeps curated pages under cap and the journal is out of guard scope. The allowlist mechanism is removed or marked deprecated-empty.
- **Aggregate-budget ratchet** — `MAX_PHASE2_AGGREGATE_LINES` is **frozen** (current 7900 from PR #2854 is the last bump); distillation keeps the total under it. No future bumps; an overshoot triggers distillation, not a cap raise. The frozen constant moves to `utils/brain_size.py` (§4.3) with a code comment forbidding further bumps and pointing here.

# 5. Acceptance Criteria

- [ ] **AC1** Two-class model documented in **this spec (310e) + the brain README**, with a **one-line pointer stub added to the approved SPEC-AW-310d AC13** (not a rewrite of 310d's body). The journal/append-buffer is physically separated under the normative `.specs/brain/_journal/`, gitignored, and out of guard scope.
- [ ] **AC2** The two raw-glob **pytest walkers** — `tests/test_empire_brain_phase2.py::_brain_pages` (lines 56-64) and `tests/test_brain_page_size_budget.py` — are changed to police only tracked Class-1 curated pages (filter via `git ls-files` / tracked-only), excluding gitignored/untracked + journal files. (`BrainLibrarian._check_page_size_budget` already filters rolling files, `brain.py:1887` — no change there.) Verified by: a local `pytest` run with journal files present produces the same result as a clean CI checkout.
- [ ] **AC3** Deterministic distillation (§4.2) implemented in the librarian pipeline: an over-cap curated page is reduced by preserving the newest N dated sections in full and collapsing older dated sections to a one-line principle stub + journal pointer (raw retained in journal). A regression test feeds a synthetic over-cap page and asserts the **byte-deterministic** distilled output is under cap — no LLM in the gated path.
- [ ] **AC4** The aggregate budget constant + tree-line-measurement are **added to the EXISTING `src/agent_workflows/utils/brain_size.py`** (reusing its `iter_brain_pages`/`measure_page`; do not create a duplicate module), tracked-only-filtered (AC2), and consumed by both the CI pytest and the pre-push gate. The librarian/brain commit path runs the page-size **and** aggregate guards against the committed tree pre-push and auto-distills/refuses on breach (closes #2855 — the ungated push is confirmed at `native_calls.py:715,728`); a regression test simulates an over-budget librarian output and asserts no red-main commit is produced.
- [ ] **AC5** A red-`main` `push`-CI conclusion is detected via the GitHub Actions API and alerts XO within **≤1 CoS daemon wake cycle (≤15 min)**; the spec/PR states whether it extends `_maybe_notify_brain_size_violations` or is a sibling watcher.
- [ ] **AC6** Grandfather allowlist retired (empty + mechanism removed/deprecated); `MAX_PHASE2_AGGREGATE_LINES` frozen in `utils/brain_size.py` with a code comment forbidding further bumps and pointing here.
- [ ] **AC7** Total curated brain measured under the frozen aggregate budget at ship time, and **#2700 / #2773 / #2855** are closed as resolved-by-310e (not deferred). (**#2822** — malformed-pending robustness — is NOT claimed here; it is unrelated to the bounded-curated model and stays on its own tracking issue. See §6.)

# 6. What this spec does NOT do

- It does not change the per-page cap value (≤20 KB / 500 lines stays) or the agent-load-time context budget (PR #2154 Layer 2).
- It does not delete historical knowledge — distillation retains raw entries in the journal; only the *curated* surface is bounded.
- It does not re-run the 310d structural uplift; it changes the *enforcement + growth* model only.
- **It does not fix #2822** (librarian silently skips ~30 malformed `_pending/*` files). That is a pending-parser robustness bug, unrelated to the bounded-curated growth model; it stays on its own tracking issue and is explicitly NOT claimed as resolved here (avoids a phantom-resolution).
- It does not introduce an LLM/agent into the librarian's gated path — distillation's committable default is deterministic (§4.2); LLM enrichment, if ever added, is a separate non-gating pass.

# 7. Open questions for CRITIC / CEO review

- ~~Distillation engine~~ — **RESOLVED in §4.2**: deterministic rule-based default (preserve newest N dated sections, collapse older → principle stub + journal pointer); optional LLM enrichment is non-gating.
- Journal retention: how long are gitignored `_journal/` files kept locally before archive/prune (ties to the disk-janitor #2784)?
- Per-product vs. global aggregate budget: is one frozen global number right, or per-product sub-budgets?
- Distillation `N` (newest-sections-kept): fixed constant, or per-page-cap-derived?
- (P2-C, optional) Converge the three page-walkers (`test_brain_page_size_budget`, `test_empire_brain_phase2::_brain_pages`, and `brain_size.iter_brain_pages`) onto the single `brain_size.iter_brain_pages` so there is one tracked-only walk.

# 8. References

- **Supersedes the enforcement model of SPEC-AW-310d §6 AC13**: write-time (kept) and CI-time (re-targeted to tracked-only walkers, AC2) checkpoints, plus the new pre-push commit-gate (§4.3). **310d AC13's CRITIC-time per-phase "sample largest 3 pages ≤20 KB" check is RETAINED** as independent defense-in-depth — the commit-gate does not replace it. The grandfather-allowlist enforcement element of AC13 is retired (§4.4). AC1 amends 310d via a one-line pointer stub, not a body rewrite.
- Resolves: #2700, #2773, #2855. (#2822 explicitly out of scope — see §6.)
- Source incident: 2026-05-29 XO session (main red ~12 h on a +1-line aggregate overshoot; PR #2854 relief-valve bump). See `.specs/active_sprint.md` 2026-05-29 entries + `.specs/brain/_pending/3ebe1f9b-*.md`.

# 9. Revision log

- **r2 (2026-05-29):** addressed CRITIC spec review (BLOCKED → revised). P0-1 resolved (deterministic distillation default in §4.2, LLM non-gating); P1-1 (aggregate-guard extraction to `utils/brain_size.py`, §4.3/AC4); P1-2 (#2822 de-scoped, §6/AC7); P1-3 (AC5 bounded to ≤15 min + GitHub-Actions-API detection); P2-1 (`.partN` removed); P2-2 (normative `_journal/` path + helpers enumerated); P2-3 (AC2 targets the two pytest walkers); P2-4 (310d amended via stub, CRITIC-time sampling retained). Report: `.specs/reports/SPEC-AW-310e_spec_review.md`.
- **r3 (2026-05-29):** CRITIC re-review **CLEARS → APPROVED_WITH_CHANGES (0 P0, 0 P1)**. Applied P2-A (`brain_size.py` already exists — AC4/§4.3 reworded to ADD the aggregate budget to the existing SSOT reusing `iter_brain_pages`/`measure_page`, not create a new module) + P2-B (cosmetic line-refs: `.gitignore:138`; ungated push confirmed `native_calls.py:715,728`). P2-C (converge the 3 walkers) logged as optional in §7. Ready for CEO sign-off.
