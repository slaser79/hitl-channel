---
id: SPEC-AW-310f
title: "Empire Brain — Federated Knowledge, Centralized Operations"
status: "Approved"
owner: "agent_workflows"
created_by: "xo"
approved_by: "ceo"
approved_at: 2026-05-30
last_updated: 2026-05-30
products: ["agent_workflows", "hitl-app", "hitl-shin-relay", "ai_homeworkmarker", "voice_chat", "resume-tailor", "shin-web", "hitl-web", "hitl-cli", "hitl-channel", "shin_hedge_fund_trader", "ai_assistant"]
depends_on: [".specs/features/SPEC-AW-310_empire_brain.md", ".specs/features/SPEC-AW-310d_brain_great_ingestion_uplift.md", ".specs/features/SPEC-AW-310e_bounded_curated_brain_distillation.md"]
---

# 1. Executive Summary

The empire brain conflates two kinds of content that need opposite governance, and the conflation actively corrupts the knowledge base.

- **Knowledge** = facts about a product/domain/code (entity, lesson, product, decision pages). Most agents work *on satellites*, so each satellite must own its knowledge **independently** — it is the source of truth for that product.
- **Operational instructions** = rules for *how to operate* (the relationship schema, the curation manual, operating doctrine, mission/role protocols). These must be **centralized** in HQ and inherited by every satellite so the rules don't drift per-repo.

Today the SpecRouter syncs brain *knowledge* across repos in **both directions**. That is the design flaw behind the clobbering family: HQ-held or stale versions of satellite-owned pages overwrite the satellite's canonical work. Confirmed live (2026-05-30):

- **hitl-shin-relay** (the MISSION-316 gold standard) — `entities/firebase_integration.md` was clobbered back to the old HQ stub schema on 2026-04-19 (`7b285f18`); it has been missing its `id`/`domain`/`entity`/`status` and its 6-key `relationships:` block for ~6 weeks, silently breaking `signaling.md`'s `depends_on` edge and the index's `FirebasePlatform` reference.
- **hitl-app** — entity pages were clobbered 2026-04-25, restored via PR #3528, but the **product page remains a 53-line stub** (baseline was a 121-line CRITIC-verified canon) and was never restored.
- The current mitigation is a **band-aid** (`spec_router.py` blanket-skips `brain/entities`) that does not restore the damaged pages, does not cover `products/`/`lessons/`/`decisions/`, and disables legitimate sync rather than modelling ownership.

The principle that fixes this in one stroke: **federate the knowledge, centralize the operations.** Knowledge never crosses repos; only operational instructions propagate down. This SPEC is deliberately **KISS/DRY** — it is mostly a *removal* plus a one-time *restore*, reusing existing SpecRouter and `build_brain_context` infrastructure. No new subsystem, no new schema fields, no database.

# 2. CEO Business Outcomes

- [ ] **BO1 — Independence:** Each satellite owns its brain knowledge; an HQ sync can never overwrite a satellite's canonical entity/lesson/product/decision page again.
- [ ] **BO2 — No drift in the rules:** Operating doctrine + schema live in one canonical HQ place and are inherited by satellites, instead of diverging per-repo copies.
- [ ] **BO3 — The regression is gone, at the root:** The two known clobbered pages are restored, and the mechanism that clobbered them is removed (not skipped).
- [ ] **BO4 — Agents still get empire knowledge:** A satellite agent's dispatch context still includes relevant HQ cross-cutting knowledge — loaned read-only at runtime, never written into the satellite repo.

# 3. User Stories

- [ ] As a **worker agent on a satellite**, I read that satellite's own brain as the source of truth, and no HQ cron silently rewrites it under me.
- [ ] As the **CEO**, I trust that a CRITIC-verified satellite brain page stays as written.
- [ ] As the **XO/Librarian**, I maintain operating doctrine in exactly one canonical HQ location and know every satellite inherits it.

# 4. Technical Implementation

## 4.1 The two-axis model (the whole design)

| Axis | Examples | Owner | Cross-repo flow |
| --- | --- | --- | --- |
| **Knowledge (federated)** | `brain/entities/*`, `brain/lessons/*`, `brain/products/*`, `brain/decisions/*`, and everything else under `brain/` (`index.md`, `log.md`, `meta-learning.md`, `_pending/`, `_journal/`, `_archive/`) | The repo it lives in | **Never synced.** Read locally; HQ cross-cutting knowledge loaned read-only at dispatch. |
| **Operational instructions (centralized)** | the explicit `OPERATIONAL_BRAIN_PATHS` allowlist — `brain/schema.md`, `brain/README.md` (curation manual), and the designated doctrine/protocol docs | **HQ canonical** | **Propagates HQ → satellite** (one-way). The only brain-area content that crosses. |

**The rule is DEFAULT-CLOSED (CRITIC P1-1):** every path under `brain/` is treated as repo-local knowledge and is **never synced across repos** *unless* its path is an exact member of `OPERATIONAL_BRAIN_PATHS`. This is an allowlist, not a denylist — so a page nobody thought to enumerate (e.g. `meta-learning.md`, which today slips past the `spec_router.py:228` pull special-case) is repo-local by default and cannot be clobbered. The denylist framing ("exclude entities/lessons/...") is explicitly rejected because it leaks any unlisted path.

