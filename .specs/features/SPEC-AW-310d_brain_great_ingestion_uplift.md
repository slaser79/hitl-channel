---
id: SPEC-AW-310d
title: "Empire Brain — Great Ingestion Uplift (Propagate the hitl-shin-relay Playbook Empire-Wide)"
status: "Approved"
owner: "agent_workflows"
created_by: "xo"
approved_by: "ceo"
approved_at: 2026-04-24
last_updated: 2026-04-24
products: ["agent_workflows", "hitl-app", "hitl-shin-relay", "ai_homeworkmarker", "voice_chat", "resume-tailor", "shin-web", "hitl-web", "hitl-cli", "hitl-channel", "shin_hedge_fund_trader", "ai_assistant"]
depends_on: [".specs/features/SPEC-AW-310_empire_brain.md", ".specs/features/SPEC-AW-310b_brain_content_rewrite.md"]
---

# 1. Executive Summary

SPEC-AW-310 (2026-04-13) shipped the scaffold. SPEC-AW-310b (2026-04-17) remediated content — filled the scaffold with cited truth per satellite. MISSION-2026-316 (2026-04-19, hitl-shin-relay only) went further and produced the **gold standard**: a four-domain Canonical Domain Model (CDM), a typed relationships schema on every entity, a source manifest proving 100% ingestion, and a curation manual README defining a Two-Tier Worker/Librarian protocol.

That playbook exists in exactly one of 12 brains. This spec propagates it to the other eleven, starting with agent_workflows HQ.

The result is a brain that is navigable as a graph (not a flat list), auditable for completeness (SOURCE_MANIFEST), self-documenting for new agents (curation manual README), and structurally identical across the empire so a CoS or pCoS walking into any satellite sees the same shape.

# 2. CEO Business Outcomes

- [ ] **Structural parity across the empire** — every active satellite has the same brain shape (curation manual, CDM entity, typed relationships, SOURCE_MANIFEST). A CoS opening any satellite's `.specs/brain/` recognises it in five seconds.
- [ ] **HQ is the authority, not a warehouse** — `agent_workflows/.specs/brain/` has the canonical curation manual and relationships schema that all satellites inherit from.
- [ ] **Graph-navigable knowledge** — any agent can traverse `depends_on` / `governs` / `triggers` from one entity to another without keyword guessing. Relationship traversal is explicit, not emergent.
- [ ] **Provable ingestion** — for each product, 100% of files listed in `SOURCE_MANIFEST.md` are synthesised into the brain. CRITIC samples the manifest and verifies.
- [ ] **Priority satellites first** — hitl-app and ai_homeworkmarker, the most-active and most-agent-dispatched products, hit gold standard within 24 hours of HQ sign-off.

# 3. User Stories

- As a **pCoS** opening a fresh satellite session, I want the same curation manual README and CDM entity everywhere so I can immediately locate the four domains and the relationships schema without re-learning each repo's brain shape.
- As a **worker agent** writing knowledge to `_pending/`, I want one schema (typed relationships + domain tag) so my output is mergeable across satellites.
- As **CRITIC** verifying a brain-rewrite mission, I want a SOURCE_MANIFEST I can grep for `[ ]` to audit completeness, not a vibes-based quality check.
- As the **CEO** asking "where is everything we know about Firebase", I want to traverse `governs:` and `implements:` across all satellites and get a deterministic subgraph.
- As the **XO** running the HQ Librarian pass, I want every entity to declare its domain so cross-product synthesis is a domain-by-domain merge, not a freeform search.

# 4. The Canonical Brain Model

All in-scope products adopt this structure verbatim. Deviations require a spec amendment.

## 4.1 Directory Shape

```
.specs/brain/
├── README.md          # Curation manual (MANDATORY, see §4.2)
├── index.md           # CDM projection — pages grouped by domain
├── schema.md          # (HQ only) relationships schema reference
├── entities/
│   ├── domain_model.md          # CDM entity (MANDATORY)
│   ├── <noun>.md                # One file per canonical concept
│   └── …
├── lessons/           # Curated, domain-tagged, deduplicated
├── decisions/         # ADRs
├── products/          # HQ = per-satellite pointers; satellite = its own product page
└── _pending/
    ├── SOURCE_MANIFEST.md       # Ingestion completeness checklist (MANDATORY)
    ├── <task_id>.md             # Raw discovery drops from workers
    └── archive/                 # Processed pending files (provenance)
```

## 4.2 Curation Manual README (MANDATORY sections)

Every satellite's `.specs/brain/README.md` ports the hitl-shin-relay template (3.5 KB) and includes the five section headings below. For AC1 pytest enforcement, the exact grep regex is:

```
grep -E "Two-Tier|4-Domain|Librarian'?s Playbook|Clean Brain|How Agents Query" README.md
```

and must return ≥5 matches.

1. **The Two-Tier Protocol** — Worker raw discovery (`_pending/<task_id>.md`) versus Librarian canonical synthesis. Low-friction write, high-standard merge.
2. **The 4-Domain Architecture** — defined per product (e.g., hitl-shin-relay uses CORE RELAY / APP SERVICES / QUALITY & TRUST / PROVISIONING & OPS; agent_workflows uses ORCHESTRATION / APP SERVICES / QUALITY & TRUST / PROVISIONING & OPS).
3. **The Librarian's Playbook (SOP)** — Ingest → Deduplicate & Merge → Map Relationships → Index & Archive. Four numbered steps, no more.
4. **Clean Brain Standards** — Atomic entities, Reference-Don't-Copy (`implements: [file paths]`, not pasted code).
5. **How Agents Query the Brain** — Browse index → Semantic grep → Deep view → Relationship traversal. No DB, no vector store, just filesystem + LLM reasoning.

HQ's README supersedes the 808-byte scaffold currently shared across satellites.

## 4.3 Canonical Domain Model (CDM) Entity

Each product MUST ship `entities/domain_model.md` with:

```yaml
---
id: domain_model
title: "Canonical Domain Model"
domain: "THE CORE <PRODUCT>"     # The agent-facing domain
entity: CanonicalDomainModel
status: canonical
last_updated: YYYY-MM-DD
relationships:
  defines: [core_domain, app_services_domain, quality_trust_domain, provisioning_ops_domain]
  implements: [.specs/brain/index.md]
  depends_on: []
  governs: [brain_navigation]
  triggers: []
  supersedes: []
---
```

The four domains per product are declared explicitly. `index.md` is then a projection of the CDM — one table per domain, entities listed under the domain they belong to.

**Naming convention — `defines:` ids vs `domain:` labels.** The four ids in `defines:` are snake_case concept identifiers (e.g., `core_relay_domain`, `app_services_domain`, `quality_trust_domain`, `provisioning_ops_domain`). The `domain:` field on every entity page uses the matching UPPERCASE label (`"CORE RELAY"`, `"APP SERVICES"`, `"QUALITY & TRUST"`, `"PROVISIONING & OPS"`). The CDM projection in `index.md` groups entity pages under the UPPERCASE labels. The mapping between the two is `snake_lower_case(label) == id_prefix`.

## 4.4 Relationships Schema (Typed)

