import { describe, expect, it } from 'vitest';
import { scanRScriptDeterminism } from './rDeterminismScanner';

describe('scanRScriptDeterminism', () => {
  it('does not warn for random calls after a fixed set.seed', () => {
    expect(scanRScriptDeterminism(`
      set.seed(20260722)
      x <- runif(4)
      y <- rnorm(4)
      z <- sample(x, 2)
    `)).toEqual([]);
  });

  it('reports unseeded random calls with render diagnostic fields', () => {
    const warnings = scanRScriptDeterminism(`
      x <- runif(4)
      y <- stats::rnorm(4)
      z <- sample(x, 2)
    `);

    expect(warnings.map((warning) => warning.symbol)).toEqual(['runif', 'stats::rnorm', 'sample']);
    expect(warnings).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'non_deterministic_source', category: 'random', line: 2 }),
    ]));
  });

  it('does not mistake a user-defined runif for the base random generator', () => {
    const warnings = scanRScriptDeterminism(`
      runif <- function(n) rep(0, n)
      values <- runif(4)
    `);

    expect(warnings).toEqual([]);
  });

  it('does not treat missing or dynamic seeds as fixed', () => {
    const dynamicSeedWarnings = scanRScriptDeterminism(`
      set.seed(Sys.time())
      runif(1)
    `);
    const missingSeedWarnings = scanRScriptDeterminism(`
      set.seed(NULL)
      rnorm(1)
    `);

    expect(dynamicSeedWarnings.map((warning) => warning.symbol)).toEqual(['Sys.time', 'runif']);
    expect(missingSeedWarnings.map((warning) => warning.symbol)).toEqual(['rnorm']);
  });

  it('reports clocks, environment, files, network, and process side effects', () => {
    const warnings = scanRScriptDeterminism(`
      Sys.Date()
      Sys.getenv('LANG')
      read.csv('input.csv')
      download.file('https://example.com/data.csv', 'data.csv')
      system2('echo', 'render')
    `);

    expect(warnings.map((warning) => warning.category)).toEqual([
      'clock', 'environment', 'filesystem', 'network', 'process',
    ]);
  });

  it('does not warn when file reads use platform-declared uploaded paths', () => {
    const warnings = scanRScriptDeterminism(`
      df <- read.csv(uploaded_file_paths[["analysis.csv"]], check.names = FALSE)
      df2 <- utils::read.delim(_uploaded_file_paths[["analysis.tsv"]])
      df3 <- read.table(csv_json_paths[["analysis.csv"]])
    `);

    expect(warnings).toEqual([]);
  });

  it('does not warn when read.csv parses inline text', () => {
    const warnings = scanRScriptDeterminism(`
      df <- read.csv(text = "group,value\\na,1\\nb,2")
    `);

    expect(warnings).toEqual([]);
  });

  it('does not warn when file reads use aliases for declared uploaded paths', () => {
    const warnings = scanRScriptDeterminism(`
      csv_path <- uploaded_file_paths[["analysis.csv"]]
      tsv_path <- _uploaded_file_paths[["analysis.tsv"]]
      df <- read.csv(csv_path)
      df2 <- read.delim(tsv_path)
    `);

    expect(warnings).toEqual([]);
  });

  it('still reports undeclared filesystem reads', () => {
    const warnings = scanRScriptDeterminism(`
      df <- read.csv(file.path(getwd(), "analysis.csv"))
      lines <- readLines("notes.txt")
    `);

    expect(warnings.map((warning) => warning.symbol)).toEqual(['read.csv', 'readLines']);
  });

  it('ignores matching names in strings and comments', () => {
    expect(scanRScriptDeterminism(`
      # set.seed(1); runif(1); Sys.time(); system('date')
      label <- "rnorm(2), Sys.getenv('HOME'), read.csv('input.csv')"
      set.seed(7)
      sample(1:5, 2)
    `)).toEqual([]);
  });
});
