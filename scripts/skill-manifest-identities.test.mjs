import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { collectRosterRoutingIdentifiers, isModelIdentityNickname } from './lib/skill-manifest-identities.mjs';

describe('skill manifest routing identifiers', () => {
  it('does not classify model identity labels as persona nicknames', () => {
    assert.equal(
      isModelIdentityNickname(
        {
          id: 'moonshot',
          catId: 'kimi',
          name: 'Kimi',
          displayName: 'Kimi',
          modelFamily: 'kimi',
          modelLine: 'Code',
          runtimeClient: 'Kimi CLI',
        },
        'Code',
      ),
      true,
    );
    assert.equal(
      isModelIdentityNickname(
        {
          id: 'gemini',
          catId: 'gemini',
          name: 'Gemini',
          displayName: 'Gemini',
          modelFamily: 'gemini',
          modelLine: 'Pro',
          runtimeClient: 'AGY',
        },
        'Gemini Pro',
      ),
      true,
    );
    assert.equal(
      isModelIdentityNickname(
        {
          id: 'maine-coon',
          catId: 'codex',
          name: 'GPT',
          displayName: 'GPT',
          modelFamily: 'gpt',
          modelLine: '5.x',
          runtimeClient: 'Codex CLI',
        },
        '砚砚',
      ),
      false,
    );
  });

  it('keeps handles and genuine persona nicknames in the lint set', () => {
    const result = collectRosterRoutingIdentifiers({
      roster: { codex: {}, kimi: {} },
      breeds: [
        {
          id: 'maine-coon',
          catId: 'codex',
          name: 'GPT',
          displayName: 'GPT',
          nickname: '砚砚',
          modelFamily: 'gpt',
          modelLine: '5.x',
          runtimeClient: 'Codex CLI',
          variants: [{ catId: 'gpt52' }],
        },
        {
          id: 'moonshot',
          catId: 'kimi',
          name: 'Kimi',
          displayName: 'Kimi',
          nickname: 'Code',
          modelFamily: 'kimi',
          modelLine: 'Code',
          runtimeClient: 'Kimi CLI',
        },
      ],
    });

    assert.deepEqual(new Set(result.handles), new Set(['@codex', '@gpt52', '@kimi']));
    assert.deepEqual(result.nicknames, ['砚砚']);
  });
});
