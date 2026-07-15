import Papa from 'papaparse';

export const CLIENT_DATA_FILE_MAX_BYTES = 50 * 1024 * 1024;
export const CLIENT_TABULAR_SAMPLE_ROWS = 100;

const ALLOWED_EXTENSIONS = new Set(['.csv', '.tsv', '.txt', '.xlsx', '.xls']);
const MAX_PREVIEW_COLUMNS = 512;
const MAX_PREVIEW_CELLS = 50_000;
const MAX_PREVIEW_CELL_CHARS = 65_536;
const MAX_XLSX_ENTRIES = 2_048;
const MAX_XLSX_UNCOMPRESSED_BYTES = 256 * 1024 * 1024;
const MAX_XLSX_ENTRY_BYTES = 128 * 1024 * 1024;
const MAX_XLSX_RATIO = 200;
const MAX_BROWSER_WORKBOOK_BYTES = 20 * 1024 * 1024;
const MAX_BROWSER_UNCOMPRESSED_BYTES = 64 * 1024 * 1024;
const MAX_BROWSER_ENTRY_BYTES = 32 * 1024 * 1024;

export interface ClientTabularPreview {
  headers: string[];
  sampleRows: Array<Record<string, unknown>>;
  sampled: true;
  previewDeferredReason?: string;
}

export class ClientDataFileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ClientDataFileError';
  }
}

export function clientDataFileExtension(fileName: string): string {
  const dotIndex = String(fileName || '').lastIndexOf('.');
  return dotIndex >= 0 ? fileName.slice(dotIndex).toLowerCase() : '';
}

export function validateClientDataFileSelection(file: Pick<File, 'name' | 'size'>): string {
  const extension = clientDataFileExtension(file.name);
  if (!ALLOWED_EXTENSIONS.has(extension)) {
    throw new ClientDataFileError('仅支持 CSV、TSV、TXT、XLSX 和 XLS 数据文件');
  }
  if (!Number.isFinite(file.size) || file.size <= 0) {
    throw new ClientDataFileError(`${file.name} 是空文件`);
  }
  if (file.size > CLIENT_DATA_FILE_MAX_BYTES) {
    throw new ClientDataFileError(`${file.name} 超过 50 MB 单文件安全上限`);
  }
  return extension;
}

function startsWithBytes(bytes: Uint8Array, signature: number[]): boolean {
  return signature.every((value, index) => bytes[index] === value);
}

function assertPreviewRows(headers: string[], rows: Array<Record<string, unknown>>): void {
  if (headers.length > MAX_PREVIEW_COLUMNS) {
    throw new ClientDataFileError(`数据列数超过浏览器预览上限 ${MAX_PREVIEW_COLUMNS}`);
  }
  if (rows.length * Math.max(1, headers.length) > MAX_PREVIEW_CELLS) {
    throw new ClientDataFileError('数据预览单元格数量超过安全上限');
  }
  for (const header of headers) {
    if (header.length > MAX_PREVIEW_CELL_CHARS) throw new ClientDataFileError('数据表头过长');
  }
  for (const row of rows) {
    for (const value of Object.values(row)) {
      if (value !== null && value !== undefined && typeof value === 'object') {
        throw new ClientDataFileError('数据单元只能包含文本、数值、布尔值或空值');
      }
      if (typeof value === 'string' && value.length > MAX_PREVIEW_CELL_CHARS) {
        throw new ClientDataFileError('单个数据单元超过浏览器预览安全上限');
      }
    }
  }
}

function parseDelimitedPreview(file: File, delimiter: string): Promise<ClientTabularPreview> {
  return new Promise((resolve, reject) => {
    Papa.parse<Record<string, unknown>>(file, {
      delimiter,
      header: true,
      dynamicTyping: true,
      skipEmptyLines: true,
      preview: CLIENT_TABULAR_SAMPLE_ROWS,
      complete: result => {
        try {
          const fatal = result.errors.find(error => error.type === 'Quotes');
          if (fatal) throw new ClientDataFileError(`CSV 预览解析失败: ${fatal.message}`);
          const rows = Array.isArray(result.data) ? result.data.slice(0, CLIENT_TABULAR_SAMPLE_ROWS) : [];
          const headers = result.meta.fields?.length
            ? result.meta.fields.map(String)
            : rows[0] ? Object.keys(rows[0]) : [];
          if (headers.length === 0) throw new ClientDataFileError('数据文件缺少表头');
          assertPreviewRows(headers, rows);
          resolve({ headers, sampleRows: rows, sampled: true });
        } catch (error) {
          reject(error);
        }
      },
      error: error => reject(new ClientDataFileError(`数据预览读取失败: ${error.message}`)),
    });
  });
}

