import { describe, expect, it } from 'vitest';
import { extractReferencedDataFiles, matchesReferencedDataFile } from './scriptDataDependencies';

describe('script data dependencies', () => {
  it('extracts Python uploaded paths and pandas readers without duplicates', () => {
    expect(extractReferencedDataFiles(`
stats = pd.read_csv(_uploaded_file_paths["stats.csv"])
matrix = pd.read_excel("input/matrix.xlsx")
again = pandas.read_csv('stats.csv')
`)).toEqual(['stats.csv', 'matrix.xlsx']);
  });

  it('extracts R uploaded paths and readers', () => {
    expect(extractReferencedDataFiles(`
stats <- read.csv(uploaded_file_paths[["统计表.csv"]])
matrix <- readxl::read_excel("data/matrix.xlsx")
direct <- read.csv("stats.csv")
`)).toEqual(['统计表.csv', 'matrix.xlsx', 'stats.csv']);
  });

  it('ignores URLs and non-tabular files', () => {
    expect(extractReferencedDataFiles(`
pd.read_csv("https://example.test/data.csv")
open("notes.json")
`)).toEqual([]);
  });

  it('matches file names case-insensitively', () => {
    expect(matchesReferencedDataFile('DATA.CSV', 'data.csv')).toBe(true);
  });
});
