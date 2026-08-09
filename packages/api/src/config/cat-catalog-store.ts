import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, relative, resolve, sep } from 'node:path';
import type { CatCafeConfig, ClientId, RosterEntry } from '@cat-cafe/shared';
import { resolveBuiltinClientForProvider } from './account-resolver.js';
import {
  pickSeedBreed,
  pruneRosterToRuntimeBreeds,
  type RuntimeBreedWithCatIds,
} from './cat-catalog-bootstrap-roster.js';
import { resolveProjectTemplatePath } from './project-template-path.js';

const CONFIG_SUBDIR = '.cat-cafe';
const CAT_CATALOG_FILENAME = 'cat-catalog.json';

function safePath(projectRoot: string, ...segments: string[]): string {
  const root = resolve(projectRoot);
  const normalized = resolve(root, ...segments);
  const rel = relative(root, normalized);
  if (rel.startsWith(`..${sep}`) || rel === '..') {
    throw new Error(`Path escapes project root: ${normalized}`);
  }
  return normalized;
}

function writeFileAtomic(filePath: string, content: string): void {
  const tempPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tempPath, content, 'utf-8');
  try {
    renameSync(tempPath, filePath);
  } catch (error) {
    try {
      unlinkSync(tempPath);
    } catch {
      // Ignore cleanup failures.
    }
    throw error;
  }
}

/** clowder-ai#340 P5: ClientId values — used to detect old `provider` field holding a clientId. */
const CLIENT_ID_VALUES = new Set(['anthropic', 'openai', 'google', 'kimi', 'dare', 'antigravity', 'opencode', 'a2a']);

const LEGACY_PERSONA_TERMS = ['布偶猫', '缅因猫', '暹罗猫', '狸花猫', '孟加拉猫', '金吉拉', '月影猫'];

const BREED_IDENTITY_FIELDS = [
  'name',
  'displayName',
  'nickname',
  'avatar',
  'roleDescription',
  'teamStrengths',
  'caution',
  'restrictions',
  'modelFamily',
  'modelLine',
  'capabilityLevel',
  'runtimeClient',
  'mentionPatterns',
] as const;

const VARIANT_IDENTITY_FIELDS = [
  'displayName',
  'variantLabel',
  'nickname',
  'avatar',
  'color',
  'roleDescription',
  'personality',
  'teamStrengths',
  'caution',
  'restrictions',
  'strengths',
  'modelFamily',
  'modelLine',
  'capabilityLevel',
  'runtimeClient',
  'mentionPatterns',
] as const;

function stringHasLegacyPersonaTerm(value: unknown): boolean {
  return typeof value === 'string' && LEGACY_PERSONA_TERMS.some((term) => value.includes(term));
}

function recordHasLegacyPersonaIdentity(record: Record<string, unknown>): boolean {
  return (
    stringHasLegacyPersonaTerm(record.name) ||
    stringHasLegacyPersonaTerm(record.displayName) ||
    stringHasLegacyPersonaTerm(record.nickname) ||
    stringHasLegacyPersonaTerm(record.roleDescription) ||
    stringHasLegacyPersonaTerm(record.teamStrengths) ||
    stringHasLegacyPersonaTerm(record.personality) ||
    (Array.isArray(record.mentionPatterns) && record.mentionPatterns.some(stringHasLegacyPersonaTerm))
  );
}

function jsonEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function replaceIdentityFields(
  target: Record<string, unknown>,
  source: Record<string, unknown>,
  fields: readonly string[],
): boolean {
  let dirty = false;
  for (const field of fields) {
    if (Object.prototype.hasOwnProperty.call(source, field)) {
      const nextValue = structuredClone(source[field]);
      if (!jsonEqual(target[field], nextValue)) {
        target[field] = nextValue;
        dirty = true;
      }
    } else if (Object.prototype.hasOwnProperty.call(target, field)) {
      delete target[field];
      dirty = true;
    }
  }
  return dirty;
}

function resolvedVariantCatId(breed: Record<string, unknown>, variant: Record<string, unknown>): string | null {
  const variantCatId = variant.catId;
  if (typeof variantCatId === 'string' && variantCatId.length > 0) return variantCatId;
  const breedCatId = breed.catId;
  return typeof breedCatId === 'string' && breedCatId.length > 0 ? breedCatId : null;
}

