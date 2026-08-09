import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, beforeEach, describe, it } from 'node:test';

const { bootstrapCatCatalog, resolveCatCatalogPath, writeCatCatalog } = await import(
  '../dist/config/cat-catalog-store.js'
);
const { createRuntimeCat, deleteRuntimeCat, readRuntimeCatCatalog, updateRuntimeCat } = await import(
  '../dist/config/runtime-cat-catalog.js'
);
const { getAcpConfig, _resetCachedConfig } = await import('../dist/config/cat-config-loader.js');

function validConfig() {
  return {
    version: 2,
    breeds: [
      {
        id: 'ragdoll',
        catId: 'opus',
        name: '布偶猫',
        displayName: '布偶猫',
        avatar: '/avatars/opus.png',
        color: { primary: '#9B7EBD', secondary: '#E8DFF5' },
        mentionPatterns: ['@opus', '@布偶猫'],
        roleDescription: '主架构师',
        defaultVariantId: 'opus-default',
        variants: [
          {
            id: 'opus-default',
            provider: 'anthropic',
            defaultModel: 'claude-sonnet-4-5-20250929',
            mcpSupport: true,
            cli: { command: 'claude', outputFormat: 'stream-json' },
          },
        ],
      },
    ],
    roster: {
      opus: {
        family: 'ragdoll',
        roles: ['architect'],
        lead: true,
        available: true,
        evaluation: 'primary',
      },
    },
    reviewPolicy: {
      requireDifferentFamily: true,
      preferActiveInThread: true,
      preferLead: true,
      excludeUnavailable: true,
    },
    coCreator: {
      name: 'Co-worker',
      aliases: ['共创伙伴'],
      mentionPatterns: ['@co-worker', '@owner'],
    },
  };
}

/**
 * Resolve each variant's effective mention patterns the same way toAllCatConfigs does,
 * then map alias (lowercased) -> unique owner catIds. Used to assert cross-member
 * alias uniqueness on the persisted catalog.
 */
function collectAliasOwners(config) {
  const owners = new Map();
  for (const breed of config.breeds ?? []) {
    const dv = breed.defaultVariantId;
    for (const v of breed.variants ?? []) {
      const catId = v.catId ?? breed.catId;
      const isDef = v.id === dv;
      const mp =
        v.mentionPatterns && v.mentionPatterns.length > 0
          ? v.mentionPatterns
          : isDef
            ? (breed.mentionPatterns ?? [])
            : [`@${catId}`];
      for (const p of mp) {
        const key = p.toLowerCase();
        const arr = owners.get(key) ?? [];
        if (!arr.includes(catId)) arr.push(catId);
        owners.set(key, arr);
      }
    }
  }
  return owners;
}

/** catId -> resolved (effective) mention patterns array. */
function resolvedMentionByCatId(config) {
  const map = new Map();
  for (const breed of config.breeds ?? []) {
    const dv = breed.defaultVariantId;
    for (const v of breed.variants ?? []) {
      const catId = v.catId ?? breed.catId;
      const isDef = v.id === dv;
      const mp =
        v.mentionPatterns && v.mentionPatterns.length > 0
          ? v.mentionPatterns
          : isDef
            ? (breed.mentionPatterns ?? [])
            : [`@${catId}`];
      map.set(catId, mp);
    }
  }
  return map;
}

function makeF127BootstrapTemplate() {
  return {
    version: 2,
    breeds: [
      {
        id: 'ragdoll',
        catId: 'opus',
        name: '布偶猫',
        displayName: '布偶猫',
        avatar: '/avatars/opus.png',
        color: { primary: '#9B7EBD', secondary: '#E8DFF5' },
        mentionPatterns: ['@opus', '@布偶猫'],
        roleDescription: 'Claude 系主力',
        defaultVariantId: 'opus-default',
        variants: [
          {
            id: 'opus-default',
            provider: 'anthropic',
            defaultModel: 'claude-opus-4-6',
            mcpSupport: true,
            cli: { command: 'claude', outputFormat: 'stream-json' },
          },
          {
            id: 'opus-sonnet',
            catId: 'sonnet',
            displayName: '布偶猫',
            mentionPatterns: ['@sonnet'],
            provider: 'anthropic',
            defaultModel: 'claude-sonnet-4',
            mcpSupport: true,
            cli: { command: 'claude', outputFormat: 'stream-json' },
          },
        ],
      },
      {
        id: 'maine-coon',
        catId: 'codex',
        name: '缅因猫',
        displayName: '缅因猫',
        avatar: '/avatars/codex.png',
        color: { primary: '#5B8C5A', secondary: '#D4E6D3' },
        mentionPatterns: ['@codex', '@缅因猫'],
        roleDescription: 'Codex 系主力',
        defaultVariantId: 'codex-default',
        variants: [
          {
            id: 'codex-default',
            provider: 'openai',
            defaultModel: 'gpt-5.4',
            mcpSupport: true,
            cli: { command: 'codex', outputFormat: 'json' },
          },
          {
            id: 'codex-spark',
            catId: 'spark',
            displayName: '缅因猫',
            mentionPatterns: ['@spark'],
            provider: 'openai',
            defaultModel: 'gpt-5.3-codex-spark',
            mcpSupport: true,
            cli: { command: 'codex', outputFormat: 'json' },
          },
        ],
      },
      {
        id: 'siamese',
        catId: 'gemini',
        name: '暹罗猫',
        displayName: '暹罗猫',
        avatar: '/avatars/gemini.png',
        color: { primary: '#5B9BD5', secondary: '#D6E9F8' },
        mentionPatterns: ['@gemini', '@暹罗猫'],
        roleDescription: 'Gemini 系主力',
        defaultVariantId: 'gemini-default',
        variants: [
          {
            id: 'gemini-default',
            provider: 'google',
            defaultModel: 'gemini-3.1-pro',
            mcpSupport: true,
            cli: { command: 'gemini', outputFormat: 'stream-json' },
          },
        ],
      },
      {
        id: 'dragon-li',
        catId: 'dare',
        name: '狸花猫',
        displayName: '狸花猫',
        avatar: '/avatars/dare.png',
        color: { primary: '#6B7280', secondary: '#E5E7EB' },
        mentionPatterns: ['@dare', '@狸花猫'],
        roleDescription: 'Dare 框架猫',
        defaultVariantId: 'dare-default',
        variants: [
          {
            id: 'dare-default',
            provider: 'dare',
            defaultModel: 'glm-4.7',
            mcpSupport: true,
            cli: { command: 'dare', outputFormat: 'json' },
          },
        ],
      },
      {
        id: 'golden-chinchilla',
        catId: 'opencode',
        name: '金渐层',
        displayName: '金渐层',
        avatar: '/avatars/opencode.png',
        color: { primary: '#C08457', secondary: '#FDE7D3' },
        mentionPatterns: ['@opencode', '@金渐层'],
        roleDescription: 'OpenCode',
        defaultVariantId: 'opencode-default',
        variants: [
          {
            id: 'opencode-default',
            provider: 'opencode',
            defaultModel: 'claude-opus-4-6',
            mcpSupport: true,
            cli: { command: 'opencode', outputFormat: 'json' },
          },
        ],
      },
    ],
    roster: {
      opus: { family: 'ragdoll', roles: ['architect'], lead: true, available: true, evaluation: 'claude' },
      sonnet: { family: 'ragdoll', roles: ['assistant'], lead: false, available: true, evaluation: 'claude-2' },
      codex: { family: 'maine-coon', roles: ['reviewer'], lead: true, available: true, evaluation: 'codex' },
      spark: { family: 'maine-coon', roles: ['coder'], lead: false, available: true, evaluation: 'spark' },
      gemini: { family: 'siamese', roles: ['designer'], lead: true, available: true, evaluation: 'gemini' },
      dare: { family: 'dragon-li', roles: ['coding'], lead: true, available: true, evaluation: 'dare' },
      opencode: { family: 'golden-chinchilla', roles: ['coding'], lead: true, available: true, evaluation: 'opencode' },
    },
    reviewPolicy: {
      requireDifferentFamily: true,
      preferActiveInThread: true,
      preferLead: true,
      excludeUnavailable: true,
    },
    coCreator: {
      name: 'Co-worker',
      aliases: ['共创伙伴'],
      mentionPatterns: ['@co-worker', '@owner'],
    },
  };
}

