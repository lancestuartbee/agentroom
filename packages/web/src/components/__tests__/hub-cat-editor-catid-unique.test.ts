import { describe, expect, it } from 'vitest';
import { uniqueCatId } from '@/components/hub-cat-editor.model';

const reserved = (...ids: string[]) => new Set(ids.map((id) => id.toLowerCase()));

describe('uniqueCatId', () => {
  it('returns the base unchanged when it does not collide', () => {
    expect(uniqueCatId('opus', reserved('sonnet', 'gemini'))).toBe('opus');
  });

  it('returns the base unchanged when the reserved set is empty', () => {
    expect(uniqueCatId('opus', reserved())).toBe('opus');
  });

  it('appends -2 on the first collision', () => {
    expect(uniqueCatId('opus', reserved('opus'))).toBe('opus-2');
  });

  it('skips to the next free suffix when earlier suffixes are also taken', () => {
    expect(uniqueCatId('opus', reserved('opus', 'opus-2', 'opus-3'))).toBe('opus-4');
  });

  it('detects collisions case-insensitively', () => {
    expect(uniqueCatId('Opus', reserved('opus'))).toBe('Opus-2');
  });

  it('does not suffix when a similarly-prefixed but distinct id exists', () => {
    // "opusx" must not be treated as a collision with "opus".
    expect(uniqueCatId('opus', reserved('opusx'))).toBe('opus');
  });

  it('returns an empty base untouched (caller handles empty)', () => {
    expect(uniqueCatId('', reserved('opus'))).toBe('');
  });
});