function migrateLegacyPersonaIdentity(catalog: CatCafeConfig, template: CatCafeConfig): boolean {
  let dirty = false;
  const catalogBreeds = catalog.breeds as unknown as Record<string, unknown>[];
  const templateBreeds = template.breeds as unknown as Record<string, unknown>[];
  const templateBreedById = new Map(templateBreeds.map((breed) => [String(breed.id), breed]));

  for (const breed of catalogBreeds) {
    const templateBreed = templateBreedById.get(String(breed.id));
    if (!templateBreed) continue;

    const breedLooksLegacy = recordHasLegacyPersonaIdentity(breed);
    const templateBreedLooksLegacy = recordHasLegacyPersonaIdentity(templateBreed);
    if (breedLooksLegacy && !templateBreedLooksLegacy) {
      dirty = replaceIdentityFields(breed, templateBreed, BREED_IDENTITY_FIELDS) || dirty;
    }

    const variants = Array.isArray(breed.variants) ? (breed.variants as Record<string, unknown>[]) : [];
    const templateVariants = Array.isArray(templateBreed.variants)
      ? (templateBreed.variants as Record<string, unknown>[])
      : [];
    const templateVariantById = new Map(templateVariants.map((variant) => [String(variant.id), variant]));
    const templateVariantByCatId = new Map<string, Record<string, unknown>>();
    for (const templateVariant of templateVariants) {
      const catId = resolvedVariantCatId(templateBreed, templateVariant);
      if (catId) templateVariantByCatId.set(catId, templateVariant);
    }

    for (const variant of variants) {
      const catId = resolvedVariantCatId(breed, variant);
      const templateVariant =
        templateVariantById.get(String(variant.id)) ?? (catId ? templateVariantByCatId.get(catId) : null);
      if (!templateVariant) continue;
      if (
        !templateBreedLooksLegacy &&
        (breedLooksLegacy || recordHasLegacyPersonaIdentity(variant)) &&
        !recordHasLegacyPersonaIdentity(templateVariant)
      ) {
        dirty = replaceIdentityFields(variant, templateVariant, VARIANT_IDENTITY_FIELDS) || dirty;
      }
    }
  }

  return dirty;
}

/**
 * Cross-member mention-alias uniqueness repair.
 *
 * A mention alias (e.g. `@claude`) must route to exactly one cat. Legacy catalogs
 * accumulated the same alias on several Claude-family variants (opus/sonnet/opus-45/fable-5),
 * which makes the alias-uniqueness gate in POST/PATCH /api/cats reject saving *any* of them
 * ("别名 @claude 已被成员 X 使用") even though the operator never sees the duplicate in the
 * profile they are editing. This normalizes the catalog so each alias belongs to a single
 * owner: the first cat to claim it in canonical order (each breed's default variant first),
 * stripping the duplicate from every later cat. Idempotent — a clean catalog is left untouched.
 *
 * Removal targets the location the alias is actually stored: a variant's own
 * `mentionPatterns`, or the breed-level `mentionPatterns` when the default variant inherits it.
 */
function dedupeCrossMemberMentionPatterns(catalog: CatCafeConfig): boolean {
  let dirty = false;
  const claimed = new Map<string, string>(); // aliasLower -> owner catId
  const breeds = catalog.breeds as unknown as Record<string, unknown>[];

  for (const breed of breeds) {
    const breedCatId = typeof breed.catId === 'string' ? breed.catId : undefined;
    const defaultVariantId = typeof breed.defaultVariantId === 'string' ? breed.defaultVariantId : undefined;
    const variants = Array.isArray(breed.variants) ? (breed.variants as Record<string, unknown>[]) : [];
    // Iterate the default variant first so it claims breed-shared aliases; stored
    // array order is preserved (we sort a shallow copy, not breed.variants itself).
    const ordered = [...variants].sort(
      (a, b) => (a.id === defaultVariantId ? 0 : 1) - (b.id === defaultVariantId ? 0 : 1),
    );

    for (const variant of ordered) {
      const catId = (typeof variant.catId === 'string' && variant.catId) || breedCatId;
      if (!catId) continue;
      const isDefault = variant.id === defaultVariantId;
      const ownPatterns = Array.isArray(variant.mentionPatterns) ? (variant.mentionPatterns as unknown[]) : undefined;

      let target: Record<string, unknown>;
      let sourceArray: unknown[];
      if (ownPatterns && ownPatterns.length > 0) {
        target = variant;
        sourceArray = ownPatterns;
      } else if (isDefault && Array.isArray(breed.mentionPatterns)) {
        target = breed;
        sourceArray = breed.mentionPatterns as unknown[];
      } else {
        // Non-default variant with no own patterns resolves to the synthetic `@catId`.
        claimed.set(`@${catId}`.toLowerCase(), catId);
        continue;
      }

      const kept: unknown[] = [];
      let changed = false;
      for (const raw of sourceArray) {
        if (typeof raw !== 'string') {
          kept.push(raw);
          continue;
        }
        const key = raw.toLowerCase();
        const owner = claimed.get(key);
        if (owner !== undefined && owner !== catId) {
          changed = true; // duplicate already owned by an earlier cat — drop it
          continue;
        }
        claimed.set(key, catId);
        kept.push(raw);
      }
      if (changed) {
        target.mentionPatterns = kept;
        dirty = true;
      }
    }
  }

  return dirty;
}