function makeSiblingTemplate(seedCatId) {
  const config = validConfig();
  config.breeds[0].catId = seedCatId;
  config.breeds[0].displayName = '影子猫';
  config.breeds[0].mentionPatterns = [`@${seedCatId}`];
  config.roster = {
    [seedCatId]: {
      family: 'ragdoll',
      roles: ['architect'],
      lead: true,
      available: true,
      evaluation: 'shadow',
    },
  };
  return config;
}

describe('cat-catalog-store', () => {
  // Isolate provider profiles to a clean tmpdir so tests don't read from ~/.cat-cafe/
  let savedGlobalRoot;
  const isolationRoot = mkdtempSync(join(tmpdir(), 'cat-catalog-store-isolation-'));
  before(() => {
    savedGlobalRoot = process.env.CAT_CAFE_GLOBAL_CONFIG_ROOT;
    process.env.CAT_CAFE_GLOBAL_CONFIG_ROOT = isolationRoot;
  });
  beforeEach(() => {
    process.env.CAT_CAFE_GLOBAL_CONFIG_ROOT = isolationRoot;
  });
  after(() => {
    if (savedGlobalRoot === undefined) delete process.env.CAT_CAFE_GLOBAL_CONFIG_ROOT;
    else process.env.CAT_CAFE_GLOBAL_CONFIG_ROOT = savedGlobalRoot;
  });

  it('bootstraps with one seed breed from template (#948)', () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'cat-catalog-store-f127-default-'));
    const templatePath = join(projectRoot, 'cat-template.json');
    const template = makeF127BootstrapTemplate();
    writeFileSync(templatePath, JSON.stringify(template, null, 2));

    const catalogPath = bootstrapCatCatalog(projectRoot, templatePath);
    const runtimeCatalog = JSON.parse(readFileSync(catalogPath, 'utf-8'));

    // #948: New catalogs seed the first breed from template so the app starts
    // with at least one usable member (empty registry crashes before wizard).
    assert.equal(runtimeCatalog.breeds.length, 1, 'should seed exactly one breed');
    assert.equal(runtimeCatalog.breeds[0].id, 'ragdoll', 'seed breed should be the first template breed');
    assert.deepEqual(runtimeCatalog.roster?.owner, {
      family: 'owner',
      roles: ['owner'],
      lead: false,
      available: true,
      evaluation: 'co-creator / 大当家',
    });
    assert.deepEqual(
      Object.keys(runtimeCatalog.roster ?? {}).sort(),
      ['opus', 'owner', 'sonnet'],
      'seeded catalog roster should only expose registered runtime cats plus owner',
    );
    // Non-breed config (reviewPolicy, coCreator) is preserved from template.
    assert.deepEqual(runtimeCatalog.reviewPolicy, template.reviewPolicy);
    assert.deepEqual(runtimeCatalog.coCreator, template.coCreator);
  });

  it('creates catalog file at .cat-cafe/cat-catalog.json', () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'cat-catalog-store-'));
    const templatePath = join(projectRoot, 'cat-template.json');
    writeFileSync(templatePath, JSON.stringify(validConfig(), null, 2));

    const catalogPath = bootstrapCatCatalog(projectRoot, templatePath);
    assert.equal(catalogPath, resolveCatCatalogPath(projectRoot));
    assert.ok(existsSync(catalogPath), 'runtime catalog should be created');
  });

  it('keeps existing .cat-cafe/cat-catalog.json runtime edits and leaves unbound variants alone', () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'cat-catalog-store-'));
    const templatePath = join(projectRoot, 'cat-template.json');
    writeFileSync(templatePath, JSON.stringify(validConfig(), null, 2));

    const runtimeConfig = validConfig();
    runtimeConfig.breeds[0].displayName = '运行时布偶猫';
    mkdirSync(join(projectRoot, '.cat-cafe'), { recursive: true });
    writeFileSync(join(projectRoot, '.cat-cafe', 'cat-catalog.json'), JSON.stringify(runtimeConfig, null, 2));

    const catalogPath = bootstrapCatCatalog(projectRoot, templatePath);
    const hydrated = JSON.parse(readFileSync(catalogPath, 'utf-8'));
    assert.equal(hydrated.breeds[0]?.displayName, '运行时布偶猫');
    // clowder-ai#340: migration does NOT backfill accountRef — unbound variants stay unbound
    assert.equal(hydrated.breeds[0]?.variants[0]?.accountRef, undefined);
  });

  it('migrates legacy persona identity to model member defaults while preserving runtime bindings', () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'cat-catalog-store-member-migration-'));
    const templatePath = join(projectRoot, 'cat-template.json');
    const template = validConfig();
    template.breeds[0].name = 'Claude';
    template.breeds[0].displayName = 'Claude';
    template.breeds[0].nickname = 'Opus';
    template.breeds[0].avatar = '/avatars/claude.svg';
    template.breeds[0].mentionPatterns = ['@opus', '@claude'];
    template.breeds[0].roleDescription = 'Claude 模型家族，适合复杂推理。';
    template.breeds[0].teamStrengths = '复杂推理、架构判断';
    template.breeds[0].modelFamily = 'claude';
    template.breeds[0].modelLine = 'Opus';
    template.breeds[0].capabilityLevel = 3;
    template.breeds[0].runtimeClient = 'Claude CLI';
    template.breeds[0].variants[0].displayName = 'Claude';
    template.breeds[0].variants[0].variantLabel = 'Opus';
    template.breeds[0].variants[0].nickname = 'Opus';
    template.breeds[0].variants[0].avatar = '/avatars/claude.svg';
    template.breeds[0].variants[0].mentionPatterns = ['@opus', '@claude'];
    template.breeds[0].variants[0].teamStrengths = '复杂推理、架构判断';
    template.breeds[0].variants[0].modelFamily = 'claude';
    template.breeds[0].variants[0].modelLine = 'Opus';
    template.breeds[0].variants[0].capabilityLevel = 3;
    template.breeds[0].variants[0].runtimeClient = 'Claude CLI';
    writeFileSync(templatePath, JSON.stringify(template, null, 2));

    const runtimeConfig = validConfig();
    runtimeConfig.breeds[0].nickname = '宪宪';
    runtimeConfig.breeds[0].mentionPatterns = ['@opus', '@布偶猫', '@宪宪'];
    runtimeConfig.breeds[0].variants[0].displayName = '布偶猫';
    runtimeConfig.breeds[0].variants[0].accountRef = 'lancestuart-us-icloud-com';
    runtimeConfig.breeds[0].variants[0].defaultModel = 'claude-opus-4-8';
    mkdirSync(join(projectRoot, '.cat-cafe'), { recursive: true });
    writeFileSync(join(projectRoot, '.cat-cafe', 'cat-catalog.json'), JSON.stringify(runtimeConfig, null, 2));

    const catalogPath = bootstrapCatCatalog(projectRoot, templatePath);
    const hydrated = JSON.parse(readFileSync(catalogPath, 'utf-8'));
    const breed = hydrated.breeds[0];
    const variant = breed.variants[0];

    assert.equal(breed.displayName, 'Claude');
    assert.equal(breed.nickname, 'Opus');
    assert.deepEqual(breed.mentionPatterns, ['@opus', '@claude']);
    assert.equal(breed.avatar, '/avatars/claude.svg');
    assert.equal(breed.modelFamily, 'claude');
    assert.equal(variant.displayName, 'Claude');
    assert.equal(variant.nickname, 'Opus');
    assert.equal(variant.accountRef, 'lancestuart-us-icloud-com');
    assert.equal(variant.defaultModel, 'claude-opus-4-8');
  });

  it('deduplicates cross-member mention aliases so each alias routes to exactly one cat', () => {
    // Repro of the real corruption: "@claude" duplicated across all 4 Claude-family
    // variants (and "@claude-opus" across 2) blocks POST/PATCH /api/cats because the
    // alias-uniqueness gate reports "别名 @claude 已被成员 X 使用" for any of them.
    const projectRoot = mkdtempSync(join(tmpdir(), 'cat-catalog-store-alias-dedup-'));
    const templatePath = join(projectRoot, 'cat-template.json');
    // Non-legacy template so the persona-identity migration stays out of the way.
    writeFileSync(templatePath, JSON.stringify(validConfig(), null, 2));

    const runtimeConfig = validConfig();
    runtimeConfig.breeds[0].name = 'Claude';
    runtimeConfig.breeds[0].displayName = 'Claude';
    runtimeConfig.breeds[0].nickname = 'Opus';
    runtimeConfig.breeds[0].mentionPatterns = ['@opus', '@claude', '@claude-opus'];
    const cli = { command: 'claude', outputFormat: 'stream-json' };
    runtimeConfig.breeds[0].variants = [
      {
        id: 'opus-default',
        clientId: 'anthropic',
        defaultModel: 'claude-opus-4-8',
        mcpSupport: true,
        cli,
        mentionPatterns: ['@claude', '@claude-opus'],
      },
      {
        id: 'opus-sonnet',
        catId: 'sonnet',
        displayName: 'Claude',
        clientId: 'anthropic',
        defaultModel: 'claude-sonnet-4-6',
        mcpSupport: true,
        cli,
        mentionPatterns: ['@sonnet', '@claude', '@claude-sonnet'],
      },
      {
        id: 'opus-45',
        catId: 'opus-45',
        displayName: 'Claude',
        clientId: 'anthropic',
        defaultModel: 'claude-opus-4-5',
        mcpSupport: true,
        cli,
        mentionPatterns: ['@opus45', '@opus-45', '@claude', '@claude-opus'],
      },
      {
        id: 'fable-5',
        catId: 'fable-5',
        displayName: 'Claude',
        clientId: 'anthropic',
        defaultModel: 'claude-fable-5',
        mcpSupport: true,
        cli,
        mentionPatterns: ['@fable5', '@fable-5', '@claude-fable-5', '@claude', '@claude-fable'],
      },
    ];
    const secondary = {
      family: 'ragdoll',
      roles: ['developer'],
      lead: false,
      available: true,
      evaluation: 'secondary',
    };
    runtimeConfig.roster = {
      ...runtimeConfig.roster,
      sonnet: secondary,
      'opus-45': secondary,
      'fable-5': secondary,
    };
    mkdirSync(join(projectRoot, '.cat-cafe'), { recursive: true });
    writeFileSync(join(projectRoot, '.cat-cafe', 'cat-catalog.json'), JSON.stringify(runtimeConfig, null, 2));

    const catalogPath = bootstrapCatCatalog(projectRoot, templatePath);
    const hydrated = JSON.parse(readFileSync(catalogPath, 'utf-8'));

    // 1) No alias may route to more than one cat.
    const owners = collectAliasOwners(hydrated);
    for (const [alias, cats] of owners) {
      assert.equal(cats.length, 1, `alias ${alias} must route to exactly one cat, got [${cats.join(', ')}]`);
    }
    // 2) Duplicated aliases stay with the canonical owner (default variant = opus).
    assert.deepEqual(owners.get('@claude'), ['opus']);
    assert.deepEqual(owners.get('@claude-opus'), ['opus']);
    // 3) Each variant keeps its own distinct aliases.
    const byCat = resolvedMentionByCatId(hydrated);
    assert.ok(byCat.get('sonnet').includes('@sonnet') && byCat.get('sonnet').includes('@claude-sonnet'));
    assert.ok(!byCat.get('sonnet').includes('@claude'), 'sonnet must no longer carry @claude');
    assert.ok(byCat.get('opus-45').includes('@opus45') && byCat.get('opus-45').includes('@opus-45'));
    assert.ok(!byCat.get('opus-45').includes('@claude') && !byCat.get('opus-45').includes('@claude-opus'));
    assert.ok(byCat.get('fable-5').includes('@claude-fable-5') && byCat.get('fable-5').includes('@fable5'));
    assert.ok(!byCat.get('fable-5').includes('@claude'), 'fable-5 must no longer carry @claude');
    // 4) opus keeps its aliases.
    assert.ok(byCat.get('opus').includes('@claude') && byCat.get('opus').includes('@claude-opus'));

    // 5) Idempotent: a second bootstrap leaves the persisted file byte-identical.
    const afterFirst = readFileSync(catalogPath, 'utf-8');
    bootstrapCatCatalog(projectRoot, templatePath);
    assert.equal(readFileSync(catalogPath, 'utf-8'), afterFirst, 'dedup migration must be idempotent');
  });

  it('keeps existing custom runtime cats unbound during catalog migration', () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'cat-catalog-store-custom-runtime-'));
    const templatePath = join(projectRoot, 'cat-template.json');
    writeFileSync(templatePath, JSON.stringify(validConfig(), null, 2));

    const runtimeConfig = validConfig();
    runtimeConfig.breeds.push({
      id: 'custom-openai',
      catId: 'custom-openai',
      name: '自定义猫',
      displayName: '自定义猫',
      avatar: '/avatars/custom.png',
      color: { primary: '#22c55e', secondary: '#dcfce7' },
      mentionPatterns: ['@custom-openai'],
      roleDescription: '自定义运行时猫',
      defaultVariantId: 'custom-openai-default',
      variants: [
        {
          id: 'custom-openai-default',
          provider: 'openai',
          defaultModel: 'gpt-5.4-mini',
          mcpSupport: false,
          cli: { command: 'codex', outputFormat: 'json' },
        },
      ],
    });
    runtimeConfig.roster['custom-openai'] = {
      family: 'custom-openai',
      roles: ['assistant'],
      lead: false,
      available: true,
      evaluation: 'runtime custom',
    };

    mkdirSync(join(projectRoot, '.cat-cafe'), { recursive: true });
    writeFileSync(join(projectRoot, '.cat-cafe', 'cat-catalog.json'), JSON.stringify(runtimeConfig, null, 2));

    const catalogPath = bootstrapCatCatalog(projectRoot, templatePath);
    const hydrated = JSON.parse(readFileSync(catalogPath, 'utf-8'));
    const customBreed = hydrated.breeds.find((breed) => breed.catId === 'custom-openai');
    assert.ok(customBreed, 'custom runtime breed should be preserved');
    assert.equal(customBreed?.variants[0]?.accountRef, undefined);
  });

  it('creates a new runtime member without corrupting v2 top-level fields', async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'cat-catalog-store-'));
    const templatePath = join(projectRoot, 'cat-template.json');
    writeFileSync(templatePath, JSON.stringify(validConfig(), null, 2));
    writeCatCatalog(projectRoot, validConfig());

    await createRuntimeCat(projectRoot, {
      catId: 'spark-lite',
      breedId: 'spark-lite',
      name: '火花猫',
      displayName: '火花猫',
      avatar: '/avatars/spark.png',
      color: { primary: '#f97316', secondary: '#fed7aa' },
      mentionPatterns: ['@spark-lite', '@火花猫'],
      roleDescription: '快速执行',
      personality: '利落',
      clientId: 'openai',
      defaultModel: 'gpt-5.4-mini',
      mcpSupport: false,
      cli: { command: 'codex', outputFormat: 'json' },
    });

    const catalog = readRuntimeCatCatalog(projectRoot);
    assert.equal(catalog.version, 2);
    assert.equal(catalog.coCreator?.name, 'Co-worker');
    assert.equal(catalog.reviewPolicy?.preferLead, true);
    assert.ok(catalog.roster?.opus, 'existing roster must be preserved');
    assert.deepEqual(catalog.roster?.['spark-lite'], {
      family: 'spark-lite',
      roles: ['assistant'],
      lead: false,
      available: true,
      evaluation: '火花猫 runtime member',
    });
    const created = catalog.breeds.find((breed) => breed.catId === 'spark-lite');
    assert.ok(created, 'spark-lite breed should be created');
    assert.equal(created.displayName, '火花猫');
    assert.deepEqual(created.mentionPatterns, ['@spark-lite', '@火花猫']);
    assert.equal(created.variants[0]?.clientId, 'openai');
  });

  it('persists voiceConfig when creating a runtime member', async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'cat-catalog-store-'));
    const templatePath = join(projectRoot, 'cat-template.json');
    writeFileSync(templatePath, JSON.stringify(validConfig(), null, 2));
    writeCatCatalog(projectRoot, validConfig());

    await createRuntimeCat(projectRoot, {
      catId: 'voice-cat',
      breedId: 'voice-cat',
      name: '声音猫',
      displayName: '声音猫',
      avatar: '/avatars/voice.png',
      color: { primary: '#0f766e', secondary: '#ccfbf1' },
      mentionPatterns: ['@voice-cat'],
      roleDescription: '声音配置验证',
      clientId: 'openai',
      defaultModel: 'gpt-5.4',
      mcpSupport: true,
      cli: { command: 'codex', outputFormat: 'json' },
      voiceConfig: {
        voice: 'clone-voice',
        langCode: 'zh',
        refAudio: '/uploads/ref-audio-1234-abcd.wav',
        refText: '参考文本',
        instruct: 'calm',
        speed: 1.1,
      },
    });

    const catalog = readRuntimeCatCatalog(projectRoot);
    const created = catalog.breeds.find((breed) => breed.catId === 'voice-cat');
    assert.ok(created, 'voice-cat breed should be created');
    assert.deepEqual(created.variants[0]?.voiceConfig, {
      voice: 'clone-voice',
      langCode: 'zh',
      refAudio: '/uploads/ref-audio-1234-abcd.wav',
      refText: '参考文本',
      instruct: 'calm',
      speed: 1.1,
    });
  });

  it('persists and clears agyProfile for runtime Google members', async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'cat-catalog-store-'));
    const templatePath = join(projectRoot, 'cat-template.json');
    writeFileSync(templatePath, JSON.stringify(validConfig(), null, 2));
    writeCatCatalog(projectRoot, validConfig());

    await createRuntimeCat(projectRoot, {
      catId: 'agy-cat',
      breedId: 'agy-cat',
      name: 'AGY猫',
      displayName: 'AGY猫',
      avatar: '/avatars/gemini.png',
      color: { primary: '#2563eb', secondary: '#dbeafe' },
      mentionPatterns: ['@agy-cat'],
      roleDescription: 'AGY profile config validation',
      clientId: 'google',
      defaultModel: 'gemini-3.5-flash',
      mcpSupport: true,
      cli: { command: 'gemini', outputFormat: 'stream-json' },
      agyProfile: {
        enabled: true,
        profileId: 'siamese-gemini35',
        model: 'Gemini 3.5 Flash (High)',
        trustedWorkspaces: [projectRoot],
        autoApprove: false,
      },
    });

    let catalog = readRuntimeCatCatalog(projectRoot);
    let created = catalog.breeds.find((breed) => breed.catId === 'agy-cat');
    assert.ok(created, 'agy-cat breed should be created');
    assert.deepEqual(created.variants[0]?.agyProfile, {
      enabled: true,
      profileId: 'siamese-gemini35',
      model: 'Gemini 3.5 Flash (High)',
      trustedWorkspaces: [projectRoot],
      autoApprove: false,
    });

    await updateRuntimeCat(projectRoot, 'agy-cat', { agyProfile: null });

    catalog = readRuntimeCatCatalog(projectRoot);
    created = catalog.breeds.find((breed) => breed.catId === 'agy-cat');
    assert.ok(created, 'agy-cat breed should remain after clearing agyProfile');
    assert.equal(created.variants[0]?.agyProfile, undefined);
  });

  it('updates an existing runtime member in place', async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'cat-catalog-store-'));
    const templatePath = join(projectRoot, 'cat-template.json');
    writeFileSync(templatePath, JSON.stringify(validConfig(), null, 2));
    writeCatCatalog(projectRoot, validConfig());

    await updateRuntimeCat(projectRoot, 'opus', {
      displayName: '运行时布偶猫',
      mentionPatterns: ['@opus', '@布偶猫', '@运行时布偶'],
      defaultModel: 'claude-opus-4-1',
      personality: '更严格',
    });

    const catalog = readRuntimeCatCatalog(projectRoot);
    const updated = catalog.breeds.find((breed) => breed.catId === 'opus');
    assert.ok(updated, 'opus breed should still exist');
    assert.equal(updated.displayName, '运行时布偶猫');
    assert.deepEqual(updated.mentionPatterns, ['@opus', '@布偶猫', '@运行时布偶']);
    assert.equal(updated.variants[0]?.defaultModel, 'claude-opus-4-1');
    assert.equal(updated.variants[0]?.personality, '更严格');
    assert.equal(catalog.coCreator?.mentionPatterns[0], '@co-worker');
  });

  it('persists and clears voiceConfig when updating a runtime member', async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'cat-catalog-store-'));
    const templatePath = join(projectRoot, 'cat-template.json');
    writeFileSync(templatePath, JSON.stringify(validConfig(), null, 2));
    writeCatCatalog(projectRoot, validConfig());

    await updateRuntimeCat(projectRoot, 'opus', {
      voiceConfig: {
        voice: 'updated-clone',
        langCode: 'zh',
        refAudio: '/uploads/ref-audio-5678-efab.mp3',
        refText: '更新后的参考文本',
      },
    });

    let catalog = readRuntimeCatCatalog(projectRoot);
    let updated = catalog.breeds.find((breed) => breed.catId === 'opus');
    assert.ok(updated, 'opus breed should still exist');
    assert.deepEqual(updated.variants[0]?.voiceConfig, {
      voice: 'updated-clone',
      langCode: 'zh',
      refAudio: '/uploads/ref-audio-5678-efab.mp3',
      refText: '更新后的参考文本',
    });

    await updateRuntimeCat(projectRoot, 'opus', { voiceConfig: null });

    catalog = readRuntimeCatCatalog(projectRoot);
    updated = catalog.breeds.find((breed) => breed.catId === 'opus');
    assert.ok(updated, 'opus breed should still exist after clearing voiceConfig');
    assert.equal(updated.variants[0]?.voiceConfig, undefined);
  });

  it('persists acp tombstone when disabling template-inherited ACP transport', async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'cat-catalog-store-'));
    const templatePath = join(projectRoot, 'cat-template.json');
    const template = validConfig();
    template.breeds[0].variants[0].clientId = 'google';
    template.breeds[0].variants[0].acp = { command: 'gemini', startupArgs: ['--acp'] };
    writeFileSync(templatePath, JSON.stringify(template, null, 2));
    writeCatCatalog(projectRoot, template);

    await updateRuntimeCat(projectRoot, 'opus', { clientId: 'openai', acp: null });

    const rawCatalog = JSON.parse(readFileSync(resolveCatCatalogPath(projectRoot), 'utf-8'));
    assert.equal(rawCatalog.breeds[0].variants[0].acp, null, 'runtime overlay must keep an ACP tombstone');

    const saved = process.env.CAT_TEMPLATE_PATH;
    process.env.CAT_TEMPLATE_PATH = templatePath;
    _resetCachedConfig();
    try {
      assert.equal(getAcpConfig('opus'), undefined, 'template ACP must not reappear after runtime acp:null');
    } finally {
      if (saved === undefined) delete process.env.CAT_TEMPLATE_PATH;
      else process.env.CAT_TEMPLATE_PATH = saved;
      _resetCachedConfig();
    }
  });

  it('keeps sessionChain updates scoped to non-default variants', async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'cat-catalog-store-'));
    const templatePath = join(projectRoot, 'cat-template.json');
    const template = validConfig();
    template.breeds[0].features = { sessionChain: true };
    template.breeds[0].variants.push({
      id: 'opus-sonnet',
      catId: 'opus-sonnet',
      provider: 'anthropic',
      defaultModel: 'claude-sonnet-4-5-20250929',
      mcpSupport: true,
      cli: { command: 'claude', outputFormat: 'stream-json' },
    });
    writeFileSync(templatePath, JSON.stringify(template, null, 2));
    writeCatCatalog(projectRoot, template);

    await updateRuntimeCat(projectRoot, 'opus-sonnet', { sessionChain: false });

    const catalog = readRuntimeCatCatalog(projectRoot);
    const breed = catalog.breeds.find((item) => item.id === 'ragdoll');
    assert.ok(breed, 'ragdoll breed should still exist');
    assert.equal(breed.features?.sessionChain, true);
    const sonnetVariant = breed.variants.find((variant) => variant.id === 'opus-sonnet');
    assert.ok(sonnetVariant, 'opus-sonnet variant should still exist');
    assert.equal(sonnetVariant.sessionChain, false);
    const defaultVariant = breed.variants.find((variant) => variant.id === 'opus-default');
    assert.ok(defaultVariant, 'opus-default variant should still exist');
    assert.equal(defaultVariant.sessionChain, undefined);
  });

  it('keeps roleDescription updates scoped to non-default variants', async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'cat-catalog-store-'));
    const templatePath = join(projectRoot, 'cat-template.json');
    const template = validConfig();
    template.breeds[0].variants.push({
      id: 'opus-sonnet',
      catId: 'opus-sonnet',
      provider: 'anthropic',
      defaultModel: 'claude-sonnet-4-5-20250929',
      mcpSupport: true,
      cli: { command: 'claude', outputFormat: 'stream-json' },
    });
    writeFileSync(templatePath, JSON.stringify(template, null, 2));
    writeCatCatalog(projectRoot, template);

    await updateRuntimeCat(projectRoot, 'opus-sonnet', { roleDescription: '副手架构师' });

    const catalog = readRuntimeCatCatalog(projectRoot);
    const breed = catalog.breeds.find((item) => item.id === 'ragdoll');
    assert.ok(breed, 'ragdoll breed should still exist');
    assert.equal(breed.roleDescription, '主架构师');
    const sonnetVariant = breed.variants.find((variant) => variant.id === 'opus-sonnet');
    assert.ok(sonnetVariant, 'opus-sonnet variant should still exist');
    assert.equal(sonnetVariant.roleDescription, '副手架构师');
    const defaultVariant = breed.variants.find((variant) => variant.id === 'opus-default');
    assert.ok(defaultVariant, 'opus-default variant should still exist');
    assert.equal(defaultVariant.roleDescription, undefined);
  });

  it('keeps roleDescription updates scoped to the default variant', async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'cat-catalog-store-'));
    const templatePath = join(projectRoot, 'cat-template.json');
    const template = validConfig();
    template.breeds[0].variants.push({
      id: 'opus-sonnet',
      catId: 'opus-sonnet',
      provider: 'anthropic',
      defaultModel: 'claude-sonnet-4-5-20250929',
      mcpSupport: true,
      cli: { command: 'claude', outputFormat: 'stream-json' },
    });
    writeFileSync(templatePath, JSON.stringify(template, null, 2));
    writeCatCatalog(projectRoot, template);

    await updateRuntimeCat(projectRoot, 'opus', { roleDescription: '默认成员专属职责' });

    const catalog = readRuntimeCatCatalog(projectRoot);
    const breed = catalog.breeds.find((item) => item.id === 'ragdoll');
    assert.ok(breed, 'ragdoll breed should still exist');
    assert.equal(breed.roleDescription, '主架构师');
    const defaultVariant = breed.variants.find((variant) => variant.id === 'opus-default');
    assert.ok(defaultVariant, 'opus-default variant should still exist');
    assert.equal(defaultVariant.roleDescription, '默认成员专属职责');
    const sonnetVariant = breed.variants.find((variant) => variant.id === 'opus-sonnet');
    assert.ok(sonnetVariant, 'opus-sonnet variant should still exist');
    assert.equal(sonnetVariant.roleDescription, undefined);
  });

  it('keeps sessionChain updates scoped to the default variant', async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'cat-catalog-store-'));
    const templatePath = join(projectRoot, 'cat-template.json');
    const template = validConfig();
    template.breeds[0].features = { sessionChain: true };
    template.breeds[0].variants.push({
      id: 'opus-sonnet',
      catId: 'opus-sonnet',
      provider: 'anthropic',
      defaultModel: 'claude-sonnet-4-5-20250929',
      mcpSupport: true,
      cli: { command: 'claude', outputFormat: 'stream-json' },
    });
    writeFileSync(templatePath, JSON.stringify(template, null, 2));
    writeCatCatalog(projectRoot, template);

    await updateRuntimeCat(projectRoot, 'opus', { sessionChain: false });

    const catalog = readRuntimeCatCatalog(projectRoot);
    const breed = catalog.breeds.find((item) => item.id === 'ragdoll');
    assert.ok(breed, 'ragdoll breed should still exist');
    assert.equal(breed.features?.sessionChain, true);
    const defaultVariant = breed.variants.find((variant) => variant.id === 'opus-default');
    assert.ok(defaultVariant, 'opus-default variant should still exist');
    assert.equal(defaultVariant.sessionChain, false);
    const sonnetVariant = breed.variants.find((variant) => variant.id === 'opus-sonnet');
    assert.ok(sonnetVariant, 'opus-sonnet variant should still exist');
    assert.equal(sonnetVariant.sessionChain, undefined);
  });

  it('does not overwrite runtime catalog when validation fails', () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'cat-catalog-store-'));
    const templatePath = join(projectRoot, 'cat-template.json');
    writeFileSync(templatePath, JSON.stringify(validConfig(), null, 2));
    writeCatCatalog(projectRoot, validConfig());

    // Trigger eager migration (F136 Phase 4d backfills accountRef on first read)
    readRuntimeCatCatalog(projectRoot);
    const catalogPath = resolveCatCatalogPath(projectRoot);

    // Empty defaultModel is now allowed (OAuth/subscription CLIs use built-in defaults;
    // api_key accounts are validated at the route level in validateAccountBindingOrThrow).
    updateRuntimeCat(projectRoot, 'opus', { defaultModel: '' });
    const afterRaw = readFileSync(catalogPath, 'utf-8');
    const afterConfig = JSON.parse(afterRaw);
    const variant = afterConfig.breeds[0].variants[0];
    assert.equal(variant.defaultModel, '', 'empty defaultModel should persist for OAuth accounts');
  });

  it('rejects runtime members that reuse an alias from another cat', () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'cat-catalog-store-'));
    const templatePath = join(projectRoot, 'cat-template.json');
    writeFileSync(templatePath, JSON.stringify(validConfig(), null, 2));
    writeCatCatalog(projectRoot, validConfig());

    // Trigger eager migration (F136 Phase 4d backfills accountRef on first read)
    readRuntimeCatCatalog(projectRoot);
    const catalogPath = resolveCatCatalogPath(projectRoot);
    const beforeRaw = readFileSync(catalogPath, 'utf-8');

    assert.throws(() => {
      createRuntimeCat(projectRoot, {
        catId: 'spark-lite',
        breedId: 'spark-lite',
        name: '火花猫',
        displayName: '火花猫',
        avatar: '/avatars/spark.png',
        color: { primary: '#f97316', secondary: '#fed7aa' },
        mentionPatterns: ['@opus', '@spark-lite'],
        roleDescription: '快速执行',
        clientId: 'openai',
        defaultModel: 'gpt-5.4',
        mcpSupport: false,
        cli: { command: 'codex', outputFormat: 'json' },
      });
    }, /mention alias "@opus" is already used by cat "opus"/i);

    const afterRaw = readFileSync(catalogPath, 'utf-8');
    assert.equal(afterRaw, beforeRaw, 'failed create must not mutate runtime catalog');
  });

  it('deletes a runtime-created member without touching the rest of the catalog', async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'cat-catalog-store-'));
    const templatePath = join(projectRoot, 'cat-template.json');
    writeFileSync(templatePath, JSON.stringify(validConfig(), null, 2));
    writeCatCatalog(projectRoot, validConfig());

    await createRuntimeCat(projectRoot, {
      catId: 'temp-cat',
      breedId: 'temp-cat',
      name: '临时猫',
      displayName: '临时猫',
      avatar: '/avatars/temp.png',
      color: { primary: '#64748b', secondary: '#cbd5e1' },
      mentionPatterns: ['@temp-cat'],
      roleDescription: '临时成员',
      personality: '临时',
      clientId: 'dare',
      defaultModel: 'dare-1',
      mcpSupport: false,
      cli: { command: 'dare', outputFormat: 'json' },
    });

    await deleteRuntimeCat(projectRoot, 'temp-cat');

    const catalog = readRuntimeCatCatalog(projectRoot);
    assert.equal(
      catalog.breeds.some((breed) => breed.catId === 'temp-cat'),
      false,
    );
    assert.equal(
      catalog.breeds.some((breed) => breed.catId === 'opus'),
      true,
    );
    assert.ok(catalog.roster?.opus, 'existing v2 metadata must stay intact');
  });

  it('allows deletion of any cat regardless of legacy source field', () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'cat-catalog-store-delete-any-'));
    const templatePath = join(projectRoot, 'cat-template.json');
    writeFileSync(templatePath, JSON.stringify(validConfig(), null, 2));
    writeCatCatalog(projectRoot, validConfig());

    deleteRuntimeCat(projectRoot, 'opus');

    const catalog = readRuntimeCatCatalog(projectRoot);
    assert.equal(
      catalog.breeds.some((breed) => breed.catId === 'opus'),
      false,
    );
  });

  it('ignores sibling CAT_TEMPLATE_PATH prefixes during runtime cat operations', async () => {
    const parentRoot = mkdtempSync(join(tmpdir(), 'cat-catalog-store-boundary-'));
    const projectRoot = join(parentRoot, 'clowder-ai');
    const siblingRoot = join(parentRoot, 'clowder-ai-old');
    mkdirSync(projectRoot, { recursive: true });
    mkdirSync(siblingRoot, { recursive: true });

    const templatePath = join(projectRoot, 'cat-template.json');
    const siblingTemplatePath = join(siblingRoot, 'cat-template.json');
    writeFileSync(templatePath, JSON.stringify(validConfig(), null, 2));
    writeFileSync(siblingTemplatePath, JSON.stringify(makeSiblingTemplate('shadow-seed'), null, 2));
    writeCatCatalog(projectRoot, validConfig());

    const previousTemplatePath = process.env.CAT_TEMPLATE_PATH;
    process.env.CAT_TEMPLATE_PATH = siblingTemplatePath;
    try {
      await createRuntimeCat(projectRoot, {
        catId: 'temp-cat',
        breedId: 'temp-cat',
        name: '临时猫',
        displayName: '临时猫',
        avatar: '/avatars/temp.png',
        color: { primary: '#64748b', secondary: '#cbd5e1' },
        mentionPatterns: ['@temp-cat'],
        roleDescription: '临时成员',
        personality: '临时',
        clientId: 'dare',
        defaultModel: 'dare-1',
        mcpSupport: false,
        cli: { command: 'dare', outputFormat: 'json' },
      });
    } finally {
      if (previousTemplatePath === undefined) delete process.env.CAT_TEMPLATE_PATH;
      else process.env.CAT_TEMPLATE_PATH = previousTemplatePath;
    }

    const catalog = readRuntimeCatCatalog(projectRoot);
    assert.equal(
      catalog.breeds.some((breed) => breed.catId === 'opus'),
      true,
      'local catalog breeds should be preserved',
    );
    assert.equal(
      catalog.breeds.some((breed) => breed.catId === 'shadow-seed'),
      false,
      'sibling template must not leak into this project',
    );
  });

  it('does not treat sibling-template seeds as local seeds during delete checks', async () => {
    const parentRoot = mkdtempSync(join(tmpdir(), 'cat-catalog-store-delete-boundary-'));
    const projectRoot = join(parentRoot, 'clowder-ai');
    const siblingRoot = join(parentRoot, 'clowder-ai-old');
    mkdirSync(projectRoot, { recursive: true });
    mkdirSync(siblingRoot, { recursive: true });

    const templatePath = join(projectRoot, 'cat-template.json');
    const siblingTemplatePath = join(siblingRoot, 'cat-template.json');
    writeFileSync(templatePath, JSON.stringify(validConfig(), null, 2));
    writeFileSync(siblingTemplatePath, JSON.stringify(makeSiblingTemplate('shadow-seed'), null, 2));
    writeCatCatalog(projectRoot, validConfig());

    await createRuntimeCat(projectRoot, {
      catId: 'shadow-seed',
      breedId: 'shadow-seed',
      name: '影子临时猫',
      displayName: '影子临时猫',
      avatar: '/avatars/shadow.png',
      color: { primary: '#334155', secondary: '#cbd5f5' },
      mentionPatterns: ['@shadow-seed'],
      roleDescription: '用于路径边界验证',
      clientId: 'dare',
      defaultModel: 'dare-1',
      mcpSupport: false,
      cli: { command: 'dare', outputFormat: 'json' },
    });

    const previousTemplatePath = process.env.CAT_TEMPLATE_PATH;
    process.env.CAT_TEMPLATE_PATH = siblingTemplatePath;
    try {
      await deleteRuntimeCat(projectRoot, 'shadow-seed');
    } finally {
      if (previousTemplatePath === undefined) delete process.env.CAT_TEMPLATE_PATH;
      else process.env.CAT_TEMPLATE_PATH = previousTemplatePath;
    }

    const catalog = readRuntimeCatCatalog(projectRoot);
    assert.equal(
      catalog.breeds.some((breed) => breed.catId === 'shadow-seed'),
      false,
      'runtime cat matching a sibling seed id should still be deletable',
    );
  });

  // clowder-ai#340: removed api_key bootstrap model fallback test — filterBootstrapCatalog + bootstrapBindings deleted

  it('drops legacy variants whose catId is a standalone breed in the template', () => {
    // Real-world repro: template has been updated to a new shape (opus-47 promoted to
    // its own top-level breed), but the runtime catalog is still on the *old* shape
    // (opus-47 nested under ragdoll.variants). Without consulting template breed.ids,
    // migration would not detect the legacy variant — toAllCatConfigs() then throws
    // Duplicate catId once template+catalog are deep-merged.
    const projectRoot = mkdtempSync(join(tmpdir(), 'cat-catalog-store-template-driven-'));
    const templatePath = join(projectRoot, 'cat-template.json');

    // Template = new shape with opus-47 as a standalone breed
    const templateConfig = validConfig();
    templateConfig.breeds.push({
      id: 'opus-47',
      catId: 'opus-47',
      name: '布偶猫 Opus 4.7',
      displayName: '布偶猫',
      avatar: '/avatars/opus-47.png',
      color: { primary: '#7B1FA2', secondary: '#E1BEE7' },
      mentionPatterns: ['@opus-47'],
      roleDescription: 'Opus 4.7',
      defaultVariantId: 'opus-47-default',
      variants: [
        {
          id: 'opus-47-default',
          catId: 'opus-47',
          clientId: 'anthropic',
          defaultModel: 'claude-opus-4-7',
          mcpSupport: true,
          cli: { command: 'claude', outputFormat: 'stream-json' },
        },
      ],
    });
    writeFileSync(templatePath, JSON.stringify(templateConfig, null, 2));

    // Runtime catalog = legacy shape — opus-47 still nested under ragdoll, NO standalone breed
    const runtimeConfig = validConfig();
    runtimeConfig.breeds[0].variants.push({
      id: 'legacy-opus-47',
      catId: 'opus-47',
      variantLabel: 'Opus 4.7 (legacy)',
      displayName: '布偶猫',
      mentionPatterns: ['@opus-47'],
      provider: 'anthropic',
      defaultModel: 'claude-opus-4-7',
      mcpSupport: true,
      cli: { command: 'claude', outputFormat: 'stream-json' },
    });
    mkdirSync(join(projectRoot, '.cat-cafe'), { recursive: true });
    writeFileSync(join(projectRoot, '.cat-cafe', 'cat-catalog.json'), JSON.stringify(runtimeConfig, null, 2));

    bootstrapCatCatalog(projectRoot, templatePath);
    const hydrated = JSON.parse(readFileSync(resolveCatCatalogPath(projectRoot), 'utf-8'));

    const ragdoll = hydrated.breeds.find((b) => b.id === 'ragdoll');
    assert.equal(
      ragdoll.variants.find((v) => v.catId === 'opus-47'),
      undefined,
      'legacy ragdoll/variants[opus-47] should be removed because template promoted opus-47 to its own breed',
    );
    // Default variant whose catId matches its own breed must NOT be dropped
    assert.ok(
      ragdoll.variants.find((v) => v.id === 'opus-default'),
      'opus-default (catId matches own breed) should be preserved',
    );
    // Catalog itself does NOT need to grow the standalone breed — deep merge with
    // template will surface it. Migration is purely about removing the legacy duplicate.
    assert.equal(
      hydrated.breeds.find((b) => b.id === 'opus-47'),
      undefined,
      'catalog should not grow the standalone breed by itself; deep merge handles that',
    );
  });
});
