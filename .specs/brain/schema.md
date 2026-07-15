---
title: "Empire Brain Relationships Schema"
type: reference
products: [agent_workflows]
last_updated: 2026-04-24
sources:
  - .specs/features/SPEC-AW-310d_brain_great_ingestion_uplift.md
  - .specs/brain/README.md
  - .specs/brain/entities/domain_model.md
cross_refs:
  - README.md
  - entities/domain_model.md
  - index.md
---

# Empire Brain Relationships Schema

HQ defines the canonical relationship schema for every empire brain page that uses
typed frontmatter relationships. The allowed relationship keys are fixed:

- `defines`
- `implements`
- `depends_on`
- `governs`
- `triggers`
- `supersedes`

No additional relationship types are canonical without a spec amendment.

## Canonical Frontmatter Shape

```yaml
---
id: example_entity
title: "Example Entity"
domain: "ORCHESTRATION"
entity: ExampleEntity
status: canonical
last_updated: 2026-04-24
relationships:
  defines: [example_concept]
  implements: [src/example.py]
  depends_on: [prerequisite_entity]
  governs: [example_behavior]
  triggers: [example_event]
  supersedes: [legacy_example_entity]
---
```

## Relationship Semantics

### `defines`

Use `defines` for the concept ids that this page is the canonical definition of.
These are concept identifiers, not prose labels.

### `implements`

Use `implements` for repo-relative file paths that realize the concept in code,
configuration, playbooks, or other executable artifacts. Prefer references to the
real implementation over pasted snippets.

### `depends_on`

Use `depends_on` for prerequisite entities a reader should understand first. This is
the graph edge that answers "what do I need to read before this page fully makes
sense?"

### `governs`

Use `governs` for behaviors, rules, contracts, or flows whose policy is set by the
current entity. SPEC-IDs are valid `governs` targets (a spec is a contract).

### `triggers`

Use `triggers` for events, transitions, downstream workflows, or follow-on actions
that originate from the current entity.

### `supersedes`

Use `supersedes` when a page replaces or deprecates prior canon. The new page should
point to the old id so the migration path stays explicit.

## Rules

- All six keys must exist in the `relationships` mapping, even when empty.
- `status: canonical` pages are expected to use this typed schema.
- `status: draft` pages may still be in migration, but they should transition to
  canonical or deprecated within the phase that touches them.
- `status: deprecated` pages should use `supersedes` to identify the replacement.
- `implements` entries must resolve to real repo paths.
