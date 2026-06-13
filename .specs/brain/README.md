# Empire Brain — HQ Curation Manual

This manual defines how `agent_workflows` maintains the empire's canonical brain.
HQ is not a dumping ground for disconnected notes. It is the curated reference for
the orchestration layer, the shared relationships schema, and the operating rules
that every satellite brain inherits during the Great Ingestion uplift.

The operating principle is simple: workers capture raw signal fast, and the
Librarian converts that signal into durable canonical pages. That split keeps the
brain writable during active delivery without letting the curated knowledge base
degrade into duplicated prose, stale implementation snippets, or untraceable
"tribal knowledge."

## 1. The Two-Tier Protocol

The **Two-Tier Protocol** separates low-friction capture from high-standard curation.
Every agent should understand which tier they are operating in before they write.

### Tier 1: Worker Discovery

- Workers write raw findings to `.specs/brain/_pending/<task_id>.md`.
- Worker notes can be incomplete, overlapping, or narrowly scoped to a single task.
- Workers should prefer source references, issue context, and concrete lessons over
  polished narrative.
- Workers do not directly rewrite canonical entities unless the task explicitly
  includes that curation work.

### Tier 2: Librarian Synthesis

- The Librarian reads `_pending/` submissions, deduplicates them, and merges the
  lasting signal into canonical pages.
- The Librarian updates typed `relationships:` blocks, refreshes the index, and
  archives processed drops for provenance.
- The Librarian is a native-call pipeline in HQ, not a separate agent role.
- The goal of the **Two-Tier Protocol** is a clean write path for workers and a
  clean read path for everyone else.

## 2. The 4-Domain Architecture

HQ uses a **4-Domain Architecture** tailored to Mission Control. Every canonical
entity should live in one primary domain even when it influences multiple flows.

1. **ORCHESTRATION**: mission dispatch, task scheduling, playbooks, manifests,
   agent routing, and HQ control loops.
2. **APP SERVICES**: dashboard surfaces, HITL routing, inbox behavior, and the
   user-facing operating surfaces for mission control.
3. **QUALITY & TRUST**: critic flows, validation, lessons, safety rails, and the
   reliability contracts that keep autonomous delivery safe.
4. **PROVISIONING & OPS**: runners, infrastructure, GitHub integration, networking,
   deployment posture, and shared operational services.

The **4-Domain Architecture** is not decorative taxonomy. It is how the index,
Canonical Domain Model, and relationship graph stay consistent across products.
When a page spans domains, choose the primary domain that best answers "who needs
this first?" and express the secondary links through typed relationships instead of
copying the same explanation into multiple files.

The curatorial model is two-class: tracked canonical pages live in the domain
trees above, while overflow journal entries live in the gitignored
`.specs/brain/_journal/` append-only buffer and never become canon.

## 3. The Librarian's Playbook

The **Librarian's Playbook** is a four-step SOP. Do not expand it into a bespoke
workflow per mission. The point is repeatability.

1. **Ingest**
   Read pending knowledge drops, satellite imports, and any staged source manifests.
   Sort raw input into entities, lessons, decisions, or product updates.
2. **Deduplicate & Merge**
   Find the existing canonical page before creating a new one. Merge overlapping
   truth into one durable page instead of proliferating near-duplicates.
3. **Map Relationships**
   Update the six canonical relation types: `defines`, `implements`, `depends_on`,
   `governs`, `triggers`, and `supersedes`.
4. **Index & Archive**
   Regenerate navigation surfaces, update audit artifacts, and move processed
   pending files into archive storage so the provenance remains inspectable.
   Rebuild the per-repo Specs pointer layer from `.specs/features/` frontmatter and flag any orphaned spec (the four conditions).

The **Librarian's Playbook** exists to protect the graph shape of the brain, not
just its prose quality. A good pass leaves the repo easier to traverse than before.

## 4. Clean Brain Standards

The **Clean Brain** standard means canonical pages are compact, specific, and
traceable back to real sources.

- One page defines one core concept. If a page is covering multiple unrelated
  concepts, split it.
- Prefer `relationships.implements` file references over pasted code or large
  implementation excerpts.
- Prefer typed relationships over ad hoc "see also" prose.
- Record what governs, what depends on what, and what supersedes prior canon.
- Keep pages within the size budget so the brain stays readable and synthesizable.

The **Clean Brain** rule also means HQ should not mirror whole satellite brains.
HQ keeps authoritative shared knowledge and concise product pointers; satellites
keep the local depth. If a future reader would be better served by the satellite's
canonical page, link to it or point to its owning product instead of duplicating
pages in HQ.

## 5. How Agents Query the Brain

**How Agents Query the Brain** should stay deterministic and filesystem-native.
No database or vector index is required for day-to-day use.

1. Start with `.specs/brain/index.md` to identify the relevant domain and page set.
2. Use semantic grep across `.specs/brain/` for entity names, behaviors, or source
   files when the right page is unclear.
3. Read the target canonical page in full before changing code or writing more
   knowledge.
4. Follow typed relationships to build the dependency chain and blast radius.

**How Agents Query the Brain** matters because the brain is only valuable if it can
be traversed quickly under delivery pressure. The shortest good path is:
domain map -> canonical page -> related prerequisites -> source file references.

## 6. HQ-Specific Operating Rules

HQ owns the shared schema and the curation contract for the empire.

- `schema.md` in this directory is the canonical relationship reference that
  satellites should inherit from or cite.
- `entities/domain_model.md` defines the HQ Canonical Domain Model for
  ORCHESTRATION / APP SERVICES / QUALITY & TRUST / PROVISIONING & OPS.
- Scheduled Librarian uplift passes are staged by product and remain disabled until
  each product's initial structural uplift has passed CRITIC.
- The existing nightly maintenance run remains the non-disruptive cleanup path for
  linting, index refresh, and log rotation.

## 7. Practical Rules of Thumb

- If a note is transient task chatter, keep it out of canon.
- If a lesson would help another agent avoid a real failure, curate it.
- If two pages describe the same thing, merge them or deprecate one.
- If a relationship can be expressed structurally, prefer that over narrative.
- If a page is growing past the budget, split it before it becomes unreadable.

## 8. Satellite Brain Template

While HQ uses the 4-Domain/Librarian pattern, satellites (e.g., `hitl-app`, `ai_homeworkmarker`)
should use the following five-section template for their `README.md` to ensure CDM
alignment and page-size budget discipline:

1. **Purpose** — Single-sentence product mission and brain scope.
2. **Page Structure** — How entities, lessons, and decisions are organized.
3. **CDM** — The Canonical Domain Model for the satellite.
4. **Typed Relationships** — Reference to the shared `schema.md`.
5. **Page-Size Budget** — Enforcement rules for page length and complexity.

HQ's `test_brain_canonical_format.py` validates both the HQ and satellite patterns.

### Ingestion Manifest (SOURCE_MANIFEST.md)

To avoid false positives in AC6 `grep '\[ \]'` checks, the legend marker in
`_pending/SOURCE_MANIFEST.md` must be escaped by splitting the brackets into
separate code spans:

- `[` ` ]` missing — file referenced by context but not present in the repo.
