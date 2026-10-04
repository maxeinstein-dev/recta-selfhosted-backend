/**
 * Minimal, defensive reader for the zip container of an .xlsx file (Node built-ins only).
 *
 * Supports what spreadsheet writers produce: a single-disk archive without ZIP64 whose entries are
 * stored (method 0) or deflated (method 8). Two guards make a zip bomb fail fast:
 * - before anything is inflated, the sizes declared by the central directory must add up to at most
 *   `maxUncompressedBytes` (ZIP64 markers count as too large) and there may be at most `maxEntries` entries;
 * - every read is then capped by what is left of the same budget (`maxOutputLength`), so an archive whose
 *   headers understate the real size is stopped while inflating, not after.
 */
import { inflateRawSync } from 'node:zlib';

import { BadRequestError } from '../errors/app-error.js';

const LOCAL_FILE_HEADER = 0x04034b50;
const CENTRAL_DIRECTORY_HEADER = 0x02014b50;
const END_OF_CENTRAL_DIRECTORY = 0x06054b50;
const END_OF_CENTRAL_DIRECTORY_SIZE = 22;
const MAX_ARCHIVE_COMMENT = 0xffff;
const ZIP64_MARKER_16 = 0xffff;
const ZIP64_MARKER_32 = 0xffffffff;
const FLAG_ENCRYPTED = 0x0001;
const FLAG_UTF8_NAME = 0x0800;
const METHOD_STORED = 0;
const METHOD_DEFLATED = 8;

export interface ZipLimits {
  /** Ceiling for the declared uncompressed sizes of all entries and for the bytes actually inflated. */
  maxUncompressedBytes: number;
  /** Ceiling for the number of entries in the central directory. */
  maxEntries: number;
}

interface ZipEntry {
  flags: number;
  method: number;
  compressedSize: number;
  localHeaderOffset: number;
}

export interface ZipArchive {
  /** Inflates one entry, charging the budget. Names are matched case-insensitively, ignoring a leading "/". Null when absent. */
  read(name: string): Buffer | null;
}

/** The upload is not a zip archive at all (or not an .xlsx one). */
export function notAWorkbook(detail?: string): BadRequestError {
  return new BadRequestError(`The file is not an .xlsx workbook${detail ? ` (${detail})` : ''}.`);
}

/** The archive is damaged or uses a feature a spreadsheet does not need. */
export function unreadableWorkbook(): BadRequestError {
  return new BadRequestError('Could not read the .xlsx file.');
}

function tooLarge(limits: ZipLimits, detail?: string): BadRequestError {
  const megabytes = Math.round((limits.maxUncompressedBytes / (1024 * 1024)) * 100) / 100;
  return new BadRequestError(
    `The .xlsx file is too large once uncompressed (limit ${megabytes} MB${detail ? `; ${detail}` : ''}).`,
  );
}

function entryKey(name: string): string {
  return name.replace(/\\/g, '/').replace(/^\/+/, '').toLowerCase();
}

function findEndOfCentralDirectory(buffer: Buffer): number {
  const last = buffer.length - END_OF_CENTRAL_DIRECTORY_SIZE;
  const first = Math.max(0, last - MAX_ARCHIVE_COMMENT);
  for (let offset = last; offset >= first; offset--) {
    if (buffer.readUInt32LE(offset) === END_OF_CENTRAL_DIRECTORY) return offset;
  }
  return -1;
}

function isOutputTooLarge(error: unknown): boolean {
  return error instanceof RangeError && (error as NodeJS.ErrnoException).code === 'ERR_BUFFER_TOO_LARGE';
}

/**
 * Checks the archive structure and the declared sizes, then returns a reader for its entries.
 * @throws BadRequestError when the buffer is not a zip, is damaged, or breaks a limit.
 */