function uint16(view: DataView, offset: number): number {
  if (offset < 0 || offset + 2 > view.byteLength) throw new ClientDataFileError('XLSX ZIP 结构不完整');
  return view.getUint16(offset, true);
}

function uint32(view: DataView, offset: number): number {
  if (offset < 0 || offset + 4 > view.byteLength) throw new ClientDataFileError('XLSX ZIP 结构不完整');
  return view.getUint32(offset, true);
}

function containsZip64Extra(view: DataView, offset: number, length: number): boolean {
  const end = offset + length;
  if (offset < 0 || end > view.byteLength) throw new ClientDataFileError('XLSX ZIP 扩展字段越界');
  let cursor = offset;
  while (cursor < end) {
    if (cursor + 4 > end) throw new ClientDataFileError('XLSX ZIP 扩展字段结构无效');
    const headerId = uint16(view, cursor);
    const dataSize = uint16(view, cursor + 2);
    cursor += 4 + dataSize;
    if (cursor > end) throw new ClientDataFileError('XLSX ZIP 扩展字段结构无效');
    if (headerId === 0x0001) return true;
  }
  return false;
}

export function inspectClientXlsxArchive(buffer: ArrayBuffer): { previewDeferredReason?: string } {
  const bytes = new Uint8Array(buffer);
  const view = new DataView(buffer);
  if (!startsWithBytes(bytes, [0x50, 0x4b])) throw new ClientDataFileError('文件内容不是有效的 XLSX/ZIP 容器');
  const searchStart = Math.max(0, bytes.length - 65_557);
  let eocd = -1;
  for (let index = bytes.length - 22; index >= searchStart; index -= 1) {
    if (uint32(view, index) === 0x06054b50) {
      eocd = index;
      break;
    }
  }
  if (eocd < 0) throw new ClientDataFileError('XLSX ZIP 缺少中央目录');

  const diskNumber = uint16(view, eocd + 4);
  const centralDisk = uint16(view, eocd + 6);
  const entriesOnDisk = uint16(view, eocd + 8);
  const entryCount = uint16(view, eocd + 10);
  const centralSize = uint32(view, eocd + 12);
  const centralOffset = uint32(view, eocd + 16);
  const commentLength = uint16(view, eocd + 20);
  if (diskNumber !== 0 || centralDisk !== 0 || entriesOnDisk !== entryCount) {
    throw new ClientDataFileError('不支持分卷 XLSX ZIP');
  }
  if (!entryCount || entryCount === 0xffff || centralSize === 0xffffffff || centralOffset === 0xffffffff) {
    throw new ClientDataFileError('XLSX ZIP 使用了不受支持的 ZIP64 或空目录结构');
  }
  if (entryCount > MAX_XLSX_ENTRIES) throw new ClientDataFileError('XLSX 内部文件数超过安全上限');
  if (eocd + 22 + commentLength !== bytes.length || centralOffset + centralSize > eocd) {
    throw new ClientDataFileError('XLSX ZIP 中央目录边界无效');
  }

  const decoder = new TextDecoder('utf-8');
  const names = new Set<string>();
  const localRanges: Array<{ start: number; end: number }> = [];
  let cursor = centralOffset;
  let totalUncompressed = 0;
  let browserDeferred = buffer.byteLength > MAX_BROWSER_WORKBOOK_BYTES;
  for (let index = 0; index < entryCount; index += 1) {
    if (cursor + 46 > centralOffset + centralSize) throw new ClientDataFileError('XLSX ZIP 中央目录条目越界');
    if (uint32(view, cursor) !== 0x02014b50) throw new ClientDataFileError('XLSX ZIP 中央目录条目无效');
    const flags = uint16(view, cursor + 8);
    const method = uint16(view, cursor + 10);
    const crc32 = uint32(view, cursor + 16);
    const compressedSize = uint32(view, cursor + 20);
    const uncompressedSize = uint32(view, cursor + 24);
    const nameLength = uint16(view, cursor + 28);
    const extraLength = uint16(view, cursor + 30);
    const entryCommentLength = uint16(view, cursor + 32);
    const diskStart = uint16(view, cursor + 34);
    const localOffset = uint32(view, cursor + 42);
    if ((flags & 0x1) !== 0 || diskStart !== 0) throw new ClientDataFileError('XLSX ZIP 包含加密或分卷条目');
    if ((flags & ~(0x0006 | 0x0008 | 0x0800)) !== 0 || (method !== 0 && method !== 8)) {
      throw new ClientDataFileError('XLSX ZIP 使用了不受支持的压缩方式或标志');
    }
    if (
      compressedSize === 0xffffffff
      || uncompressedSize === 0xffffffff
      || localOffset === 0xffffffff
      || nameLength < 1
      || nameLength > 1_024
    ) {
      throw new ClientDataFileError('XLSX ZIP 条目结构无效');
    }
    const nameStart = cursor + 46;
    const nameEnd = nameStart + nameLength;
    const centralExtraStart = nameEnd;
    const centralEntryEnd = centralExtraStart + extraLength + entryCommentLength;
    if (centralEntryEnd > centralOffset + centralSize) throw new ClientDataFileError('XLSX ZIP 条目名称越界');
    if (containsZip64Extra(view, centralExtraStart, extraLength)) {
      throw new ClientDataFileError('XLSX ZIP 使用了不受支持的 ZIP64 扩展字段');
    }
    const entryName = decoder.decode(bytes.slice(nameStart, nameEnd)).replace(/\\/g, '/');
    const segments = entryName.split('/');
    if (entryName.includes('\0') || entryName.startsWith('/') || /^[A-Za-z]:/.test(entryName) || segments.includes('..')) {
      throw new ClientDataFileError('XLSX ZIP 包含不安全的内部路径');
    }
    if (names.has(entryName)) throw new ClientDataFileError('XLSX ZIP 包含重复的内部路径');
    if (uncompressedSize > MAX_XLSX_ENTRY_BYTES) throw new ClientDataFileError('XLSX 单个内部文件超过安全上限');
    if (uncompressedSize > 0 && (compressedSize === 0 || uncompressedSize / compressedSize > MAX_XLSX_RATIO)) {
      throw new ClientDataFileError('XLSX ZIP 压缩比超过安全上限');
    }
    if (method === 0 && compressedSize !== uncompressedSize) {
      throw new ClientDataFileError('XLSX ZIP 未压缩条目大小不一致');
    }

    if (localOffset + 30 > centralOffset || uint32(view, localOffset) !== 0x04034b50) {
      throw new ClientDataFileError('XLSX ZIP 本地文件头无效');
    }
    const localFlags = uint16(view, localOffset + 6);
    const localMethod = uint16(view, localOffset + 8);
    const localCrc32 = uint32(view, localOffset + 14);
    const localCompressedSize = uint32(view, localOffset + 18);
    const localUncompressedSize = uint32(view, localOffset + 22);
    const localNameLength = uint16(view, localOffset + 26);
    const localExtraLength = uint16(view, localOffset + 28);
    const localNameStart = localOffset + 30;
    const localNameEnd = localNameStart + localNameLength;
    const localExtraStart = localNameEnd;
    const dataStart = localExtraStart + localExtraLength;
    const dataEnd = dataStart + compressedSize;
    if (dataStart > centralOffset || dataEnd > centralOffset) {
      throw new ClientDataFileError('XLSX ZIP 压缩数据范围越界');
    }
    if (localFlags !== flags || localMethod !== method) {
      throw new ClientDataFileError('XLSX ZIP 本地文件头与中央目录不一致');
    }
    if (containsZip64Extra(view, localExtraStart, localExtraLength)) {
      throw new ClientDataFileError('XLSX ZIP 使用了不受支持的 ZIP64 扩展字段');
    }
    const localName = decoder.decode(bytes.slice(localNameStart, localNameEnd)).replace(/\\/g, '/');
    if (localName !== entryName) throw new ClientDataFileError('XLSX ZIP 本地文件名与中央目录不一致');
    let localRangeEnd = dataEnd;
    if ((flags & 0x0008) === 0) {
      if (
        localCrc32 !== crc32
        || localCompressedSize !== compressedSize
        || localUncompressedSize !== uncompressedSize
      ) {
        throw new ClientDataFileError('XLSX ZIP 本地文件大小与中央目录不一致');
      }
    } else {
      if (
        (localCrc32 !== 0 && localCrc32 !== crc32)
        || (localCompressedSize !== 0 && localCompressedSize !== compressedSize)
        || (localUncompressedSize !== 0 && localUncompressedSize !== uncompressedSize)
      ) {
        throw new ClientDataFileError('XLSX ZIP data descriptor 与本地文件头不一致');
      }
      let descriptorOffset = dataEnd;
      if (uint32(view, descriptorOffset) === 0x08074b50) descriptorOffset += 4;
      if (descriptorOffset + 12 > centralOffset) throw new ClientDataFileError('XLSX ZIP data descriptor 越界');
      if (
        uint32(view, descriptorOffset) !== crc32
        || uint32(view, descriptorOffset + 4) !== compressedSize
        || uint32(view, descriptorOffset + 8) !== uncompressedSize
      ) {
        throw new ClientDataFileError('XLSX ZIP data descriptor 与中央目录不一致');
      }
      localRangeEnd = descriptorOffset + 12;
    }
    localRanges.push({ start: localOffset, end: localRangeEnd });

    totalUncompressed += uncompressedSize;
    if (totalUncompressed > MAX_XLSX_UNCOMPRESSED_BYTES) {
      throw new ClientDataFileError('XLSX 解压总量超过安全上限');
    }
    if (uncompressedSize > MAX_BROWSER_ENTRY_BYTES || totalUncompressed > MAX_BROWSER_UNCOMPRESSED_BYTES) {
      browserDeferred = true;
    }
    names.add(entryName);
    cursor = centralEntryEnd;
  }
  if (cursor !== centralOffset + centralSize) throw new ClientDataFileError('XLSX ZIP 中央目录大小不一致');
  localRanges.sort((left, right) => left.start - right.start);
  for (let index = 1; index < localRanges.length; index += 1) {
    if (localRanges[index].start < localRanges[index - 1].end) {
      throw new ClientDataFileError('XLSX ZIP 本地条目范围重叠');
    }
  }
  if (!names.has('[Content_Types].xml') || !names.has('xl/workbook.xml')) {
    throw new ClientDataFileError('ZIP 容器不是有效的 XLSX 工作簿');
  }
  return browserDeferred
    ? { previewDeferredReason: '工作簿超过浏览器安全预览预算，将在创建项目时由服务端隔离解析' }
    : {};
}