/**
 * clowder-ai#340: One-time catalog variant migration — rewrites file on disk then never runs again.
 *   1. old `provider` (clientId value) → `clientId` (P5 field rename)
 *   2. old `ocProviderName` → `provider` (P5 field rename)
 *   3. old `providerProfileId` → `accountRef` (P5 field rename)
 *   4. drop legacy variants whose catId is now a standalone top-level breed
 *      (e.g. `ragdoll.variants[opus-47]` after opus-47 was promoted to its own breed) —
 *      otherwise toAllCatConfigs throws Duplicate catId on startup.
 *
 * `externalStandaloneBreedIds` lets the caller surface breed.ids from the template
 * even when the runtime catalog hasn't picked them up yet — without it, a legacy
 * catalog merged with a new-shape template still trips the duplicate-catId crash.
 *
 * Bootstrap creates an empty catalog; template breeds are used as a menu when adding members.
 */
function migrateCatalogVariants(
  catalog: CatCafeConfig,
  externalStandaloneBreedIds?: ReadonlySet<string>,
  template?: CatCafeConfig,
): { catalog: CatCafeConfig; dirty: boolean } {
  let dirty = false;
  const next = structuredClone(catalog) as CatCafeConfig;

  // Step 4 prep: union the catalog's own breed ids with any external ones (template)
  // so legacy variants are dropped even when the catalog itself hasn't grown the new breed yet.
  const standaloneBreedIds = new Set<string>(externalStandaloneBreedIds ?? []);
  for (const breed of next.breeds as unknown as Record<string, unknown>[]) {
    if (typeof breed.id === 'string') standaloneBreedIds.add(breed.id);
  }

  for (const breed of next.breeds as unknown as Record<string, unknown>[]) {
    const variants = Array.isArray(breed.variants) ? (breed.variants as Record<string, unknown>[]) : [];
    for (const variant of variants) {
      // P5 step 1: old `provider` holding a ClientId value → `clientId`
      if (typeof variant.provider === 'string' && CLIENT_ID_VALUES.has(variant.provider)) {
        if (!variant.clientId) {
          variant.clientId = variant.provider;
          delete variant.provider;
          dirty = true;
        } else if (variant.clientId === variant.provider) {
          // Redundant provider (same as clientId). Only delete if ocProviderName
          // needs to take its place; otherwise keep it so template merge can't
          // leak a stale provider from the base config.
          if (typeof variant.ocProviderName === 'string') {
            delete variant.provider;
            dirty = true;
          }
        }
      }

      // P5 step 2: old `ocProviderName` → `provider`
      if (typeof variant.ocProviderName === 'string' && variant.provider === undefined) {
        variant.provider = variant.ocProviderName;
        delete variant.ocProviderName;
        dirty = true;
      }

      const client = resolveBuiltinClientForProvider((variant.clientId ?? variant.provider) as ClientId);
      if (!client) continue;

      const existingAccountRef = typeof variant.accountRef === 'string' ? variant.accountRef.trim() : '';
      const legacyProfileId = typeof variant.providerProfileId === 'string' ? variant.providerProfileId.trim() : '';

      // P5 step 3: providerProfileId → accountRef
      if (legacyProfileId && !existingAccountRef) {
        variant.accountRef = legacyProfileId;
        delete variant.providerProfileId;
        dirty = true;
        continue;
      }
      if (legacyProfileId) {
        delete variant.providerProfileId;
        dirty = true;
      }

      // clowder-ai#340: Do NOT backfill accountRef for unbound runtime variants.
      // Runtime catalog entries are authoritative; missing accountRef stays missing
      // until the user explicitly binds one in the editor.
    }
  }

  // Step 4: drop legacy variants whose catId now belongs to a standalone top-level breed.
  // Triggered when a cat (e.g. opus-47) was previously a sub-variant of another breed
  // (ragdoll) and later got promoted to its own breed. Without this normalization,
  // toAllCatConfigs() throws Duplicate catId at startup once both forms coexist.
  for (const breed of next.breeds as unknown as Record<string, unknown>[]) {
    const breedId = typeof breed.id === 'string' ? breed.id : undefined;
    const breedDefaultCatId = typeof breed.catId === 'string' ? breed.catId : undefined;
    const variants = Array.isArray(breed.variants) ? (breed.variants as Record<string, unknown>[]) : [];
    if (variants.length === 0) continue;
    const filtered = variants.filter((variant) => {
      const variantCatId = (typeof variant.catId === 'string' ? variant.catId : undefined) ?? breedDefaultCatId;
      if (!variantCatId) return true;
      // Keep variants whose catId matches their own breed's id (legitimate single-variant breed).
      if (variantCatId === breedId) return true;
      // Drop only when catId points to a *different* standalone top-level breed.
      return !standaloneBreedIds.has(variantCatId);
    });
    if (filtered.length !== variants.length) {
      breed.variants = filtered;
      dirty = true;
    }
  }

  if (template) {
    dirty = migrateLegacyPersonaIdentity(next, template) || dirty;
  }

  // Repair legacy cross-member alias duplication (e.g. `@claude` on every Claude
  // variant) so the alias-uniqueness gate can no longer block saving any member.
  dirty = dedupeCrossMemberMentionPatterns(next) || dirty;

  return { catalog: next, dirty };
}

