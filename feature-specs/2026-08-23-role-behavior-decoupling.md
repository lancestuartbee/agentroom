# Role / Behavior Decoupling Implementation Plan

**Feature:** F032 — `docs/features/F032-agent-plugin-architecture.md`
**Goal:** Development-mode collaboration prompts derive routing from roster roles and discipline from independent behavior assignments, without consulting breed, cat ID, display name, model family, or capability prose.
**Acceptance Criteria:**
- AC-1: The common development protocol remains gated by `promptProfile=development`; lightweight profiles receive no S6 content.
- AC-2: Role routing reads only `roster[catId].roles`; multiple dev roles still use the existing priority order.
- AC-3: Behavior overlays read only `roster[catId].behaviors`; role names never double as provider/family identity tags.
- AC-4: Equal role + behavior sets produce equal S6 output across different breed IDs, cat IDs, display names, and model families.
- AC-5: Runtime `SystemPromptBuilder` and native L0 compile the same role and behavior blocks.
- AC-6: Built-in GPT/Codex engineering discipline and OpenCode runtime boundaries are preserved through explicit behavior assignments.
- AC-7: Runtime create/update, template seeding, Hub editor, and first-run creation persist behavior assignments end to end.
- AC-8: Legacy flat and nested `breeds:` S6 overlays are migrated with an explicit warning; malformed overlays fail/fallback through the existing contract instead of disappearing silently.
- AC-9: Existing role-only catalogs remain valid and treat missing behaviors as an empty list.
**Architecture cell:** identity-session / identity-agent
**Map delta:** none
**Map delta why:** F032 already owns roster roles and collaboration-rule projection; this change separates two fields inside that existing ownership cell.
**Architecture:** Extend `RosterEntry` with optional `behaviors`, and split S6 templates into `roles` and `behaviors`. Both runtime and native compilers consume the same normalized loader contract. Member creation/editing treats both arrays as independent persisted data.
**Tech Stack:** TypeScript, Zod, YAML, Node test runner, React/Vitest
**前端验证:** Yes — deterministic component/payload tests; no visual layout redesign.

---

## Finish line

The final system has three non-overlapping sources: capability evidence remains in F208/dossier and provider capability systems; roster `roles` describe team functions; roster `behaviors` opt members into reusable prompt disciplines. We are not building algorithmic task classification, automatic capability-to-role promotion, or a second behavior store.

## Terminal schema

```ts
interface RosterEntry {
  family: string;
  roles: readonly string[];
  behaviors?: readonly string[];
  lead: boolean;
  available: boolean;
  evaluation: string;
}

interface WorkflowTriggers {
  roles: Record<string, string>;
  behaviors: Record<string, string>;
}
```

Canonical behavior IDs:

- `engineering-discipline`: fallback-layer coordinate audit + long-task execution discipline.
- `opencode-runtime-boundary`: OMOC/MCP/question-tool boundaries.

## Stateful object census

### Object A — Runtime roster entry

- Lifecycle owner: `.cat-cafe/cat-catalog.json` through `runtime-cat-catalog.ts`.
- State: absent → created with roles/behaviors → patched independently → deleted with the roster entry.
- Generic create/update routes may write the two arrays; prompt compilers are read-only consumers.

| Current state | Event | Next state | Invariant |
|---|---|---|---|
| absent | create without behaviors | entry with `behaviors: []` | roles do not imply behaviors |
| absent | create from template | entry with template roles + behaviors | both axes seeded independently |
| present | patch roles | only roles change | behavior projection unchanged |
| present | patch behaviors | only behaviors change | reviewer eligibility unchanged |
| present | delete | absent | no orphan behavior state |

### Object B — S6 local overlay

- Lifecycle owner: prompt-injection overlay API and `prompt-template-loader.ts`.
- State: base → local override → reset to base; legacy documents normalize on read.
- Atomic write/backup behavior remains owned by the existing API.

| Current state | Event | Next state | Invariant |
|---|---|---|---|
| base | save roles/behaviors YAML | local override | all leaves are strings |
| legacy flat/nested breeds | read | normalized in memory + warning | content is not silently discarded |
| malformed local | read | base fallback | native/runtime remain available |
| local override | reset | base | native L0 cache invalidated |

