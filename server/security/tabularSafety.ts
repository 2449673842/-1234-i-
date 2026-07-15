import fs from 'node:fs';
import Papa from 'papaparse';

export class TabularLimitError extends Error {
  statusCode = 413;

  constructor(message: string) {
    super(message);
    this.name = 'TabularLimitError';
  }
}

export interface TabularSafetyLimits {
  maxRows: number;
  maxColumns: number;
  maxCells: number;
  maxCellChars: number;
}

function envInteger(name: string, fallback: number, min: number, max: number): number {
  const value = Number(process.env[name]);
  if (!Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(value)));
}

export function tabularSafetyLimits(): TabularSafetyLimits {
  return {
    maxRows: envInteger('SCIFIGURE_INLINE_DATA_MAX_ROWS', 200_000, 1_000, 2_000_000),
    maxColumns: envInteger('SCIFIGURE_INLINE_DATA_MAX_COLUMNS', 512, 16, 4_096),
    maxCells: envInteger('SCIFIGURE_INLINE_DATA_MAX_CELLS', 2_000_000, 10_000, 20_000_000),
    maxCellChars: envInteger('SCIFIGURE_INLINE_DATA_MAX_CELL_CHARS', 262_144, 1_024, 1_048_576),
  };
}

export function tabularInspectionLimits(): TabularSafetyLimits {
  return {
    maxRows: envInteger('SCIFIGURE_TABULAR_MAX_ROWS', 1_000_000, 1_000, 2_000_000),
    maxColumns: envInteger('SCIFIGURE_TABULAR_MAX_COLUMNS', 2_048, 16, 4_096),
    maxCells: envInteger('SCIFIGURE_TABULAR_MAX_CELLS', 20_000_000, 10_000, 20_000_000),
    maxCellChars: envInteger('SCIFIGURE_TABULAR_MAX_CELL_CHARS', 1_048_576, 1_024, 1_048_576),
  };
}

function assertCellValue(value: unknown, limits: TabularSafetyLimits): void {
  if (value === null || value === undefined || typeof value === 'number' || typeof value === 'boolean') return;
  if (typeof value === 'string') {
    if (value.length > limits.maxCellChars) {
      throw new TabularLimitError(`单个数据单元超过 ${limits.maxCellChars.toLocaleString()} 个字符`);
    }
    return;
  }
  throw new TabularLimitError('数据单元只能包含文本、数值、布尔值或空值');
}

function assertColumnCount(count: number, limits: TabularSafetyLimits): void {
  if (count > limits.maxColumns) {
    throw new TabularLimitError(`数据列数超过安全上限 ${limits.maxColumns.toLocaleString()}`);
  }
}

function assertRowAndCellCount(rowCount: number, cellCount: number, limits: TabularSafetyLimits): void {
  if (rowCount > limits.maxRows) {
    throw new TabularLimitError(`数据行数超过安全上限 ${limits.maxRows.toLocaleString()}`);
  }
  if (cellCount > limits.maxCells) {
    throw new TabularLimitError(`数据单元格总数超过安全上限 ${limits.maxCells.toLocaleString()}`);
  }
}

export function assertTabularShape(columns: unknown[], rowCount: number): void {
  const limits = tabularInspectionLimits();
  assertColumnCount(columns.length, limits);
  const safeRows = Math.max(0, Math.floor(Number(rowCount || 0)));
  assertRowAndCellCount(safeRows, safeRows * columns.length, limits);
  for (const column of columns) assertCellValue(String(column ?? ''), limits);
}

export function canInlineDataset(columns: unknown[], rowCount: number): boolean {
  const limits = tabularSafetyLimits();
  const safeRows = Math.max(0, Math.floor(Number(rowCount || 0)));
  return columns.length <= limits.maxColumns
    && safeRows <= limits.maxRows
    && safeRows * columns.length <= limits.maxCells;
}