/** One-time migration: strip legacy `source` field from variants. Idempotent.
 *  Template and runtime catalog are independent data sources — source field is obsolete. */
function stripLegacySourceField(catalogPath: string): void {
  let raw: string;
  try {
    raw = readFileSync(catalogPath, 'utf-8');
  } catch {
    return;
  }
  const catalog = JSON.parse(raw) as CatCafeConfig;
  const next = structuredClone(catalog) as CatCafeConfig;
  let dirty = false;
  for (const breed of next.breeds as unknown as Record<string, unknown>[]) {
    const variants = Array.isArray(breed.variants) ? (breed.variants as Record<string, unknown>[]) : [];
    for (const variant of variants) {
      if ('source' in variant) {
        delete variant.source;
        dirty = true;
      }
    }
  }
  if (!dirty) return;
  writeFileAtomic(catalogPath, `${JSON.stringify(next, null, 2)}\n`);
}

const OWNER_ROSTER_KEY = 'owner';

function buildOwnerRosterEntry(): RosterEntry {
  return {
    family: 'owner',
    roles: ['owner'],
    lead: false,
    available: true,
    evaluation: 'co-creator / 大当家',
  };
}

function createEmptyRuntimeCatalog(template: CatCafeConfig): CatCafeConfig {
  const ownerEntry = buildOwnerRosterEntry();
  if ('roster' in template) {
    return {
      ...template,
      breeds: [],
      roster: { [OWNER_ROSTER_KEY]: ownerEntry },
    };
  }
  return {
    ...template,
    breeds: [],
  };
}

/** Ensure the owner entry exists in an existing catalog. Returns true if backfilled. */
function ensureOwnerInRoster(catalogPath: string): boolean {
  let raw: string;
  try {
    raw = readFileSync(catalogPath, 'utf-8');
  } catch {
    return false;
  }
  const catalog = JSON.parse(raw) as CatCafeConfig;
  if (!('roster' in catalog)) return false;
  const roster = catalog.roster as Record<string, unknown>;
  if (roster[OWNER_ROSTER_KEY]) return false;
  roster[OWNER_ROSTER_KEY] = buildOwnerRosterEntry();
  writeFileAtomic(catalogPath, `${JSON.stringify(catalog, null, 2)}\n`);
  return true;
}

export function resolveCatCatalogPath(projectRoot: string): string {
  return safePath(projectRoot, CONFIG_SUBDIR, CAT_CATALOG_FILENAME);
}

/**
 * Best-effort read of breed.id values from a sibling cat-template.json.
 * Returns an empty set if the template is missing or unreadable — migration
 * still works against catalog-only ids in that case.
 */
function readTemplateForCatalogMigration(projectRoot: string): { breedIds: Set<string>; template?: CatCafeConfig } {
  const breedIds = new Set<string>();
  let templateRaw: string;
  try {
    const templatePath = resolveProjectTemplatePath(projectRoot);
    templateRaw = readFileSync(templatePath, 'utf-8');
  } catch {
    return { breedIds };
  }
  try {
    const json = JSON.parse(templateRaw) as CatCafeConfig & { breeds?: Array<{ id?: unknown }> };
    for (const breed of json.breeds ?? []) {
      if (typeof breed.id === 'string') breedIds.add(breed.id);
    }
    return { breedIds, template: json as CatCafeConfig };
  } catch {
    // Malformed template — treat as no external ids.
  }
  return { breedIds };
}

