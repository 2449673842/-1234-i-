import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { assertValidUploadedDataFile, decodeAndValidatePngBase64 } from './fileValidation';

const tempFiles: string[] = [];

function minimalZip(entries: Array<{ name: string; compressedSize?: number; uncompressedSize?: number }>): Buffer {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let localOffset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const compressedSize = entry.compressedSize ?? 0;
    const uncompressedSize = entry.uncompressedSize ?? compressedSize;
    const local = Buffer.alloc(30 + name.length + compressedSize);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt32LE(compressedSize, 18);
    local.writeUInt32LE(uncompressedSize, 22);
    local.writeUInt16LE(name.length, 26);
    name.copy(local, 30);
    localParts.push(local);

    const central = Buffer.alloc(46 + name.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt32LE(compressedSize, 20);
    central.writeUInt32LE(uncompressedSize, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(localOffset, 42);
    name.copy(central, 46);
    centralParts.push(central);
    localOffset += local.length;
  }
  const centralDirectory = Buffer.concat(centralParts);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralDirectory.length, 12);
  eocd.writeUInt32LE(localOffset, 16);
  return Buffer.concat([...localParts, centralDirectory, eocd]);
}

function minimalXlsx(extraEntries: Array<{ name: string; compressedSize?: number; uncompressedSize?: number }> = []): Buffer {
  return minimalZip([
    { name: '[Content_Types].xml' },
    { name: 'xl/workbook.xml' },
    ...extraEntries,
  ]);
}

async function tempFile(name: string, content: Buffer | string): Promise<string> {
  const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'scifigure-file-validation-'));
  const filePath = path.join(directory, name);
  await fs.promises.writeFile(filePath, content);
  tempFiles.push(directory);
  return filePath;
}

afterEach(async () => {
  await Promise.all(tempFiles.splice(0).map(directory => fs.promises.rm(directory, { recursive: true, force: true })));
});

describe('uploaded file validation', () => {
  it('accepts UTF-8 delimited text and known workbook signatures', async () => {
    await expect(assertValidUploadedDataFile(await tempFile('data.csv', 'sample,value\nA,1\n'), 'data.csv')).resolves.toBeUndefined();
    await expect(assertValidUploadedDataFile(await tempFile('book.xlsx', minimalXlsx()), 'book.xlsx')).resolves.toBeUndefined();
    await expect(assertValidUploadedDataFile(await tempFile('book.xls', Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 1])), 'book.xls')).resolves.toBeUndefined();
  });

  it('rejects extension and content mismatches before parser execution', async () => {
    await expect(assertValidUploadedDataFile(await tempFile('fake.xlsx', '<html>not a workbook</html>'), 'fake.xlsx')).rejects.toThrow('XLSX');
    await expect(assertValidUploadedDataFile(await tempFile('fake.csv', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0])), 'fake.csv')).rejects.toThrow('不匹配');
    await expect(assertValidUploadedDataFile(await tempFile('binary.csv', Buffer.from([0x41, 0x00, 0x42])), 'binary.csv')).rejects.toThrow('二进制');
    await expect(assertValidUploadedDataFile(await tempFile('header-only.xlsx', Buffer.from([0x50, 0x4b, 0x03, 0x04, 1, 2, 3])), 'header-only.xlsx')).rejects.toThrow('中央目录');
    await expect(assertValidUploadedDataFile(
      await tempFile('bomb.xlsx', minimalXlsx([{ name: 'xl/worksheets/sheet1.xml', compressedSize: 1, uncompressedSize: 1_000_000 }])),
      'bomb.xlsx',
    )).rejects.toThrow('压缩比');
    await expect(assertValidUploadedDataFile(
      await tempFile('unsafe-path.xlsx', minimalXlsx([{ name: '../escape.xml' }])),
      'unsafe-path.xlsx',
    )).rejects.toThrow('内部路径');
  });

  it('validates PNG signature, dimensions and decoded size', () => {
    const base64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
    expect(decodeAndValidatePngBase64(base64).length).toBeGreaterThan(45);
    expect(() => decodeAndValidatePngBase64(Buffer.from('not png').toString('base64'))).toThrow('PNG');
    const withTrailingData = Buffer.concat([Buffer.from(base64, 'base64'), Buffer.from('trailing')]);
    expect(() => decodeAndValidatePngBase64(withTrailingData.toString('base64'))).toThrow('IEND');
    const oversized = Buffer.from(base64, 'base64');
    oversized.writeUInt32BE(30_000, 16);
    oversized.writeUInt32BE(30_000, 20);
    expect(() => decodeAndValidatePngBase64(oversized.toString('base64'))).toThrow('像素尺寸');
  });
});
