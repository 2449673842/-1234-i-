import fs from 'node:fs';
import path from 'node:path';

export class UnsafeFileError extends Error {
  statusCode: number;

  constructor(message: string, statusCode = 400) {
    super(message);
    this.name = 'UnsafeFileError';
    this.statusCode = statusCode;
  }
}

function envInteger(name: string, fallback: number, min: number, max: number): number {
  const value = Number(process.env[name]);
  if (!Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(value)));
}

function startsWithBytes(buffer: Buffer, signature: number[]): boolean {
  return signature.every((value, index) => buffer[index] === value);
}

function isZipContainer(buffer: Buffer): boolean {
  return startsWithBytes(buffer, [0x50, 0x4b, 0x03, 0x04])
    || startsWithBytes(buffer, [0x50, 0x4b, 0x05, 0x06])
    || startsWithBytes(buffer, [0x50, 0x4b, 0x07, 0x08]);
}

function isOleCompoundFile(buffer: Buffer): boolean {
  return startsWithBytes(buffer, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
}

function assertTextLike(buffer: Buffer): void {
  if (buffer.length === 0) throw new UnsafeFileError('文本数据文件不能为空');
  const hasUtf16Bom = startsWithBytes(buffer, [0xff, 0xfe]) || startsWithBytes(buffer, [0xfe, 0xff]);
  if (hasUtf16Bom) throw new UnsafeFileError('暂不支持 UTF-16 文本，请另存为 UTF-8 CSV/TSV');
  if (buffer.includes(0)) throw new UnsafeFileError('文本数据文件包含二进制内容');
  let disallowedControls = 0;
  for (const byte of buffer) {
    if (byte < 0x20 && byte !== 0x09 && byte !== 0x0a && byte !== 0x0d) disallowedControls += 1;
  }
  if (disallowedControls / buffer.length > 0.01) {
    throw new UnsafeFileError('文本数据文件包含过多控制字符');
  }
}

async function readExactly(handle: fs.promises.FileHandle, length: number, position: number): Promise<Buffer> {
  const buffer = Buffer.alloc(length);
  const { bytesRead } = await handle.read(buffer, 0, length, position);
  if (bytesRead !== length) throw new UnsafeFileError('XLSX ZIP 目录结构不完整');
  return buffer;
}

async function assertSafeXlsxZip(handle: fs.promises.FileHandle, fileSize: number): Promise<void> {
  const maxEntries = envInteger('SCIFIGURE_XLSX_MAX_ENTRIES', 2_048, 32, 20_000);
  const maxUncompressedBytes = envInteger('SCIFIGURE_XLSX_MAX_UNCOMPRESSED_MB', 256, 16, 2_048) * 1024 * 1024;
  const maxEntryBytes = envInteger('SCIFIGURE_XLSX_MAX_ENTRY_MB', 128, 8, 1_024) * 1024 * 1024;
  const maxRatio = envInteger('SCIFIGURE_XLSX_MAX_COMPRESSION_RATIO', 200, 10, 1_000);
  const tailLength = Math.min(fileSize, 65_557);
  const tail = await readExactly(handle, tailLength, fileSize - tailLength);
  let eocdOffset = -1;
  for (let index = tail.length - 22; index >= 0; index -= 1) {
    if (tail.readUInt32LE(index) === 0x06054b50) {
      eocdOffset = index;
      break;
    }
  }
  if (eocdOffset < 0) throw new UnsafeFileError('XLSX ZIP 缺少中央目录');

  const diskNumber = tail.readUInt16LE(eocdOffset + 4);
  const centralDisk = tail.readUInt16LE(eocdOffset + 6);
  const entriesOnDisk = tail.readUInt16LE(eocdOffset + 8);
  const entryCount = tail.readUInt16LE(eocdOffset + 10);
  const centralSize = tail.readUInt32LE(eocdOffset + 12);
  const centralOffset = tail.readUInt32LE(eocdOffset + 16);
  const commentLength = tail.readUInt16LE(eocdOffset + 20);
  const absoluteEocdOffset = fileSize - tailLength + eocdOffset;
  if (diskNumber !== 0 || centralDisk !== 0 || entriesOnDisk !== entryCount) {
    throw new UnsafeFileError('不支持分卷 XLSX ZIP');
  }
  if (entryCount === 0 || entryCount === 0xffff || centralSize === 0xffffffff || centralOffset === 0xffffffff) {
    throw new UnsafeFileError('XLSX ZIP 目录为空或使用了不受支持的 ZIP64 结构');
  }
  if (entryCount > maxEntries) {
    throw new UnsafeFileError(`XLSX 内部文件数超过安全上限 ${maxEntries}`, 413);
  }
  if (absoluteEocdOffset + 22 + commentLength !== fileSize || centralOffset + centralSize > absoluteEocdOffset) {
    throw new UnsafeFileError('XLSX ZIP 中央目录边界无效');
  }

  let cursor = centralOffset;
  let totalUncompressed = 0;
  const names = new Set<string>();
  for (let index = 0; index < entryCount; index += 1) {
    const header = await readExactly(handle, 46, cursor);
    if (header.readUInt32LE(0) !== 0x02014b50) throw new UnsafeFileError('XLSX ZIP 中央目录条目无效');
    const flags = header.readUInt16LE(8);
    const compressedSize = header.readUInt32LE(20);
    const uncompressedSize = header.readUInt32LE(24);
    const nameLength = header.readUInt16LE(28);
    const extraLength = header.readUInt16LE(30);
    const entryCommentLength = header.readUInt16LE(32);
    const diskStart = header.readUInt16LE(34);
    if ((flags & 0x1) !== 0 || diskStart !== 0) throw new UnsafeFileError('XLSX ZIP 包含加密或分卷条目');
    if (compressedSize === 0xffffffff || uncompressedSize === 0xffffffff) {
      throw new UnsafeFileError('不支持 ZIP64 XLSX 条目');
    }
    if (nameLength < 1 || nameLength > 1_024) throw new UnsafeFileError('XLSX ZIP 条目名称长度无效');
    const nameBuffer = await readExactly(handle, nameLength, cursor + 46);
    const entryName = nameBuffer.toString('utf8').replace(/\\/g, '/');
    const segments = entryName.split('/');
    if (entryName.includes('\0') || entryName.startsWith('/') || /^[A-Za-z]:/.test(entryName) || segments.includes('..')) {
      throw new UnsafeFileError('XLSX ZIP 包含不安全的内部路径');
    }
    if (uncompressedSize > maxEntryBytes) {
      throw new UnsafeFileError(`XLSX 单个内部文件超过 ${Math.floor(maxEntryBytes / 1024 / 1024)} MB`, 413);
    }
    if (uncompressedSize > 0 && (compressedSize === 0 || uncompressedSize / compressedSize > maxRatio)) {
      throw new UnsafeFileError('XLSX ZIP 压缩比超过安全上限', 413);
    }
    totalUncompressed += uncompressedSize;
    if (totalUncompressed > maxUncompressedBytes) {
      throw new UnsafeFileError(`XLSX 解压总量超过 ${Math.floor(maxUncompressedBytes / 1024 / 1024)} MB`, 413);
    }
    names.add(entryName);
    cursor += 46 + nameLength + extraLength + entryCommentLength;
    if (cursor > centralOffset + centralSize) throw new UnsafeFileError('XLSX ZIP 中央目录越界');
  }
  if (cursor !== centralOffset + centralSize) throw new UnsafeFileError('XLSX ZIP 中央目录大小不一致');
  if (!names.has('[Content_Types].xml') || !names.has('xl/workbook.xml')) {
    throw new UnsafeFileError('ZIP 容器不是有效的 XLSX 工作簿');
  }
}

export async function assertValidUploadedDataFile(filePath: string, originalName: string): Promise<void> {
  const extension = path.extname(originalName).toLowerCase();
  const handle = await fs.promises.open(filePath, 'r');
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size <= 0) throw new UnsafeFileError('上传文件为空或不是普通文件');
    const head = Buffer.alloc(Math.min(8192, stat.size));
    await handle.read(head, 0, head.length, 0);
    if (extension === '.xlsx' && !isZipContainer(head)) {
      throw new UnsafeFileError('文件内容不是有效的 XLSX/ZIP 容器');
    }
    if (extension === '.xlsx') await assertSafeXlsxZip(handle, stat.size);
    if (extension === '.xls' && !isOleCompoundFile(head)) {
      throw new UnsafeFileError('文件内容不是有效的 XLS 工作簿');
    }
    if (extension === '.csv' || extension === '.tsv' || extension === '.txt') {
      if (isZipContainer(head) || isOleCompoundFile(head) || startsWithBytes(head, [0x89, 0x50, 0x4e, 0x47])) {
        throw new UnsafeFileError('文本扩展名与文件内容不匹配');
      }
      assertTextLike(head);
    }
  } finally {
    await handle.close();
  }
}