Every entity page uses this canonical frontmatter:

```yaml
---
id: <snake_case_id>
title: "<Human title>"
domain: "<DOMAIN NAME>"
entity: <PascalCaseEntity>
status: canonical | draft | deprecated
last_updated: YYYY-MM-DD
relationships:
  defines:      [<concept_id>, …]    # Concepts this page is the canonical definition of
  implements:   [<path/to/file.py>]  # Code files that realise this concept (Reference-Don't-Copy)
  depends_on:   [<other_entity_id>]  # Prerequisite entities the reader should consult first
  governs:      [<behavior_id>]      # Behaviors/flows this entity sets rules for
  triggers:     [<event_id>]         # Events or flows this entity fires
  supersedes:   [<deprecated_id>]    # Prior canonical entries this replaces
---
```

The six relation types are canon. New types require a spec amendment. Entities still in the legacy `cross_refs: [ … ]` flat-list shape are treated as **non-canonical** and must be migrated.

**Status lifecycle.** Every entity page carries a `status:` field:
- `canonical` — uplifted to the typed relationships schema; counts toward AC3 sampling. This is the terminal state for live entities.
- `draft` — implicit pre-uplift state. Every legacy page starts here (with a flat `cross_refs:` block or no frontmatter at all) and transitions to `canonical` **within the same phase that touches it**. `draft` never persists across phase boundaries — if a page is in a phase's scope, it exits that phase as `canonical` (or `deprecated`). Excluded from AC3 sampling while in this state.
- `deprecated` — superseded or retired; carries `relationships.supersedes: [<new_entity_id>]` pointing at the replacement. Excluded from AC3 and AC4.

Any entity page touched by PHASE-0b through PHASE-11 MUST transition to `status: canonical` or `status: deprecated` by the end of that phase.

## 4.5 SOURCE_MANIFEST.md

Lives at `_pending/SOURCE_MANIFEST.md` per product. Grouped by the four domains. Every file considered "canon for this product" appears once as a checkbox. Ticked when synthesised into an entity, lesson, or decision page. CRITIC audits by grepping `[ ]` — any unchecked item after CRITIC dispatch is a P1 defect.

Sources to list (at minimum):
- `README.md`, `CLAUDE.md` / `GEMINI.md` / `AGENTS.md`
- `.specs/00_overview.md`, `.specs/01_*`, `.specs/02_roadmap.md`
- Active `.specs/features/*.md`
- `.specs/knowledge/*.md`
- `pubspec.yaml` / `pyproject.toml` / `package.json` / `flake.nix`
- Last 60 days of `.specs/reports/*_critic_report.md`
- `.specs/lessons_learned.md` (if satellite has its own)
- `docs/*.md` (where the product keeps an operational docs tree — e.g., hitl-shin-relay `docs/DEPLOYMENT_MASTER_GUIDE.md`)
- `config/*.yaml` (where the product ships declarative config relevant to the brain — e.g., agent_workflows `config/empire.yaml`, `config/budget_rules.yaml`)

Each product MAY add product-specific additions (e.g., Flutter products add `.fvmrc`, `melos.yaml`; Next.js products add `next.config.js`). The Librarian documents these additions in a `## Product-Specific Additions` section at the bottom of `SOURCE_MANIFEST.md`.

## 4.6 Index.md as CDM Projection

Not a flat alphabetical list — one section per domain, each section is a table of `Page | Entity | Key Relationships | Summary`. Lessons and Decisions sit in a trailing "Recent Lessons & Decisions" table. See `hitl-shin-relay/.specs/brain/index.md` for the exact template.

# 5. Delivery Phases

Phase ordering is strict. PHASE-0 ships HQ gold-standard; then satellites uplift serially with hitl-app and ai_homeworkmarker prioritised per CEO directive (2026-04-24).

## PHASE-0a — Shared Artifacts (XO, ~half-day)

Deliverables:
1. `agent_workflows/.specs/brain/README.md` — port the hitl-shin-relay curation manual; update 4-domain definition for HQ (ORCHESTRATION / APP SERVICES / QUALITY & TRUST / PROVISIONING & OPS).
2. `agent_workflows/.specs/brain/schema.md` — canonical relationships schema reference (HQ-only, cited by satellite READMEs).
3. **Extend the existing `brain_librarian` playbook** (`playbooks/workflows/brain_librarian.yaml` + `run_brain_librarian_maintenance()` in `src/agent_workflows/playbooks/native_calls.py`) with a new uplift pass AND reinstate the staggered per-product cadence from the legacy `docs_update*.yaml` playbooks (deleted 2026-04-14 commit `3b7899d94` "BRAIN-P3/PHASE-7: Brain Librarian repositioning"). The Librarian is **not a new agent role** — it is a native_call pipeline that already exists. This deliverable does six things:

   **3a. New native_call:** add `run_brain_uplift_pass(product_id: str) -> dict` to `src/agent_workflows/playbooks/native_calls.py`. Performs the Librarian's Playbook SOP (§4.2 step 3: Ingest → Deduplicate & Merge → Map Relationships → Index & Archive) for a single product's brain. Reuses the existing `BrainLibrarian` class without modification. Returns a structured result (pages canonicalised, relationships added, deprecated flagged, SOURCE_MANIFEST ticks, lint issues raised).

   **3b. New playbook input `uplift_product_id`:** when present, the `brain_librarian` playbook step list runs `run_brain_uplift_pass(uplift_product_id)` after the existing maintenance cycle. When absent (the current behaviour), only the nightly HQ maintenance runs. The nightly `0 20 * * *` HQ pass is untouched — it runs without the new input and behaves exactly as it does today.

   **3c. Reinstate the staggered tri-weekly per-product cadence** by adding cron triggers to `brain_librarian.yaml` — one cron slot per active satellite, repointed from the legacy `docs_update` schedule CEO referenced (2026-04-24 session). Initial slot set shipped in PHASE-0a:

   | Trigger | Schedule (UTC) | `uplift_product_id` | Origin |
   |---|---|---|---|
   | nightly maintenance (existing) | `0 20 * * *` | (none — HQ index/lint/rotate) | `brain_librarian.yaml` current |
   | uplift-agent_workflows | `0 17 * * 1,3,5` (Mon/Wed/Fri) | `agent_workflows` | legacy `docs_update.yaml` |
   | uplift-hitl-app | `0 17 * * 2,4,6` (Tue/Thu/Sat) | `hitl-app` | legacy `docs_update_hitl_app.yaml` |
   | uplift-ai_homeworkmarker | `30 17 * * 1,3,5` (Mon/Wed/Fri) | `ai_homeworkmarker` | legacy `docs_update_ai_homeworkmarker.yaml` |

   The three legacy schedules are restored verbatim — proven cadence, no bike-shedding required. Three products chosen because these are the three the legacy docs_update covered AND the three prioritised first by CEO (agent_workflows HQ, hitl-app, ai_homeworkmarker). **All cron slots added by this deliverable (both the three initial slots in the table above and the per-phase slots listed in 3d) ship with `enabled: false`.** Each slot is flipped to `enabled: true` in a trailing commit on the phase's branch after that phase's CRITIC PASS — see phase exit criteria in PHASE-0b, PHASE-1, PHASE-2, and the generic addendum on PHASES 3–11.

   **3d. Subsequent per-satellite slots are added per-phase.** PHASE-3 voice_chat adds its own cron slot to `brain_librarian.yaml` as part of PHASE-3's exit criteria; PHASE-4 resume-tailor adds its slot; etc. Each satellite's uplift cron ships `enabled: false` when the slot is first written and is flipped to `enabled: true` only after that satellite's initial Great Ingestion CRITIC passes — so the cron never runs against a half-uplifted brain. Recommended subsequent slots (XO picks the exact slot during the phase to avoid cadence collisions):

   - voice_chat → `30 17 * * 2,4,6` (Tue/Thu/Sat)
   - resume-tailor → `0 18 * * 1,3,5`
   - shin-web → `0 18 * * 2,4,6`
   - hitl-web → `30 18 * * 1,3,5`
   - hitl-cli → `30 18 * * 2,4,6`
   - hitl-channel → `0 19 * * 1,3,5`
   - shin_hedge_fund_trader → `0 19 * * 2,4,6`
   - ai_assistant → `30 19 * * 1,3,5`
   - hitl-shin-relay → `30 19 * * 2,4,6` (added at PHASE-FINAL since 316 already shipped its content)

   The window `17:00–19:30 UTC` sits clear of the 08:00–16:00 UTC band used by `daily_roadmap_review.yaml` and clear of the 20:00 UTC HQ nightly maintenance.

   **3e. Initial Great Ingestion uses the same code path.** PHASE-0b through PHASE-11's initial uplift runs invoke the same native_call via `./scripts/dash playbook run brain_librarian --input uplift_product_id=<product>` (CLI trigger). Initial run and nightly cron are identical — no divergence, no parallel code path. First-time-vs-ongoing difference is only whether the `_pending/SOURCE_MANIFEST.md` seed exists yet; the uplift function handles both cases.

   **3f. No agent dispatch, no new SKILL.md, no `-R` role flag.** The legacy docs_update playbooks opened a `[Scheduled] Documentation Update - <date>` GitHub issue and dispatched a worker agent — this spec's Librarian extension does not. The librarian is a deterministic native_call pipeline; LLM-heavy curation work (writing entity prose, resolving ambiguous deduplication) remains human- or agent-driven via the per-phase dispatches in §5.
