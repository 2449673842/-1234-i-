import { describe, expect, it } from 'vitest';
import { blockingRRisks, scanRScriptRisks } from './rRiskScanner';

describe('scanRScriptRisks', () => {
  it('allows ordinary ggplot and uploaded-file reads', () => {
    const findings = scanRScriptRisks(`
      library(ggplot2)
      df <- read.csv(uploaded_file_paths[["main.csv"]])
      p <- ggplot(df, aes(x, y)) + geom_point()
    `);
    expect(findings).toEqual([]);
  });

  it('detects process, network, dynamic loading, and destructive file calls', () => {
    const findings = scanRScriptRisks(`
      system2("sh", c("-c", "id"))
      download.file("https://example.com/a", "a")
      base::dyn.load("payload.so")
      unlink("/tmp/example", recursive = TRUE)
    `);
    expect(findings.map((finding) => finding.category)).toEqual([
      'process', 'network', 'dynamic_code', 'filesystem',
    ]);
    expect(blockingRRisks(findings)).toHaveLength(4);
  });

  it('ignores dangerous words inside strings and comments', () => {
    const findings = scanRScriptRisks(`
      # system("not executed")
      label <- "download.file('not executed')"
      package_label <- "library(processx)"
      p <- ggplot(data.frame(x = 1, y = 1), aes(x, y)) + geom_text(label = label)
    `);
    expect(findings).toEqual([]);
  });

  it('reports capability packages without blocking package loading alone', () => {
    const findings = scanRScriptRisks(`
      library(processx)
      require(package = "httr")
    `);
    expect(findings.map((finding) => finding.symbol)).toEqual(['processx', 'httr']);
    expect(blockingRRisks(findings)).toEqual([]);
  });

  it('detects backtick, dynamic dispatch, and namespaced dangerous calls', () => {
    const findings = scanRScriptRisks(`
      base::\`system\`("id")
      get("system2")("id")
      processx::run("id")
      httr::GET("https://example.com")
      eval(parse(text = "system('id')"))
    `);
    expect(blockingRRisks(findings).map((finding) => finding.symbol)).toEqual([
      'base::system',
      'get(system2)',
      'processx::run',
      'parse(system)',
      'httr::GET',
    ]);
    expect(blockingRRisks(findings)).toHaveLength(5);
  });

  it('keeps eval and parse visible without classifying them as blocking', () => {
    const findings = scanRScriptRisks(`
      setwd(".")
      Sys.setenv(LANGUAGE = "en")
      source("helper.R")
      eval(parse(text = expression_text))
    `);
    expect(findings.map((finding) => finding.symbol)).toEqual(['setwd', 'Sys.setenv', 'source', 'eval', 'parse']);
    expect(blockingRRisks(findings)).toEqual([]);
  });
});