export function decodeAndValidatePngBase64(value: string, maxBytes = 32 * 1024 * 1024): Buffer {
  const normalized = String(value || '').replace(/\s+/g, '');
  if (!normalized || !/^[A-Za-z0-9+/]+={0,2}$/.test(normalized)) {
    throw new UnsafeFileError('PNG 数据不是有效的 Base64');
  }
  if (Math.ceil(normalized.length * 3 / 4) > maxBytes) {
    throw new UnsafeFileError('PNG 数据超过允许大小');
  }
  const buffer = Buffer.from(normalized, 'base64');
  if (buffer.length < 45 || !startsWithBytes(buffer, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
    throw new UnsafeFileError('PNG 文件签名无效');
  }
  if (buffer.readUInt32BE(8) !== 13 || buffer.toString('ascii', 12, 16) !== 'IHDR') {
    throw new UnsafeFileError('PNG 缺少有效 IHDR 头');
  }
  const width = buffer.readUInt32BE(16);
  const height = buffer.readUInt32BE(20);
  const maxPixels = envInteger('SCIFIGURE_PNG_MAX_PIXELS', 80_000_000, 1_000_000, 150_000_000);
  if (width < 1 || height < 1 || width > 30_000 || height > 30_000 || width * height > maxPixels) {
    throw new UnsafeFileError('PNG 像素尺寸超过安全范围');
  }

  let offset = 8;
  let sawIhdr = false;
  let sawIend = false;
  while (offset < buffer.length) {
    if (offset + 12 > buffer.length) throw new UnsafeFileError('PNG chunk 边界不完整');
    const chunkLength = buffer.readUInt32BE(offset);
    const chunkEnd = offset + 12 + chunkLength;
    if (chunkEnd > buffer.length) throw new UnsafeFileError('PNG chunk 长度越界');
    const chunkType = buffer.toString('ascii', offset + 4, offset + 8);
    if (!/^[A-Za-z]{4}$/.test(chunkType)) throw new UnsafeFileError('PNG chunk 类型无效');
    if (!sawIhdr && chunkType !== 'IHDR') throw new UnsafeFileError('PNG 首个 chunk 必须是 IHDR');
    if (chunkType === 'IHDR') {
      if (sawIhdr || chunkLength !== 13) throw new UnsafeFileError('PNG IHDR 结构无效');
      sawIhdr = true;
    }
    if (chunkType === 'IEND') {
      if (sawIend || chunkLength !== 0 || chunkEnd !== buffer.length) {
        throw new UnsafeFileError('PNG IEND 结构或结尾无效');
      }
      sawIend = true;
    }
    offset = chunkEnd;
  }
  if (!sawIhdr || !sawIend) throw new UnsafeFileError('PNG 缺少完整 IHDR/IEND 结构');
  return buffer;
}
