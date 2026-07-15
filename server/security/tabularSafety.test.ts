import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  assertRendererDataPayload,
  canInlineDataset,
  inspectDelimitedFile,
  loadDelimitedRows,
} from './tabularSafety';

const tempDirectories: string[] = [];
const originalEnv = { ...process.env };

async function csvFile(content: string): Promise<string> {
  const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'scifigure-tabular-safety-'));
  const filePath = path.join(directory, 'data.csv');
  await fs.promises.writeFile(filePath, content, 'utf8');
  tempDirectories.push(directory);
  return filePath;
}

afterEach(async () => {
  process.env = { ...originalEnv };
  await Promise.all(tempDirectories.splice(0).map(directory => fs.promises.rm(directory, { recursive: true, force: true })));
});

describe('tabular safety', () => {
  it('streams metadata and stops preview collection at the requested row limit', async () => {
    const filePath = await csvFile('name,value\na,1\nb,2\nc,3\n');
    await expect(inspectDelimitedFile(filePath, ',')).resolves.toEqual({ columns: ['name', 'value'], rowCount: 3 });
    await expect(loadDelimitedRows(filePath, ',', 2)).resolves.toEqual([
      { name: 'a', value: 1 },
      { name: 'b', value: 2 },
    ]);
  });

  it('rejects excessive columns, cells and cell length', async () => {
    process.env.SCIFIGURE_TABULAR_MAX_COLUMNS = '16';
    const wideHeader = Array.from({ length: 17 }, (_, index) => `c${index}`).join(',');
    await expect(inspectDelimitedFile(await csvFile(`${wideHeader}\n`), ',')).rejects.toThrow('列数');

    process.env.SCIFIGURE_TABULAR_MAX_COLUMNS = '32';
    process.env.SCIFIGURE_TABULAR_MAX_CELLS = '10000';
    const rows = Array.from({ length: 1001 }, () => '1,2,3,4,5,6,7,8,9,10').join('\n');
    await expect(inspectDelimitedFile(await csvFile(`a,b,c,d,e,f,g,h,i,j\n${rows}\n`), ',')).rejects.toThrow('单元格总数');

    process.env.SCIFIGURE_TABULAR_MAX_CELL_CHARS = '1024';
    await expect(inspectDelimitedFile(await csvFile(`value\n${'x'.repeat(1025)}\n`), ',')).rejects.toThrow('单个数据单元');
  });

  it('validates direct renderer custom_data before serialization', () => {
    process.env.SCIFIGURE_INLINE_DATA_MAX_COLUMNS = '16';
    const row = Object.fromEntries(Array.from({ length: 17 }, (_, index) => [`c${index}`, index]));
    expect(() => assertRendererDataPayload({ dataPayload: { custom_data: [row] } })).toThrow('列数');
    expect(() => assertRendererDataPayload({ dataPayload: { custom_data: [{ value: { nested: true } }] } })).toThrow('数据单元');
    expect(() => assertRendererDataPayload({ dataPayload: { custom_data: [{ value: 1 }] } })).not.toThrow();
    expect(canInlineDataset(Array.from({ length: 17 }, (_, index) => `c${index}`), 1)).toBe(false);
    expect(() => assertRendererDataPayload({
      script: 'import pandas as pd\ndf = pd.DataFrame(_uploaded_data)',
      dataPayload: { custom_data: [], inlineData: { status: 'omitted' } },
    })).toThrow('_uploaded_file_paths');
    expect(() => assertRendererDataPayload({
      script: 'import pandas as pd\ndf = pd.read_csv(_uploaded_file_paths["data.csv"])',
      dataPayload: { custom_data: [], inlineData: { status: 'omitted' } },
    })).not.toThrow();
  });
});
