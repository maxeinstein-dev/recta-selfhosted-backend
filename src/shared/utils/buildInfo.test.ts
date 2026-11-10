import { describe, expect, it } from 'vitest';

import { buildCommit } from './buildInfo.js';

describe('buildCommit', () => {
  it('returns the first seven characters of the Render commit, lower-cased', () => {
    expect(buildCommit({ RENDER_GIT_COMMIT: 'ABCDEF0123456789abcdef0123456789abcdef01' })).toBe('abcdef0');
  });

  it('falls back to GIT_COMMIT and prefers the Render variable when both exist', () => {
    expect(buildCommit({ GIT_COMMIT: '1234567' })).toBe('1234567');
    expect(buildCommit({ RENDER_GIT_COMMIT: 'aaaaaaa1', GIT_COMMIT: 'bbbbbbb2' })).toBe('aaaaaaa');
  });

  it('is null when unset, empty, too short or not a hash', () => {
    expect(buildCommit({})).toBeNull();
    expect(buildCommit({ RENDER_GIT_COMMIT: '   ' })).toBeNull();
    expect(buildCommit({ RENDER_GIT_COMMIT: 'abc12' })).toBeNull();
    expect(buildCommit({ RENDER_GIT_COMMIT: 'main' })).toBeNull();
    expect(buildCommit({ RENDER_GIT_COMMIT: 'abcdef0; rm -rf' })).toBeNull();
  });
});