## Invariants and adversarial tests

- INV-1: Changing only `breedId`, `catId`, display name, or model family cannot change S6. Test with two synthetic members sharing roles/behaviors.
- INV-2: Changing roles cannot add/remove behavior blocks. Test independent role PATCH and prompt output.
- INV-3: Changing behaviors cannot affect reviewer matching roles. Test roster response and matcher eligibility.
- INV-4: Runtime and native L0 include the same role and behavior markers. Test identical fixture through both compilers.
- INV-5: Casual/roundtable/sandbox contain neither common protocol nor role/behavior blocks.
- INV-6: Template → Hub/first-run → POST payload preserves both arrays. Test both UI entry points.
- INV-7: Legacy `breeds.maine-coon` and `breeds.golden-chinchilla` normalize to canonical behavior IDs with a warning. Test loader under isolated overlay.
- INV-8: Missing `behaviors` remains valid and renders no behavior overlay. Test a legacy roster fixture.

## Implementation tasks

### Task 1: Red tests for the two-axis contract

**Files:** `packages/api/test/system-prompt-builder.test.js`, `packages/api/test/f203-phase-i-opencode-l0.test.js`, `packages/api/test/prompt-injection-yaml-validation.test.js`

1. Add synthetic same-roles/same-behaviors/different-identity parity tests.
2. Add role/behavior independence tests and runtime/native parity tests.
3. Add legacy nested-breed migration test.
4. Run focused tests and confirm expected failures against `origin/main`.

### Task 2: Shared schema and loader normalization

**Files:** `packages/shared/src/types/cat-breed.ts`, `packages/api/src/config/cat-config-loader.ts`, `packages/api/src/domains/cats/services/context/prompt-template-loader.ts`, `packages/api/src/routes/prompt-injection.ts`, `assets/prompt-templates/workflow-triggers.yaml`

1. Add optional roster behaviors with empty-list read semantics.
2. Replace S6 `breeds` with `behaviors` in the normalized contract.
3. Migrate known legacy breed keys to canonical behavior IDs and warn for legacy input.
4. Run loader/overlay tests green.

### Task 3: Runtime/native projection

**Files:** `packages/api/src/domains/cats/services/context/SystemPromptBuilder.ts`, `scripts/compile-system-prompt-l0.mjs`, `cat-template.json`, `scripts/verify-template-extraction.mjs`, `scripts/prompt-injection-review-guards.test.mjs`

1. Project the highest-priority dev role from `roles`.
2. Append behavior blocks from `behaviors` in stable member-declared order.
3. Remove every breed/cat/display fallback from S6 compilation.
4. Assign built-in behavior IDs without changing role semantics.
5. Run parity and guard tests green.

### Task 4: Runtime CRUD and product entry points

**Files:** `packages/api/src/config/runtime-cat-catalog.ts`, `packages/api/src/routes/cats.ts`, `packages/api/test/cats-routes-runtime-crud.test.js`, `packages/web/src/components/first-run-quest/TemplateStep.tsx`, `packages/web/src/components/FirstRunQuestWizard.tsx`, `packages/web/src/components/hub-cat-editor.model.ts`, `packages/web/src/components/hub-cat-editor.payload.ts`, `packages/web/src/components/hub-cat-editor.sections.tsx`, `packages/web/src/components/HubCatEditor.tsx`, and relevant Hub/first-run tests.

1. Add independent create/PATCH behavior persistence tests.
2. Add template response and both UI payload tests.
3. Implement API/runtime and UI plumbing.
4. Run API and Web focused suites green.

### Task 5: Quality gate and review

1. Run shared/API/Web builds, TypeScript, Biome, extraction/manifest guards, and all focused suites.
2. Confirm `git diff` contains no F247/memory files and no broad JSON reformatting.
3. Commit with Why + thread provenance footer.
4. Request cross-individual review with commit, risks, and exact verification evidence.

## Open questions

- Technical: unknown custom legacy breed keys cannot be assigned to a member without an explicit `behaviors` roster entry; loader must warn and preserve the normalized content so the operator can assign it.
- Value: none. The operator already selected full ability/role/behavior decoupling, and this plan does not introduce algorithmic routing.
