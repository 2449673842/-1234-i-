export interface ColorCodePatch {
  target_id: string;
  new_value: string;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function applyColorCodePatch(script: string, patch: ColorCodePatch): string {
  const lines = script.split('\n');
  if (!/^#[0-9A-Fa-f]{6}$/.test(patch.new_value)) {
    throw new Error(`无效的颜色值: ${patch.new_value}`);
  }

  const targetId = String(patch.target_id || '');
  const inlineMatch = targetId.match(/^inline_(\d+)_(\d+)_([0-9a-fA-F]{6})$/);
  if (inlineMatch) {
    const lineIndex = Number(inlineMatch[1]) - 1;
    const occurrenceIndex = Number(inlineMatch[2]);
    const originalHex = `#${inlineMatch[3]}`;
    if (lineIndex < 0 || lineIndex >= lines.length) {
      throw new Error(`内联颜色行号无效: ${targetId}`);
    }
    let seen = 0;
    lines[lineIndex] = lines[lineIndex].replace(/#[0-9A-Fa-f]{6}/g, (match) => {
      if (match.toLowerCase() !== originalHex.toLowerCase()) return match;
      seen += 1;
      return seen === occurrenceIndex ? patch.new_value : match;
    });
    if (seen < occurrenceIndex) {
      throw new Error(`未找到内联颜色: ${targetId}`);
    }
    return lines.join('\n');
  }

  const safeTarget = escapeRegExp(targetId);
  const regexConstant = new RegExp(`^(${safeTarget})(?:\\s*:\\s*[^=]+)?\\s*=\\s*["'](#[0-9A-Fa-f]{6})["']`);
  const scopedDictMatch = /^dict_(.+)__(.*)$/.exec(targetId);
  const cleanKey = targetId.replace(/^dict_/, '');
  const safeKey = escapeRegExp(scopedDictMatch ? scopedDictMatch[2] : cleanKey);
  const regexDict = new RegExp(`(["']${safeKey}["']\\s*:\\s*)["'](#[0-9A-Fa-f]{6})["']`);
  const scopedDictName = scopedDictMatch ? scopedDictMatch[1] : null;
  let insideScopedDict = false;
  let scopedBraceDepth = 0;
  let replacementCount = 0;
  const replaceDictColor = (line: string) => line.replace(regexDict, (_match, prefix) => {
    replacementCount += 1;
    return `${prefix}"${patch.new_value}"`;
  });

  const updatedLines = lines.map(line => {
    const trimmed = line.trim();
    if (regexConstant.test(trimmed)) {
      replacementCount += 1;
      return line.replace(/(#[0-9A-Fa-f]{6})/, patch.new_value);
    }

    if (scopedDictName) {
      const startsScopedDict = new RegExp(
        `^${escapeRegExp(scopedDictName)}(?:\\s*:\\s*[^=]+)?\\s*=\\s*\\{`,
      ).test(trimmed);
      if (startsScopedDict) {
        insideScopedDict = true;
        scopedBraceDepth = 0;
      }
      if (insideScopedDict) {
        scopedBraceDepth += (line.match(/\{/g) || []).length;
        scopedBraceDepth -= (line.match(/\}/g) || []).length;
        const nextLine = regexDict.test(trimmed) ? replaceDictColor(line) : line;
        if (scopedBraceDepth <= 0) insideScopedDict = false;
        return nextLine;
      }
      return line;
    }

    return regexDict.test(trimmed) ? replaceDictColor(line) : line;
  });

  if (replacementCount === 0) {
    throw new Error(`未找到可替换的颜色常量: ${targetId}`);
  }
  return updatedLines.join('\n');
}
