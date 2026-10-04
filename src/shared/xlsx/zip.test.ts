import * as zlib from 'node:zlib';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { buildZip } from './__fixtures__/build-xlsx.js';
import { openZip } from './zip.js';

// The real inflate, watched: the budget must stop inflating while it runs, not be checked once it is over.
vi.mock('node:zlib', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:zlib')>();
  return { ...actual, inflateRawSync: vi.fn(actual.inflateRawSync) };
});

const inflate = vi.mocked(zlib.inflateRawSync);

function tooLarge() {
  return expect.objectContaining({ statusCode: 400, message: expect.stringContaining('too large once uncompressed') });
}

beforeEach(() => {
  inflate.mockClear();
});

describe('openZip inflate budget', () => {
  it('inflates each entry with maxOutputLength set to what is left of the budget', () => {
    const zip = openZip(
      buildZip([
        { name: 'a.xml', data: 'a'.repeat(3_000) },
        { name: 'b.xml', data: 'b'.repeat(4_000) },
        { name: 'c.xml', data: 'c'.repeat(2_000) },
      ]),
      { maxUncompressedBytes: 10_000, maxEntries: 10 },
    );

    expect([zip.read('a.xml')?.length, zip.read('b.xml')?.length, zip.read('c.xml')?.length]).toEqual([3_000, 4_000, 2_000]);
    expect(inflate.mock.calls.map(([, options]) => options?.maxOutputLength)).toEqual([10_000, 7_000, 3_000]);
  });

  it('stops an entry that understates its size inside zlib, as soon as it outgrows the budget', () => {
    const zip = openZip(buildZip([{ name: 'bomb.xml', data: Buffer.alloc(1024 * 1024, 32), declaredSize: 100 }]), {
      maxUncompressedBytes: 64 * 1024,
      maxEntries: 10,
    });

    expect(() => zip.read('bomb.xml')).toThrow(tooLarge());
    expect(inflate).toHaveBeenCalledTimes(1);
    expect(inflate.mock.calls[0]?.[1]?.maxOutputLength).toBe(64 * 1024);
    // zlib itself gave up: the megabyte was never produced.
    expect(inflate.mock.results[0]?.type).toBe('throw');
  });

  it('charges every read, the same entry read twice included', () => {
    const zip = openZip(buildZip([{ name: 'a.xml', data: 'a'.repeat(6_000) }]), { maxUncompressedBytes: 10_000, maxEntries: 10 });

    zip.read('a.xml');

    expect(() => zip.read('a.xml')).toThrow(tooLarge());
    expect(inflate.mock.calls.map(([, options]) => options?.maxOutputLength)).toEqual([10_000, 4_000]);
  });

  it('does not inflate stored entries, but still charges them', () => {
    const zip = openZip(
      buildZip([
        { name: 'stored.xml', data: 's'.repeat(6_000), method: 0 },
        { name: 'deflated.xml', data: 'd'.repeat(3_000) },
      ]),
      { maxUncompressedBytes: 10_000, maxEntries: 10 },
    );

    expect(zip.read('stored.xml')?.length).toBe(6_000);
    zip.read('deflated.xml');

    expect(inflate.mock.calls.map(([, options]) => options?.maxOutputLength)).toEqual([4_000]);
  });
});