Rule of thumb encoded in code: **instructions flow down (allowlisted); everything else is repo-local and never flows sideways.**

## 4.2 Federate knowledge (a removal, not a feature)

`services/spec_router.py` gets **one** new constant and a single gate applied to both directions:

- **`OPERATIONAL_BRAIN_PATHS`** — a small explicit set of `brain/`-relative paths that ARE operational instructions: `brain/schema.md`, `brain/README.md`, and the designated doctrine docs. This is the *only* brain-area content allowed to cross repos.
- **The gate (default-closed):** for any `brain/`-area path, sync is permitted **iff** the path ∈ `OPERATIONAL_BRAIN_PATHS`; otherwise it is repo-local and skipped. Apply identically to:
  - **Push** (`get_specs_for_product`, the build path that currently band-aids `brain/entities` at `spec_router.py:43`) — replace the band-aid with the allowlist gate.
  - **Pull** (`sync_from_product`, the satellite→HQ pull at `spec_router.py:204`, whose `allowed_folders` includes `brain` and special-cases only a few names at `:228`) — replace the special-case list with the same allowlist gate so no unlisted page (e.g. `meta-learning.md`) is ever pulled.
- **DRY:** one constant + one predicate, reused in both directions. No per-page ownership fields, no frontmatter heuristics, no new module.

## 4.3 Centralize operational instructions

- HQ is the single canonical home for: the relationship `schema.md`, the curation manual `README.md`, and the operating-doctrine/protocol set (the rules every agent inherits). These are listed in `OPERATIONAL_BRAIN_PATHS`.
- SpecRouter pushes that set HQ → satellite one-way (reusing the existing sync path). A satellite never edits these locally; if it needs a change, the change is made in HQ and re-propagated. This removes per-repo doctrine drift (BO2).

**Dependency trace — the HQ Librarian (CRITIC P1-2).** The original both-directions brain sync (SPEC-AW-310 §retired-AC, the `brain_librarian` per-product uplift) is the one consumer this spec changes. Under federation it does **not** stop working — it changes *mode*: the Librarian's HQ synthesis pass reads satellite brains **remote read-only** (via `mount_remote_specs` / `gh api`) to refresh HQ's own cross-cutting pages and thin pointers, and **never writes knowledge files into a satellite**. No HQ→satellite knowledge file write, in either the librarian or the router, survives this spec. This is the only behavioral dependency; no other caller relies on bidirectional brain *file* sync.

## 4.4 Runtime knowledge federation (read-only loan — reuse, don't build)