export function assertRendererDataPayload(payload: unknown): void {
  const inlineState = (payload as any)?.dataPayload?.inlineData;
  const script = typeof (payload as any)?.script === 'string' ? (payload as any).script : '';
  if (inlineState?.status === 'omitted' && /\b(?:_uploaded_data|uploaded_data)\b/.test(script)) {
    throw new TabularLimitError(
      '主数据超过安全内联预算；请在脚本中通过 _uploaded_file_paths / uploaded_file_paths 按上传文件名读取',
    );
  }
  const customData = (payload as any)?.dataPayload?.custom_data;
  if (customData === undefined || customData === null) return;
  if (!Array.isArray(customData)) {
    throw new TabularLimitError('custom_data 必须是数据行数组');
  }

  const limits = tabularSafetyLimits();
  let totalCells = 0;
  let maxColumns = 0;
  for (const row of customData) {
    if (!row || typeof row !== 'object') {
      throw new TabularLimitError('custom_data 中每一行必须是对象或数组');
    }
    const values = Array.isArray(row) ? row : Object.values(row);
    const keys = Array.isArray(row) ? [] : Object.keys(row);
    maxColumns = Math.max(maxColumns, values.length);
    assertColumnCount(maxColumns, limits);
    totalCells += values.length;
    assertRowAndCellCount(customData.length, totalCells, limits);
    for (const key of keys) assertCellValue(key, limits);
    for (const value of values) assertCellValue(value, limits);
  }
}

function fatalCsvError(errors: Papa.ParseError[]): Papa.ParseError | undefined {
  return errors.find(error => error.type === 'Quotes');
}

export async function inspectDelimitedFile(
  filePath: string,
  delimiter: string,
): Promise<{ columns: string[]; rowCount: number }> {
  const limits = tabularInspectionLimits();
  return new Promise((resolve, reject) => {
    const input = fs.createReadStream(filePath, { encoding: 'utf8' });
    let settled = false;
    let columns: string[] | null = null;
    let rowCount = 0;
    let cellCount = 0;

    const fail = (error: unknown, parser?: Papa.Parser) => {
      if (settled) return;
      settled = true;
      parser?.abort();
      input.destroy();
      reject(error instanceof Error ? error : new Error(String(error)));
    };

    Papa.parse<string[]>(input, {
      delimiter,
      skipEmptyLines: true,
      dynamicTyping: false,
      step: (result, parser) => {
        if (settled) return;
        const fatal = fatalCsvError(result.errors);
        if (fatal) return fail(new Error(`CSV 解析失败: ${fatal.message}`), parser);
        try {
          const values = Array.isArray(result.data) ? result.data : [];
          assertColumnCount(values.length, limits);
          for (const value of values) assertCellValue(value, limits);
          if (columns === null) {
            columns = values.map(value => String(value ?? ''));
            if (columns.length === 0) throw new Error('数据文件缺少表头');
            return;
          }
          rowCount += 1;
          cellCount += values.length;
          assertRowAndCellCount(rowCount, cellCount, limits);
        } catch (error) {
          fail(error, parser);
        }
      },
      complete: () => {
        if (settled) return;
        settled = true;
        if (!columns) return reject(new Error('数据文件缺少表头'));
        resolve({ columns, rowCount });
      },
      error: error => fail(error),
    });
  });
}

export async function loadDelimitedRows(
  filePath: string,
  delimiter: string,
  limit?: number,
): Promise<Record<string, unknown>[]> {
  const limits = limit === undefined ? tabularSafetyLimits() : tabularInspectionLimits();
  const previewLimit = limit === undefined ? null : Math.max(1, Math.min(limits.maxRows, Math.floor(limit)));
  return new Promise((resolve, reject) => {
    const input = fs.createReadStream(filePath, { encoding: 'utf8' });
    const rows: Record<string, unknown>[] = [];
    let settled = false;
    let cellCount = 0;

    const finish = (parser?: Papa.Parser) => {
      if (settled) return;
      settled = true;
      parser?.abort();
      input.destroy();
      resolve(rows);
    };
    const fail = (error: unknown, parser?: Papa.Parser) => {
      if (settled) return;
      settled = true;
      parser?.abort();
      input.destroy();
      reject(error instanceof Error ? error : new Error(String(error)));
    };

    Papa.parse<Record<string, unknown>>(input, {
      delimiter,
      header: true,
      skipEmptyLines: true,
      dynamicTyping: true,
      step: (result, parser) => {
        if (settled) return;
        const fatal = fatalCsvError(result.errors);
        if (fatal) return fail(new Error(`CSV 解析失败: ${fatal.message}`), parser);
        try {
          const row = result.data;
          const keys = Object.keys(row);
          const values = Object.values(row);
          assertColumnCount(keys.length, limits);
          cellCount += values.length;
          assertRowAndCellCount(rows.length + 1, cellCount, limits);
          for (const key of keys) assertCellValue(key, limits);
          for (const value of values) assertCellValue(value, limits);
          rows.push(row);
          if (previewLimit !== null && rows.length >= previewLimit) finish(parser);
        } catch (error) {
          fail(error, parser);
        }
      },
      complete: () => finish(),
      error: error => fail(error),
    });
  });
}