4. `tests/test_brain_canonical_format.py` — pytest suite with **four** checks:
   - `test_curation_manual_has_required_sections(product)` — grep for the five mandatory headings (§4.2) using the regex `Two-Tier|4-Domain|Librarian'?s Playbook|Clean Brain|How Agents Query`; assert ≥5 matches.
   - `test_cdm_entity_exists(product)` — assert `entities/domain_model.md` present and frontmatter valid (declares 4 domain ids in `defines:`, has `governs: [brain_navigation]`).
   - `test_entity_relationships_canonical(product)` — sample `min(10, canonical_entity_count)` entity pages at random (seeded deterministically with the mission id, see §6 sampling rule); ≥90% must have a valid `relationships:` block with ≥1 of the six canonical keys. Sample scope is restricted to entities with `status: canonical` (pages with `status: draft` or `status: deprecated` are excluded per §4.4 lifecycle).
   - `test_implements_paths_exist(product)` — for every entity page, resolve every string in `relationships.implements:` relative to the product repo root and assert `os.path.exists`. Fabricated file paths fail the check. Sample 10 relationship targets per product at random when a full pass is too expensive.
5. `tests/test_brain_page_size_budget.py` **(new in r5, scope tightened in r6)** — pytest suite enforcing AC13 page-size caps. Walks only `.specs/brain/{entities,lessons,decisions,products}/**/*.md` in every satellite (strictly matching AC13's declared scope). **Out of scope for AC13 and the walker:** `README.md`, `index.md`, `schema.md`, `log.md` (auto-rotated by `BrainLibrarian.rotate_log()`; currently ~68 KB on HQ and is machine-generated audit trail, not curated knowledge), and all `_pending/*` (worker drops awaiting Librarian synthesis). Walker asserts ≤20,480 bytes AND ≤500 lines per in-scope file. On failure, emits `<path> is <size> bytes (<lines> lines) — exceeds 20 KB / 500 line cap from SPEC-AW-310d AC13`. Pre-existing over-budget pages listed in a new `tests/fixtures/brain_page_size_grandfathered.txt` allowlist are skipped with a warning. Allowlist entries are deleted as each offending file is split.
6. Extend `BrainLibrarian.lint()` (existing method in `src/agent_workflows/utils/brain.py`) with a `_check_page_size_budget()` sub-check that returns a blocking error for any page >20 KB or >500 lines. Also gate `run_brain_uplift_pass(product_id)` (PHASE-0a deliverable 3a) on the lint — if any page exceeds the cap, the uplift refuses to drain `_pending/` for that product until the offender is split or allowlisted.

Exit criteria: tests exist (red), HQ README + schema.md + extended `brain_librarian` playbook + `run_brain_uplift_pass()` native_call + `BrainLibrarian._check_page_size_budget()` + `tests/test_brain_page_size_budget.py` + grandfathered allowlist committed to main via PR (XO opens the PR against main, self-merges after CI green; SPEC-AW-310b Phase 0b precedent). "Direct PR" means "open PR, self-merge" — not bypassing branch protection.

## PHASE-0b — HQ Gold-Standard Uplift (agents leveraged, 1 day)

Mirrors MISSION-2026-316's parallel stream pattern with one deliberate divergence: **Stream D uses gemini instead of jules** because jules is remote-VM-only (CLAUDE.md 2026-04-11 "Jules Constraints Update") and cannot perform local brain curation on the HQ filesystem. Five workers dispatched in parallel, Librarian synthesis after.

**PHASE-0b uplifts every existing HQ entity page.** No HQ entity is deferred to PHASE-FINAL. The Streams A–D target list enumerates **every entity currently in `agent_workflows/.specs/brain/entities/`** (14 pages: `bridge-providers`, `codex-patterns`, `drift-database`, `firebase_integration`, `flutter-ci`, `flutter_app`, `gemini-oauth`, `jules-remote-vm`, `marking_engine`, `melos-monorepo`, `paywall_system`, `riverpod-state`, `sqlite-wal`, `tailscale-funnel`) plus the new pages created by the streams. Flutter- and hitl-app-specific entities (`bridge-providers`, `drift-database`, `flutter-ci`, `flutter_app`, `marking_engine`, `melos-monorepo`, `paywall_system`, `riverpod-state`) move to Stream C or are `status: deprecated` at HQ with `supersedes:` pointers to their satellite-owned versions (decided per-entity by the Librarian during synthesis).

- **Stream A (gemini, ORCHESTRATION, Agent-Centric):** uplift `gemini-oauth.md`, `codex-patterns.md`, `jules-remote-vm.md` entities to canonical schema. Create `agent_dispatch.md`, `task_scheduler.md`, `mission_manifest.md` if missing. Tag domain = ORCHESTRATION.
- **Stream B (codex, APP SERVICES, User-Centric):** uplift/create `mission_control_dashboard.md`, `hitl_routing.md`, `empire_mailbox.md`, `brain_query_ui.md`. Tag domain = APP SERVICES.
- **Stream C (codex, QUALITY & TRUST, System-Centric):** uplift/create `critic_role.md`, `e2e_sandbox.md`, `lessons_learned.md`, `manifest_validation.md`. Uplift `sqlite-wal.md` to canonical schema. Also uplift or demote-to-deprecated the hitl-app cross-cutting pages (`bridge-providers`, `drift-database`, `flutter-ci`, `flutter_app`, `melos-monorepo`, `paywall_system`, `riverpod-state`, `marking_engine`) — Librarian decides per-entity whether HQ keeps a canonical summary or defers to the satellite. Tag domain = QUALITY & TRUST where retained.
- **Stream D (gemini, PROVISIONING & OPS, Dev-Centric):** uplift/create `worker_fleet.md`, `server_watchdog.md`, `spec_router.md`, `tailscale-funnel.md` (already exists, uplift to canonical), `github_integration.md`, `firebase_integration.md` (uplift to canonical — HQ canonical source of cross-product Firebase truth per AC11 resolution). Tag domain = PROVISIONING & OPS.
- **Librarian (playbook run, not agent dispatch):** after A–D merge, invoke `./scripts/dash playbook run brain_librarian --input uplift_product_id=agent_workflows`. The extended `run_brain_uplift_pass()` native_call (PHASE-0a deliverable #3) writes `entities/domain_model.md` (HQ CDM), regenerates `index.md` as CDM projection, populates `_pending/SOURCE_MANIFEST.md` for agent_workflows (README.md + CLAUDE.md + all `docs/*.md` + `.specs/00_*` + active features + lessons_learned + `config/empire.yaml` + `config/budget_rules.yaml`), and drains 5 stale pending files from MISSION-316/task completions into archive. The existing `BrainLibrarian` class does the filesystem work; the new uplift-pass function orchestrates the sequence.
- **CRITIC:** independent verification against §6 acceptance bars. Dispatch `./scripts/dash trigger <issue#> -a critic -t xo`.

Exit criteria: all §6 HQ acceptance bars pass; the `uplift-agent_workflows` cron slot (§5 PHASE-0a deliverable 3c) gets flipped to `enabled: true` in a trailing follow-up commit after CRITIC PASS; CEO sign-off.

## PHASE-1 — hitl-app (pCoS serial, CEO priority, ~1 day)

Same recipe, adjusted to hitl-app's existing 9 entities. The CoS already rewrote content truth in SPEC-AW-310b PHASE-1; this phase is **structural uplift only** — add CDM entity, rewrite index.md as CDM projection, uplift 9 entities to canonical relationships schema, write SOURCE_MANIFEST.md, port README curation manual, HQ pointer summary regenerated.

Domains for hitl-app: MOBILE UX (Agent-Centric → user's Flutter surface), STATE & DATA (Riverpod, Drift, bridge-providers), QUALITY & TRUST (CI, melos, tests), PROVISIONING & OPS (Firebase, paywall, releases).

Dispatch: `/pcos hitl-app <issue#>` per 310b precedent. CRITIC verification mandatory before PHASE-2.

**Exit-criteria addendum (new in r4):** after CRITIC PASS, flip the `uplift-hitl-app` cron slot in `brain_librarian.yaml` from `enabled: false` to `enabled: true` in a trailing commit on the same branch. From this point the Tue/Thu/Sat 17:00 UTC Librarian uplift cron runs against the hitl-app brain automatically.

## PHASE-2 — ai_homeworkmarker (pCoS serial, CEO priority, ~1 day)

Same recipe. 6 existing entities uplifted; CDM + SOURCE_MANIFEST + README added. Domains: MARKING ENGINE (Agent-Centric), MOBILE UX (User-Centric), QUALITY & TRUST, PROVISIONING & OPS.

CRITIC verification mandatory before PHASE-3.

**Exit-criteria addendum (new in r4):** after CRITIC PASS, flip the `uplift-ai_homeworkmarker` cron slot from `enabled: false` to `enabled: true`. From this point the Mon/Wed/Fri 17:30 UTC Librarian uplift cron runs automatically.

## PHASES 3–11 — Remaining Satellites (staggered, one per day)

Priority ladder (same as 310b):

| # | Satellite | Notes |
|---|-----------|-------|
| 3 | voice_chat | Flutter, 1 entity currently — expand to ≥5 |
| 4 | resume-tailor | own stack |
| 5 | shin-web | Next.js + digital twin |
| 6 | hitl-web | Next.js landing |
| 7 | hitl-cli | Python SDK |
| 8 | hitl-channel | TypeScript Claude Code plugin |
| 9 | shin_hedge_fund_trader | Python trading bot |
| 10 | ai_assistant | Python CLI + DSL |

Each dispatched via `/pcos <product> <issue#>` only after the previous phase's CRITIC PASS. No parallel satellite missions (per 310b lesson: parallel CoS tracks caused duplicate PRs).

**Exit-criteria addendum (applies to every satellite phase, r4):** Each satellite phase adds its own cron slot to `brain_librarian.yaml` on the phase's working branch with `enabled: false` (per §5 PHASE-0a deliverable 3d) and flips to `enabled: true` in a trailing commit after that satellite's CRITIC PASS. The recommended slot for each satellite is the one listed in the PHASE-0a 3d table; the XO picks the exact slot to dodge cadence collisions with enabled neighbours.

## PHASE-FINAL — HQ Cross-Product Librarian Pass

After all 11 satellites pass CRITIC:

1. **Commit `cross_cutting_entities.yaml` baseline** as the FIRST deliverable (before any dedup work). Lives at `.specs/brain/cross_cutting_entities.yaml`. Lists every concept that appears in ≥2 satellite brains — discovered by scanning every satellite's `entities/` directory for repeated entity ids and by the Librarian's cross-reference lint. Minimum seed set (always included): `firebase_integration`, `flutter_app`, `flutter-ci`, `paywall_system`, `tailscale-funnel`. Committing this file first gives AC11 a deterministic baseline to audit against — CRITIC does not have to re-discover the scope.
2. Regenerate HQ `index.md` as a cross-product CDM projection (entities table now shows which products each entity governs).
3. **Cross-product content deduplication** (AC11 enforcement — this is the content-rewrite step satellite phases explicitly deferred per Risk §8). For every entity in `cross_cutting_entities.yaml`: confirm HQ holds the canonical page, and rewrite each satellite's duplicate content to a short pointer-page with `depends_on: [<entity_id>]` into HQ. Satellite page keeps product-specific gotchas only (≤50 lines). This is a Librarian pass — one `./scripts/dash playbook run brain_librarian` invocation, not a satellite re-dispatch.
4. **Run AC7b (`test_implements_paths_exist`) against hitl-shin-relay as an empire-wide backfill.** hitl-shin-relay shipped per MISSION-2026-316 before AC7b existed and is not touched by any of PHASE-0 through PHASE-11. If any of its entities have drifted `implements:` paths, patch them here. (Addresses CRITIC r2 P2-R2-2.)
5. Run `build_brain_context()` regression suite across all 12 products; ≥90% of products retain 5/5 on their real-issue test fixtures. (Clarification vs AC7: AC7's 4/5 per-product bar is the minimum acceptable at satellite-phase CRITIC time; the 5/5 bar at PHASE-FINAL is an empire-wide retention check across 11-of-12 products after all cross-cutting entities have moved to HQ. Not a tightening of AC7 — a cross-phase retention target.)
6. Drain `_pending/` to zero (after archive).
7. CEO sign-off closes mission.

# 6. Acceptance Criteria (measurable, CRITIC-auditable)

**Deterministic sampling rule (applies to all "sample N" clauses below):** Sort candidate pages by filename ascending, seed `random.Random(mission_id)` (string seed; mission_id is `MISSION-2026-319`), pick the first N from `random.sample()`. Reruns produce the same sample — audits are reproducible.

**Per-product bars (applied to each PHASE-0b through PHASE-11):**

- [ ] **AC1 Curation Manual:** `.specs/brain/README.md` ≥3 KB and contains the five mandatory §4.2 section headings. Enforced by `grep -E "Two-Tier|4-Domain|Librarian'?s Playbook|Clean Brain|How Agents Query" README.md` returning ≥5 matches.
- [ ] **AC2 CDM Entity:** `entities/domain_model.md` exists, declares exactly four `defines:` domain ids, and `governs: [brain_navigation]`.
- [ ] **AC3 Typed Relationships:** Sample `min(10, canonical_entity_count)` entity pages using the deterministic rule above, scoped to pages with `status: canonical` (pages with `status: draft` or `status: deprecated` are excluded). ≥90% of the sample must have a valid `relationships:` block with ≥1 populated key from the six-type schema. Additionally: zero pages with `status: canonical` may carry a legacy flat `cross_refs:` list. Minimum canonical entity floor per product: 5 (below this, the product is structurally under-specified and the phase fails).
- [ ] **AC4 Domain Tag:** Every entity page with `status: canonical` has `domain: "<UPPERCASE DOMAIN>"` in frontmatter matching one of the four CDM domains for its product. Pages with `status: deprecated` are exempt.
- [ ] **AC5 Index as CDM Projection:** `index.md` has one `## N. <DOMAIN>` header per domain; entities listed under the domain they belong to. No flat alphabetical list.
- [ ] **AC6 SOURCE_MANIFEST 100%:** `_pending/SOURCE_MANIFEST.md` exists, covers all file classes from §4.5, and every item is `[x]` at CRITIC time. CRITIC audits via `grep '\[ \]' _pending/SOURCE_MANIFEST.md` returning zero matches.
- [ ] **AC7 build_brain_context() regression (per-product minimum):** CRITIC picks 5 real GitHub issue titles using the deterministic sampling rule from the product's last 30 days of open/closed issues; ≥4 return ≥2 relevant brain pages with ≥1 topically relevant. (PHASE-FINAL applies a separate empire-wide retention target — see §5 PHASE-FINAL.)
- [ ] **AC7b Implements paths exist:** `test_implements_paths_exist(product)` passes — every file path in any `relationships.implements:` list resolves under the product repo root. No fabricated paths. 10-target random sample at CRITIC time when full-pass is expensive.

**Empire-wide bars (checked at PHASE-FINAL):**

- [ ] **AC8 Parity:** All 12 products pass AC1–AC7b independently. CRITIC report filed per product.
- [ ] **AC9 HQ schema authority:** `agent_workflows/.specs/brain/schema.md` exists and every satellite README references it.
- [ ] **AC10 Drain zero:** HQ and satellite `_pending/` directories contain only `SOURCE_MANIFEST.md` + `archive/` after final Librarian pass.
- [ ] **AC11 No duplicate concepts (PHASE-FINAL scope only):** After the PHASE-FINAL cross-product deduplication pass, **every entity listed in the committed `.specs/brain/cross_cutting_entities.yaml` baseline** (see §5 PHASE-FINAL step 1) has exactly one canonical page at HQ (`agent_workflows/.specs/brain/entities/<concept>.md` with `status: canonical`). Satellite pages for those concepts are ≤50 lines and carry `depends_on: [<concept>]` pointing at the HQ page. CRITIC audits against that exact YAML file — no open-ended discovery at audit time. This is the single place content dedupe happens; satellite-phase CRITICs do NOT fail a phase for carrying a duplicate cross-cutting entity.
- [ ] **AC12 Cron cadence live (new in r4; threshold relaxed in r6):** After each phase's CRITIC PASS, that product's uplift cron in `brain_librarian.yaml` is `enabled: true` with the schedule specified in §5 PHASE-0a deliverable 3c / 3d. Verification: `grep -A2 "uplift_product_id: <product>" playbooks/workflows/brain_librarian.yaml` shows `enabled: true`. At PHASE-FINAL the cron slots for all 12 products are enabled; CRITIC runs one `./scripts/dash playbook list` and verifies the next-scheduled time for each uplift cron falls **within the cron's declared cadence window (≤84 hours / 3.5 days for any M/W/F or T/T/S tri-weekly cadence)**. The 84 h threshold accommodates the natural Sat→Tue and Fri→Mon gaps in the tri-weekly schedules; an audit landing on Sun/Mon morning for a T/T/S product should not spuriously fail.
- [ ] **AC13 Page size budget — runtime enforcement (new in r5):** Every entity / lesson / decision / product page in every satellite brain is **≤20,480 bytes (20 KB)** and **≤500 lines**. This closes the loop between §4.2 "Clean Brain Standards — Atomic entities, Reference-Don't-Copy" (prose rule) and what the system actually enforces. Three enforcement points:
  - **Write-time:** `BrainLibrarian.lint()` emits a blocking error ("page size exceeded") for any page over the cap. The `run_brain_uplift_pass(product_id)` native_call (PHASE-0a deliverable 3a) refuses to drain a `_pending/` file whose merge target would exceed the cap — the librarian must split the page or open a follow-up issue first.
  - **CI-time:** A repo-level pytest (`tests/test_brain_page_size_budget.py`) walks `.specs/brain/{entities,lessons,decisions,products}/**/*.md` in every satellite (the same narrowed glob as §5 PHASE-0a #5) and fails on any page >20 KB or >500 lines, with a message naming the offender. Added as PHASE-0a deliverable #5. This prevents large pages from being merged via direct commits that bypass the librarian.
  - **CRITIC-time:** Each phase's CRITIC samples the largest 3 pages in that satellite's brain and verifies ≤20 KB each. Any over-budget page is a P1 finding.
  - **Rationale (2026-04-24 session):** Initial measurement reported oversize (260 KB / 195 KB) on two lesson files; on re-verification against `origin/main` that number was from stale working-directory state, not from committed content. `origin/main` has been clean since commit `799a60681` (2026-04-18, "fix: trim oversize lesson pages"). Current state against the AC13 cap, measured 2026-04-24: **largest entity** `sqlite-wal.md` at 3.3 KB; **largest lesson** `ai_homeworkmarker-lessons.md` at 17.9 KB; **largest decision** `adr-004-empire-infrastructure-stays-gcloud-aligned.md` at 1.6 KB; **largest product** `ai_assistant.md` at 6.6 KB — all under the 20 KB / 500-line cap. (`log.md` is 68 KB but out of AC13 scope — it is auto-rotated machine-generated audit, not curated knowledge.) AC13 is therefore **forward-looking protection** — it bakes the §4.2 "Clean Brain Standards — Reference-Don't-Copy" rule into three runtime checkpoints so lesson-page drift cannot silently regrow as the empire matures. The PR #2154 Layer 2 brain-context budget (dispatch-time) and AC13 (write-time) together close the feedback loop that previously had no runtime size guardrail at either end of the data flow.
  - **Journal pointer:** the relocated raw append-buffer and its ignore rules live in `.specs/brain/README.md`.
  - **Grandfathered allowlist:** `tests/fixtures/brain_page_size_grandfathered.txt` is expected to be empty or near-empty at PHASE-0a time. Any file that lands there must carry a cleanup follow-up issue reference so it doesn't become permanent. Empty-at-PHASE-0a is the target.
    - **RETIRED 2026-05-29 (SPEC-AW-310e / MISSION-2026-388 PHASE-3):** the grandfathered allowlist mechanism has been removed. The bounded-curated-brain redesign enforces page and aggregate budgets directly (walkers operate on tracked pages only; gitignored journal/rolling files are out of scope), so there is no longer an allowlist to drain.

# 7. What this spec does NOT do

- Does **not** replace SPEC-AW-310 or SPEC-AW-310b. Those remain the structural and content-truth foundations; 310c is the structural uplift layer on top.
- Does **not** introduce a database, vector store, or retrieval service. Filesystem + grep + LLM reasoning only.
- Does **not** introduce new `CLAUDE.md` / OPERATOR.md directives beyond updating the brain references.
- Does **not** gate mission delivery on brain reads at dispatch time — `build_brain_context()` remains a helper, not a blocker.
- Does **not** reopen SPEC-AW-310b CRITIC verification. A separate tracking mission (to be assigned — MISSION-2026-317 is already in use) closes 310b's outstanding CRITIC checks.

# 8. Risks & Mitigations

| Risk | Mitigation |
|------|------------|
| Parallel CoS tracks for same satellite produce duplicate PRs (310b lesson, 2026-04-17) | Strict serial satellite dispatch. No PHASE-N+1 until PHASE-N CRITIC PASS. |
| Ops #2058 (clone_cos no_pid_attached) still open | Fall back to direct-CoS per 310b PHASE-4+ precedent. Same recipe; no change required. |
| Agents fabricate entity relationships | Every relationship target must be either an existing entity id OR a real file path reachable by `test_implements_paths_exist(product)` (delivered in PHASE-0a §5 deliverable #4, enforced by AC7b). CRITIC samples 10 relationship targets per product. |
| Satellite README divergence | All satellite READMEs must link to HQ `brain/schema.md` as canon. Spec amendments only happen at HQ. |
| Scope creep — 12 products × N entities × 6 relations | Per-satellite phase targets **structural uplift, not content rewrite**. hitl-shin-relay, hitl-app, ai_homeworkmarker already have rich content; smaller satellites (1-entity scaffolds) stay minimal — 5 canonical entities is the AC3 floor. **Cross-product content dedupe (AC11) is explicitly a PHASE-FINAL Librarian deliverable, not a satellite-phase task.** Satellites carry duplicates until PHASE-FINAL; CRITIC does not fail a satellite phase for that. |
| Librarian pass overwhelms context window | §4.4 mandates "Reference, Don't Copy" — `implements: [paths]` not pasted code. Entity pages stay within the AC13 cap of ≤500 lines / ≤20 KB. |

# 9. Operational Notes

- **Branch strategy:** `direct` for PHASE-0 (HQ, XO-owned). `mission` branch for PHASE-1+ per satellite.
- **Triggered-by:** `-t xo` throughout (ops work; XO owns the brain). HITL routing stays on XO inbox.
- **Agent rotation:** gemini for creative synthesis streams, codex for schema-conformance and Librarian passes, per the 310b PHASE workload.
- **Dependency on 310b:** not blocking. 310b's unverified phases (5, 6, 8, 9) can close in parallel via a separate follow-up mission — 310c's structural uplift does not care about 310b's remaining CRITIC paperwork as long as the content-truth layer is in place on main (it is).

# 10. Implementation Reference

The reference implementation is `slaser79/hitl-shin-relay@main:.specs/brain/`. Any ambiguity in this spec is resolved by checking the shin-relay brain. In particular:

- Curation manual template: `hitl-shin-relay:.specs/brain/README.md`
- CDM entity format: `hitl-shin-relay:.specs/brain/entities/domain_model.md`
- Typed entity example: `hitl-shin-relay:.specs/brain/entities/signaling.md`
- Index-as-CDM-projection: `hitl-shin-relay:.specs/brain/index.md`
- SOURCE_MANIFEST format: `hitl-shin-relay:.specs/brain/_pending/SOURCE_MANIFEST.md`

# 11. Mission Binding

This spec is delivered by **MISSION-2026-319** (to be opened after CEO sign-off). The mission manifest mirrors the phase structure in §5; phase IDs map 1:1 to AC bars in §6.

# 12. Prior Art

**Spec lineage:**
- SPEC-AW-310 (scaffold, 2026-04-13) — `.specs/features/SPEC-AW-310_empire_brain.md`
- SPEC-AW-310b (content truth, 2026-04-17) — `.specs/features/SPEC-AW-310b_brain_content_rewrite.md`
- SPEC-AW-310c (reserved for MISSION-2026-313's brain-cleanup infra fixes — slot not consumed by this spec)
- **SPEC-AW-310d (this spec)** — Great Ingestion Uplift
- MISSION-2026-316 (shin-relay Great Ingestion, 2026-04-19) — `.specs/missions/MISSION-2026-316.yaml` — the reference implementation

**Sibling missions (may run in parallel; scope is disjoint):**
- **MISSION-2026-313** — Brain Cleanup (Librarian Alias Fix + HQ/Satellite Divergence + Lesson Citations). Status PLANNING as of 2026-04-24. Addresses code-level librarian bugs (`_pending/` prefix-stack dedup, HQ↔satellite page divergence, per-lesson source citations — issues #3233, #3234, #3235, #3236 on hitl-app). Its SPEC-AW-310c filename slot is reserved. The infrastructure fixes in MISSION-313 PHASE-2 (librarian dedup by content hash + canonical name rule) reduce friction for this spec's uplift passes — if MISSION-313 completes first, 310d PHASE-0b's Librarian drain produces zero prefix-stacked files; if 310d runs first, its pending files are subject to cleanup when MISSION-313 ships. Neither blocks the other.
- **Lesson file size monitoring** — on 2026-04-24 re-verification, all lesson files on `origin/main` are within the 20 KB / 500-line cap (largest: `ai_homeworkmarker-lessons.md` at 17.9 KB, `shin_hedge_fund_trader-lessons.md` at 16.3 KB). An earlier claim of 260 KB / 195 KB oversize referenced stale working-directory state rather than committed content. The cleanup commit `799a60681` (2026-04-18) already handled this. No separate cleanup mission required at this time; the Librarian lint extension (AC13 deliverable #6) serves as the ongoing monitoring channel.

**Related in-flight PRs (2026-04-24 session):**
- **PR #2154** — `fix(e2big): extend stdin fix to critic/architect/cos + cap brain context`. Not a dependency (this spec is documentation); however, its **Layer 2 `build_brain_context()` budget** is complementary to AC13's page-size runtime enforcement. PR #2154 protects the dispatch path (prompt-size budget at injection time, 30 KB); AC13 protects the storage path (page-size budget at write time, 20 KB). Together they close the feedback loop that had no runtime size guardrail at either end of the data flow before this session.

**Existing infrastructure this spec reuses (per CEO direction — do not invent new pieces):**
- `playbooks/workflows/brain_librarian.yaml` — nightly cron (`0 20 * * *` UTC) HQ brain maintenance. Extended by this spec (new `uplift_product_id` input) rather than replaced.
- `playbooks/workflows/daily_roadmap_review.yaml` — per-satellite morning roadmap review by pCoS (already drains each satellite's `_pending/` as part of the review per its `description`). This is the successor to the legacy "docs update" playbook CEO spun off from the Chief of Staff's morning load. This spec does NOT modify `daily_roadmap_review.yaml`; it leverages the drain-on-review behaviour that already exists.
- `run_brain_librarian_maintenance()` in `src/agent_workflows/playbooks/native_calls.py` — ingests from satellites, drains pending, updates index, rotates log, lints. Extended by this spec with a new sibling function `run_brain_uplift_pass(product_id)`.
- `BrainLibrarian` class — the filesystem-level brain operations library; reused without modification.

**External reference:**
- Karpathy LLM Wiki pattern — https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f

# 13. Revision Log

- **2026-04-24 r1 (XO):** Initial draft as SPEC-AW-310c. Issue #2149 opened, CRITIC task `16d08044` dispatched.
- **2026-04-24 r2 (XO):** CRITIC returned CONDITIONAL (0 P0, 4 P1, 8 P2) in report `.specs/reports/SPEC-AW-310c_spec_review.md`. This revision addresses all 4 P1s and all 8 P2s:
  - **P1-1 (AC11 vs Risk §8 contradiction):** AC11 scope narrowed to PHASE-FINAL only. Cross-product dedup is now an explicit PHASE-FINAL Librarian deliverable (§5 PHASE-FINAL). Satellite-phase CRITIC does not fail for duplicate cross-cutting entities (Risk §8 row updated).
  - **P1-2 (missing `test_implements_paths_exist`):** Added as PHASE-0a deliverable #4 and promoted to acceptance criterion AC7b.
  - **P1-3 (AC3 sampling vs deferred pages):** Introduced entity `status: canonical|draft|deprecated` lifecycle in §4.4. AC3 sample scope restricted to `status: canonical`. PHASE-0b now uplifts every existing HQ entity (no HQ entity deferred to PHASE-FINAL).
  - **P1-4 (Librarian dispatch unspecified):** Added PHASE-0a deliverable #3 — create `.specs/roles/librarian/SKILL.md` role wrapper. Dispatch syntax: `dash trigger <issue#> -a codex -R librarian -t xo`.
  - **P2-1 (AC1 heading regex):** Exact grep regex added to §4.2 and AC1.
  - **P2-2 (jules→gemini divergence):** Noted in §5 PHASE-0b opening paragraph with citation to CLAUDE.md 2026-04-11.
  - **P2-3 (AC3 sample size):** `min(10, canonical_entity_count)` clause added; 5-entity floor explicit.
  - **P2-4 (SOURCE_MANIFEST docs/config):** `docs/*.md` and `config/*.yaml` added to §4.5 default list with product-specific additions clause.
  - **P2-5 (direct PR vs direct-push):** §5 PHASE-0a exit criteria rewritten — "open PR, self-merge" made explicit, no branch-protection bypass.
  - **P2-6 (sampling reproducibility):** Deterministic sampling rule added at top of §6 (sort + seed=mission_id).
  - **P2-7 (AC4 deprecated carve-out):** AC4 now exempts `status: deprecated` pages.
  - **P2-8 (AC7 vs PHASE-FINAL retention):** PHASE-FINAL regression bar clarified as cross-phase retention check, not a tightening of AC7.
- **2026-04-24 r3 (XO):** CRITIC r2 returned APPROVED_WITH_CHANGES (0 P0, 1 P1, 4 P2) in report attached to [PR #2151](https://github.com/slaser79/agent_workflows/pull/2151) (9m 36s, 57 events). CEO feedback (2026-04-24, same session): "We normally have the librarian be similar to the Doc's Update… I think we don't need to invent new pieces." Both sources addressed here:
  - **P1-R2-1 (spec-ID collision with MISSION-2026-313):** **Spec renamed SPEC-AW-310c → SPEC-AW-310d.** MISSION-313 is PLANNING (zero progress) and reserves SPEC-AW-310c for librarian-infra bug fixes (#3233-3236) — a disjoint scope. Kept MISSION-313 alive; added it to §12 Prior Art as a sibling mission whose librarian-dedup infra work reduces friction for 310d but does not block it.
  - **CEO architectural correction (supersedes r2 P1-4 fix):** **Dropped the invented `.specs/roles/librarian/SKILL.md`** role. PHASE-0a deliverable #3 rewritten to **extend the existing `brain_librarian` playbook + `run_brain_librarian_maintenance()` native_call** (both present on main) with a new sibling function `run_brain_uplift_pass(product_id)` and a new `uplift_product_id` playbook input. Librarian is a native_call pipeline, not an agent role; dispatch is `./scripts/dash playbook run brain_librarian --input uplift_product_id=<product>`. §5 PHASE-0b Librarian step rewritten accordingly. §12 Prior Art now documents the existing two-channel architecture (`daily_roadmap_review.yaml` per-satellite drain on morning pCoS review, `brain_librarian.yaml` nightly HQ maintenance) — the legacy "docs update" playbook's successor path.
  - **P2-R2-1 (unused `draft` state):** §4.4 lifecycle clarified — `draft` is the implicit pre-uplift state of every legacy page and always transitions to `canonical` or `deprecated` within the same phase; never persists across phase boundaries.
  - **P2-R2-2 (shin-relay AC7b retro check):** §5 PHASE-FINAL step 4 adds explicit `test_implements_paths_exist` backfill run against hitl-shin-relay (shipped pre-AC7b via MISSION-316).
  - **P2-R2-3 (snake_case ↔ UPPERCASE mapping):** §4.3 gains a "Naming convention" paragraph making the bidirectional mapping explicit.
  - **P2-R2-4 (AC11 "plus any others surfaced" non-determinism):** §5 PHASE-FINAL step 1 promoted to "commit `.specs/brain/cross_cutting_entities.yaml` baseline as the FIRST deliverable". AC11 rewritten to audit against that exact YAML file rather than "any others surfaced".
- **2026-04-24 r4 (XO):** CEO flagged (same session): "when did the doc update playbooks run I think those are also perfect for librarian tasks". Historical schedule pulled from git (commit `3b7899d94^`): `docs_update.yaml` ran `0 17 * * 1,3,5` for HQ, `docs_update_hitl_app.yaml` ran `0 17 * * 2,4,6`, `docs_update_ai_homeworkmarker.yaml` ran `30 17 * * 1,3,5`. These were deleted on 2026-04-14 when the Librarian was repositioned. CEO confirmed option (1): pre-apply the cadence reinstatement into this spec before the next CRITIC pass. This revision:
  - **§5 PHASE-0a deliverable #3 expanded from 1 paragraph to 6 sub-items (3a–3f).** New: (3c) inital per-product cron slots for agent_workflows / hitl-app / ai_homeworkmarker, restored from the legacy docs_update schedules verbatim. (3d) per-phase slot-add protocol — each satellite phase adds its own `enabled: false` cron slot and flips it to `enabled: true` after CRITIC PASS; recommended schedules for all 9 remaining satellites documented. (3e) initial Great Ingestion uses the same code path as the nightly cron — `dash playbook run brain_librarian --input uplift_product_id=<product>` — no parallel implementation. (3f) restates the CEO-mandated no-agent-role / no-SKILL.md / no-`-R` rule.
  - **§5 PHASE-0b / PHASE-1 / PHASE-2 exit criteria** now mandate the enable-flip as a trailing commit after CRITIC PASS. §5 PHASES 3–11 gets a general exit-criteria addendum covering the same pattern for the remaining satellites.
  - **§6 AC12 added (new):** cron cadence live — for each phase that passes CRITIC, the corresponding cron slot is `enabled: true`. At PHASE-FINAL, all 12 product uplift crons are registered and have a next-scheduled-time within 48 hours of audit time.
- **2026-04-24 r5 (XO):** CRITIC r4 blocked on E2BIG (CriticAgent / ArchitectAgent / CosAgent / ProductCoSAgent missed by PR #2144 stdin fix; brain context for an `agent_workflows` dispatch measured ~212 KB, exceeding Linux MAX_ARG_STRLEN of ~128 KB/arg). Session paused to address the root cause strategically:
  - **PR #2154 opened and merged** (`fix(e2big): extend stdin fix to critic/architect/cos + cap brain context`): Layer 1 adds `use_stdin_prompt=True` + strips `prompt` from argv on Critic/Architect/Cos/ProductCoS/QA/Researcher agents plus an executor-level safety net (RuntimeError before subprocess_exec for any non-stdin agent >64 KB). Layer 2 adds a 30 KB total / 5 KB per-page byte budget to `build_brain_context()` with deterministic ranking (product → entity-by-title-keyword → lesson) and graceful truncation preserving frontmatter. Measured effect on CRITIC dispatch: **~212 KB → ~22 KB brain context (~10× reduction)**. Copilot intentionally skipped per the 2026-04-22 research note (stdin behaviour unverified). 20 tests in `tests/test_e2big_critic_payload_governance.py`, plus 208 related regression tests green.
  - **§6 AC13 added (new):** page-size runtime enforcement — every entity / lesson / decision / product page ≤20 KB and ≤500 lines. Enforcement at three points: write-time (`BrainLibrarian.lint()` blocks oversized pages; `run_brain_uplift_pass` refuses to drain for products with offenders), CI-time (`tests/test_brain_page_size_budget.py` walks all satellite brains), and CRITIC-time (sample largest 3 pages per phase). Grandfathered allowlist at `tests/fixtures/brain_page_size_grandfathered.txt` lets PR #2154 land without immediately failing on any currently over-cap files.
  - **§5 PHASE-0a deliverables #5 and #6 added:** pytest page-size walker + `BrainLibrarian._check_page_size_budget()` extension, both gated by the allowlist.
  - **§12 Prior Art:** added the pending lesson-cleanup follow-up mission and PR #2154 as a complementary "dispatch path" protection paired with AC13's "storage path" protection.
- **2026-04-24 r6 (XO):** CRITIC r4 returned APPROVED_WITH_CHANGES (0 P0, 1 P1, 6 P2) in report at PR #2160 / `.specs/reports/SPEC-AW-310d_spec_review_r4.md`, post-restart of the stdin-fixed server. This revision addresses every finding:
  - **P1-R4-1 (walker scope vs AC13 scope):** §5 PHASE-0a #5 walker restricted to `.specs/brain/{entities,lessons,decisions,products}/**/*.md`. `README.md` / `index.md` / `schema.md` / `log.md` (auto-rotated 68 KB) / `_pending/*` all explicitly out of scope. Aligns with AC13's §6 declared scope.
  - **P2-R4-1 (stale §10 HQ pending reference):** `hitl-shin-relay_SOURCE_MANIFEST.md` in HQ pending doesn't exist — dropped parenthetical, reference now points directly at satellite.
  - **P2-R4-2 (AC12 48h too tight for tri-weekly):** Threshold raised to 84h (3.5 days) with explicit rationale for Sat→Tue / Fri→Mon gap tolerance.
  - **P2-R4-3 (§5 #3c initial-state phrasing):** Rewritten to explicitly say "All cron slots added by this deliverable (both three initial slots and per-phase slots in 3d) ship with `enabled: false`" + pointer to exit-criteria flip.
  - **P2-R4-4 (AC13 rationale scope):** Extended to name largest entity / lesson / decision / product pages. Explicit note that `log.md` is out of AC13 scope.
  - **P2-R4-5 (§8 vs AC13 line-count drift):** §8 "<300 lines" replaced with "within the AC13 cap of ≤500 lines / ≤20 KB". Single numeric bar.
  - **P2-R4-6 (issue title paperwork):** Acknowledged in CRITIC report; future CRITIC dispatches should key issue title off the spec's top-line revision. No spec edit needed.
- **2026-04-24 r6.1 (XO):** CRITIC r6 on commit `6de3d29a` returned **APPROVED** (0 P0, 0 P1, 3 P2 paperwork-only) in report at PR #2161 / `.specs/reports/SPEC-AW-310d_spec_review_r6.md`. All three P2s addressed in the same pass as housekeeping:
  - **P2-R6-1 (AC13 CI-time sub-bullet glob drift):** §6 AC13 CI-time bullet now cites the same narrowed `.specs/brain/{entities,lessons,decisions,products}/**/*.md` glob as §5 PHASE-0a #5.
  - **P2-R6-2 (AC13 rationale sizes stale):** Re-measured on branch: largest entity `sqlite-wal.md` 3.3 KB, lesson `ai_homeworkmarker-lessons.md` 17.9 KB, decision `adr-004…` 1.6 KB, product `ai_assistant.md` 6.6 KB. Rationale updated to match.
  - **P2-R6-3 (revision log r5/r6 chronology):** r5 block moved before r6 block; stray "Cancelled CRITIC r3" bullet that was misplaced under r6 merged into the earlier r4 entry's context. Ready for CEO sign-off.