export function openZip(buffer: Buffer, limits: ZipLimits): ZipArchive {
  if (buffer.length < 4 || buffer.readUInt32LE(0) !== LOCAL_FILE_HEADER) {
    throw notAWorkbook('expected a zip archive');
  }

  const end = findEndOfCentralDirectory(buffer);
  if (end < 0) throw unreadableWorkbook();
  const diskNumber = buffer.readUInt16LE(end + 4);
  const directoryDisk = buffer.readUInt16LE(end + 6);
  const entriesOnDisk = buffer.readUInt16LE(end + 8);
  const totalEntries = buffer.readUInt16LE(end + 10);
  const directorySize = buffer.readUInt32LE(end + 12);
  const directoryOffset = buffer.readUInt32LE(end + 16);

  if (
    totalEntries === ZIP64_MARKER_16 ||
    entriesOnDisk === ZIP64_MARKER_16 ||
    directorySize === ZIP64_MARKER_32 ||
    directoryOffset === ZIP64_MARKER_32
  ) {
    throw tooLarge(limits, 'ZIP64 archives are not accepted');
  }
  if (diskNumber !== 0 || directoryDisk !== 0 || entriesOnDisk !== totalEntries) throw unreadableWorkbook();
  if (totalEntries > limits.maxEntries) {
    throw new BadRequestError(`The .xlsx file has too many entries (limit ${limits.maxEntries}).`);
  }
  if (directoryOffset + directorySize > end) throw unreadableWorkbook();

  const entries = new Map<string, ZipEntry>();
  let declaredBytes = 0;
  let pointer = directoryOffset;
  for (let index = 0; index < totalEntries; index++) {
    if (pointer + 46 > end || buffer.readUInt32LE(pointer) !== CENTRAL_DIRECTORY_HEADER) throw unreadableWorkbook();
    const flags = buffer.readUInt16LE(pointer + 8);
    const method = buffer.readUInt16LE(pointer + 10);
    const compressedSize = buffer.readUInt32LE(pointer + 20);
    const uncompressedSize = buffer.readUInt32LE(pointer + 24);
    const nameLength = buffer.readUInt16LE(pointer + 28);
    const extraLength = buffer.readUInt16LE(pointer + 30);
    const commentLength = buffer.readUInt16LE(pointer + 32);
    const localHeaderOffset = buffer.readUInt32LE(pointer + 42);
    const next = pointer + 46 + nameLength + extraLength + commentLength;
    if (next > end) throw unreadableWorkbook();

    if (
      compressedSize === ZIP64_MARKER_32 ||
      uncompressedSize === ZIP64_MARKER_32 ||
      localHeaderOffset === ZIP64_MARKER_32
    ) {
      throw tooLarge(limits, 'ZIP64 entries are not accepted');
    }
    declaredBytes += uncompressedSize;
    if (declaredBytes > limits.maxUncompressedBytes) throw tooLarge(limits);

    const name = buffer.toString(flags & FLAG_UTF8_NAME ? 'utf8' : 'latin1', pointer + 46, pointer + 46 + nameLength);
    const key = entryKey(name);
    if (!name.endsWith('/') && !entries.has(key)) {
      entries.set(key, { flags, method, compressedSize, localHeaderOffset });
    }
    pointer = next;
  }

  let remainingBytes = limits.maxUncompressedBytes;

  return {
    read(name: string): Buffer | null {
      const entry = entries.get(entryKey(name));
      if (!entry) return null;
      if (entry.flags & FLAG_ENCRYPTED) throw unreadableWorkbook();

      const header = entry.localHeaderOffset;
      if (header + 30 > buffer.length || buffer.readUInt32LE(header) !== LOCAL_FILE_HEADER) throw unreadableWorkbook();
      const dataStart = header + 30 + buffer.readUInt16LE(header + 26) + buffer.readUInt16LE(header + 28);
      const dataEnd = dataStart + entry.compressedSize;
      if (dataEnd > buffer.length) throw unreadableWorkbook();
      const data = buffer.subarray(dataStart, dataEnd);

      let output: Buffer;
      if (entry.method === METHOD_STORED) {
        output = data;
      } else if (entry.method === METHOD_DEFLATED) {
        try {
          output = inflateRawSync(data, { maxOutputLength: Math.max(1, remainingBytes) });
        } catch (error) {
          throw isOutputTooLarge(error) ? tooLarge(limits) : unreadableWorkbook();
        }
      } else {
        throw unreadableWorkbook();
      }

      if (output.length > remainingBytes) throw tooLarge(limits);
      remainingBytes -= output.length;
      return output;
    },
  };
}