export function readCatCatalogRaw(projectRoot: string): string | null {
  const catalogPath = resolveCatCatalogPath(projectRoot);
  if (!existsSync(catalogPath)) return null;
  const raw = readFileSync(catalogPath, 'utf-8');
  try {
    const parsed = JSON.parse(raw) as CatCafeConfig;
    // Hand the migration template breed.ids so it can detect legacy variants
    // that were promoted to standalone breeds in template but not yet here.
    const { breedIds: templateBreedIds, template } = readTemplateForCatalogMigration(projectRoot);
    const migrated = migrateCatalogVariants(parsed, templateBreedIds, template);
    if (migrated.dirty) {
      const nextRaw = `${JSON.stringify(migrated.catalog, null, 2)}\n`;
      writeFileAtomic(catalogPath, nextRaw);
      return nextRaw;
    }
  } catch {
    // Leave invalid JSON handling to the loader so callers see the original parse error.
  }
  return raw;
}

export function readCatCatalog(projectRoot: string): CatCafeConfig | null {
  const raw = readCatCatalogRaw(projectRoot);
  if (raw === null) return null;
  return JSON.parse(raw) as CatCafeConfig;
}

function readBootstrapSourceConfig(templatePath: string): { catalog: CatCafeConfig; sourcePath: string } {
  return {
    catalog: JSON.parse(readFileSync(templatePath, 'utf-8')) as CatCafeConfig,
    sourcePath: templatePath,
  };
}

// NOTE: Repairing existing empty catalogs (e.g. Windows reinstall where user-data
// dir survives) is intentionally NOT done here — we cannot distinguish "broken
// install with empty breeds" from "user intentionally deleted all members".
// Existing-install repair needs a separate mechanism (e.g. _bootstrapVersion marker).
// See #948 for follow-up.

export function bootstrapCatCatalog(projectRoot: string, templatePath: string): string {
  const catalogPath = resolveCatCatalogPath(projectRoot);
  if (existsSync(catalogPath)) {
    readCatCatalogRaw(projectRoot);
    // Strip legacy source field from variants (obsolete after F171).
    stripLegacySourceField(catalogPath);
    // Ensure owner is always present in roster.
    ensureOwnerInRoster(catalogPath);
    return catalogPath;
  }

  const { catalog: template } = readBootstrapSourceConfig(templatePath);
  const { catalog: migratedCatalog } = migrateCatalogVariants(template);

  // #948: Seed the first breed from the template so the app starts with at least
  // one usable member. Without this, the registry is empty and the frontend
  // crashes before the first-run wizard is reachable.
  // In dev environments (template has no breeds), start empty — developers use
  // the wizard or manual config to add members.
  const seedBreed = pickSeedBreed(migratedCatalog);

  let runtimeCatalog: CatCafeConfig;
  if (seedBreed) {
    const seedBreeds = [seedBreed as CatCafeConfig['breeds'][number]];
    runtimeCatalog = {
      ...migratedCatalog,
      breeds: seedBreeds,
    };
    if ('roster' in runtimeCatalog) {
      (runtimeCatalog as { roster: Record<string, RosterEntry> }).roster = pruneRosterToRuntimeBreeds(
        runtimeCatalog.roster as Record<string, RosterEntry>,
        seedBreeds as RuntimeBreedWithCatIds[],
        OWNER_ROSTER_KEY,
        buildOwnerRosterEntry(),
      );
    }
  } else {
    // Template has no breeds — start empty (first-run wizard guides member addition).
    runtimeCatalog = createEmptyRuntimeCatalog(migratedCatalog);
  }

  mkdirSync(dirname(catalogPath), { recursive: true });
  writeFileAtomic(catalogPath, `${JSON.stringify(runtimeCatalog, null, 2)}\n`);
  return catalogPath;
}

export function writeCatCatalog(projectRoot: string, catalog: CatCafeConfig): string {
  const catalogPath = resolveCatCatalogPath(projectRoot);
  mkdirSync(dirname(catalogPath), { recursive: true });
  writeFileAtomic(catalogPath, `${JSON.stringify(catalog, null, 2)}\n`);
  return catalogPath;
}
