import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

const diagnostics = await import('../dist/domains/cats/services/agents/routing/prompt-segment-diagnostics.js');

const ORIGINAL_SEGMENT_MODE = process.env.PROMPT_SEGMENT_DIAGNOSTICS;
const ORIGINAL_NATIVE_MODE = process.env.PROMPT_SEGMENT_DIAGNOSTICS_NATIVE;

afterEach(() => {
  restoreEnv('PROMPT_SEGMENT_DIAGNOSTICS', ORIGINAL_SEGMENT_MODE);
  restoreEnv('PROMPT_SEGMENT_DIAGNOSTICS_NATIVE', ORIGINAL_NATIVE_MODE);
});

function restoreEnv(key, value) {
  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
}

describe('prompt segment diagnostics', () => {
  it('records measured token segments without carrying prompt text', () => {
    const text = '[Casual mode]\nAnswer briefly.';
    const segment = diagnostics.promptTextSegment('modeSystemPrompt', text);

    assert.equal(segment.name, 'modeSystemPrompt');
    assert.equal(segment.included, true);
    assert.equal(segment.chars, text.length);
    assert.equal(typeof segment.estimatedTokens, 'number');
    assert.ok(segment.estimatedTokens > 0);
    assert.equal('text' in segment, false);
  });

  it('supports casual-only diagnostics gating', () => {
    process.env.PROMPT_SEGMENT_DIAGNOSTICS = 'casual';

    assert.equal(diagnostics.shouldRecordPromptSegmentDiagnostics('[Casual mode]\nminimal'), true);
    assert.equal(diagnostics.shouldRecordPromptSegmentDiagnostics('development mode'), false);
  });

  it('keeps native L0 measurement behind an explicit flag', () => {
    delete process.env.PROMPT_SEGMENT_DIAGNOSTICS_NATIVE;
    assert.equal(diagnostics.shouldMeasureNativePromptSegmentDiagnostics(), false);

    process.env.PROMPT_SEGMENT_DIAGNOSTICS_NATIVE = '1';
    assert.equal(diagnostics.shouldMeasureNativePromptSegmentDiagnostics(), true);
  });
});