async function parseWorkbookPreview(file: File, extension: string): Promise<ClientTabularPreview> {
  const buffer = await file.arrayBuffer();
  if (extension === '.xlsx') {
    const inspection = inspectClientXlsxArchive(buffer);
    if (inspection.previewDeferredReason) {
      return { headers: [], sampleRows: [], sampled: true, ...inspection };
    }
  } else {
    const bytes = new Uint8Array(buffer.slice(0, 8));
    if (!startsWithBytes(bytes, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])) {
      throw new ClientDataFileError('文件内容不是有效的 XLS 工作簿');
    }
    return {
      headers: [],
      sampleRows: [],
      sampled: true,
      previewDeferredReason: '旧版 XLS 文件仅由服务端隔离解析，创建项目后会读取安全预览',
    };
  }

  const XLSX = await import('xlsx');
  const workbook = XLSX.read(buffer, {
    type: 'array',
    sheetRows: CLIENT_TABULAR_SAMPLE_ROWS + 1,
    cellFormula: false,
    cellHTML: false,
    cellStyles: false,
    cellNF: false,
    bookVBA: false,
  });
  const firstSheetName = workbook.SheetNames[0];
  if (!firstSheetName) throw new ClientDataFileError('工作簿没有可读取的工作表');
  const worksheet = workbook.Sheets[firstSheetName];
  const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(worksheet, { defval: null })
    .slice(0, CLIENT_TABULAR_SAMPLE_ROWS);
  const headers = rows[0] ? Object.keys(rows[0]) : [];
  if (headers.length === 0) throw new ClientDataFileError('工作簿首个工作表缺少表头或数据行');
  assertPreviewRows(headers, rows);
  return { headers, sampleRows: rows, sampled: true };
}

export async function parseClientTabularPreview(file: File): Promise<ClientTabularPreview> {
  const extension = validateClientDataFileSelection(file);
  if (extension === '.xlsx' || extension === '.xls') {
    return parseWorkbookPreview(file, extension);
  }
  return parseDelimitedPreview(file, extension === '.tsv' ? '\t' : ',');
}