- Dispatch context for a satellite agent = `[ HQ operational instructions (inherited) ] + [ this satellite's own brain (local canon, read in its worktree) ] + [ matched HQ cross-cutting knowledge, READ-ONLY ]`.
- This is already what `build_brain_context` does (`executors/utils.py:1463` — it injects HQ product + matched HQ entity/lesson pages into the prompt; the satellite's own brain is read locally from its worktree). The only change is to make the read-only loan **explicit and intentional**: HQ knowledge is *injected into the prompt context*, never *written to the satellite repo*. No new retrieval system. (Smarter retrieval / instrumentation / NL Q&A are explicitly deferred — see §6.)

## 4.5 One-time restore (data, with a named vehicle)

Each cross-repo restore is the highest-risk step, so the **mechanism is explicit (CRITIC P1-3)**: a worker dispatch **per satellite** (`dash trigger <issue> -a <agent> -t xo`, rotation per OPERATOR) that opens a **PR in that satellite repo** restoring the page from the satellite's own canonical SHA, gated by the §4.6 lint before merge. HQ's own normalize is a direct `.specs` commit (HQ docs direct-push allowed). One satellite PR each — no cross-repo file copying by HQ:

- **hitl-shin-relay** (satellite PR): restore `.specs/brain/entities/firebase_integration.md` from its own canonical history (`1095931e`).
- **hitl-app** (satellite PR): restore `.specs/brain/products/hitl-app.md` to its 121-line **satellite canon** from the satellite's history. (Note: this is the *satellite's* product page — the full local depth. HQ's `products/hitl-app.md` is the **thin pointer** and is unaffected — see below.)
- **ai_homeworkmarker** (audit-then-restore, satellite PR): its specific clobbered pages are not yet enumerated — first run the same structural audit (entities missing the 6-key block / stubbed by HQ sync), then restore each from its own canonical history. Same vehicle (satellite PR, lint-gated).
- **HQ** (direct commit): ensure HQ's own `entities/firebase_integration.md` (and every HQ entity) **passes the positive lint** — i.e., carries the 6-key `relationships:` block + `id`/`domain`/`entity`/`status`. Do NOT strip `type`/`products`/`sources`/`cross_refs` — those are part of the canonical HQ schema (all 30 HQ entities have them). PHASE-3 only adds the required fields to any HQ page that is genuinely missing them; verified scope is likely small or zero (HQ entities already lint-clean under the corrected positive-only rule).

**Thin product pointer (definition):** an HQ `brain/products/<satellite>.md` page that names the product, its `github_repo`, its one-line purpose, and a link to "the canonical brain lives in the satellite repo" — and deliberately holds **no** duplicated satellite knowledge (target ≤ ~25 lines). It exists so an HQ-side reader/agent knows the product exists and where to find its depth; the depth itself stays federated in the satellite.

## 4.6 Per-repo schema lint (federated enforcement, centralized source)

A small self-contained lint script asserts every `brain/entities/*` page carries the 6-key `relationships:` block + `id`/`domain`/`entity`/`status`. **Detection is positive-only:** a clobbered/un-migrated stub is identified by the **absence** of those required fields, NOT by the presence of `type`/`products`/`sources`/`cross_refs` — those coexist with `relationships` in legitimate canonical HQ pages (verified: all 30 HQ entities carry them). Do NOT forbid those fields (an earlier draft did, which false-positived every canonical page).

**Distribution (CRITIC P1-4)** — the script is *itself an operational instruction* (it encodes the schema contract), so it rides the exact §4.3 centralization mechanism, no special machinery:
- **Authored once in HQ** and added to `OPERATIONAL_BRAIN_PATHS` (e.g. `brain/_tools/lint_brain_schema.py`).
- **Vendored (copied) into each satellite** by the same one-way HQ→satellite push that distributes doctrine. Each repo therefore holds its own committed copy and runs it in **its own** CI — no runtime cross-repo fetch, no shared-action coupling (federation: the gate runs where the knowledge lives, against that repo's own tree).
- DRY is preserved at the *source* (one canonical author in HQ); independence is preserved at *execution* (each repo runs its vendored copy offline). When the contract changes, HQ edits once and the next sync re-vendors every satellite.

# 5. Acceptance Criteria

- [ ] AC1: `spec_router.py` applies a **default-closed** allowlist gate to every `brain/`-area path in **both** push (`get_specs_for_product`) and pull (`sync_from_product`): a path syncs iff it ∈ `OPERATIONAL_BRAIN_PATHS`, else it is repo-local and skipped. The `brain/entities` band-aid (`:43`) and the pull special-case list (`:228`) are removed. Unit test proves a satellite-owned `entities/` page **and** an un-enumerated page (`meta-learning.md`) are both never synced/overwritten.
- [ ] AC2: `OPERATIONAL_BRAIN_PATHS` is the **single** source defining what crosses HQ → satellite (one-way), and contains only schema / curation-manual / doctrine / `_tools` lint paths. Test proves no knowledge path (entities/lessons/products/decisions/index/log/meta-learning/_pending/_journal/_archive) is a member.
- [ ] AC3: Via one satellite PR each (gated by AC4 lint), `hitl-shin-relay/.../entities/firebase_integration.md` and `hitl-app/.../products/hitl-app.md` are restored to their own canonical content; HQ's `entities/firebase_integration.md` is normalized to canonical-only by a direct HQ commit. No HQ→satellite file copy is used to perform the restore.
- [ ] AC4: The entity-schema lint exists in HQ (in `OPERATIONAL_BRAIN_PATHS`), is vendored to each satellite by the §4.3 one-way push, passes on all three repos' brains after restore, and runs in each repo's own CI.
- [ ] AC5: A dispatch to **a named satellite on a named topic** (pinned: hitl-app, an issue mentioning "Gemini") surfaces ≥1 relevant HQ cross-cutting page (`entities/gemini-oauth.md`) in the prompt context, proving runtime federation works without file sync. Verified: no HQ knowledge file is written into the satellite repo during the run.
- [ ] AC6: The original `SPEC-AW-310.md:223` acceptance "SpecRouter sync for brain pages works both directions" is explicitly **retired/superseded** by this spec, with the §4.3 dependency trace (brain_librarian now reads satellites remote read-only) recorded so no consumer is silently broken.

# 6. Out of Scope (explicitly deferred — keep this KISS)

Deferred to a future SPEC-AW-310g (read-loop / query-side efficacy), so this spec stays a clean structural fix:
- Retrieval instrumentation (which pages were injected per dispatch).
- Graph-aware injection (walking typed relationships instead of title matching).
- Recurrence detection ("a lesson existed and the mistake recurred anyway").
- Tier-2 natural-language brain Q&A.

# 7. Risks

- **Centralized doctrine push could itself clobber a satellite-customized doctrine file.** Mitigation: `OPERATIONAL_BRAIN_PATHS` is intentionally tiny and doctrine is HQ-owned by definition; satellites do not customize it (that is the point of centralizing). Any satellite-specific operating note belongs in that satellite's *knowledge*, not in the shared doctrine.
- **Hidden third-party callers** of the removed sync paths. Mitigation: grep callers of `get_specs_for_product` / `pull_missing_specs`; the change narrows what they sync, it does not change their signatures.
- **Restore picks a stale revision.** Mitigation: restore from the satellite's own CRITIC-verified commit, verify the page validates against the new lint before committing.
