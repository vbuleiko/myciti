import JSON5 from 'json5';

export class ExtractError extends Error {
  constructor(
    message: string,
    readonly variable: string,
  ) {
    super(message);
    this.name = 'ExtractError';
  }
}

/**
 * Find `name = <literal>` in inline scripts (with or without var/let/const) and return the
 * literal's source text. The literal must start with `[` or `{`; its end is found by scanning
 * brackets while skipping strings and comments. No code is ever evaluated.
 */
export function findJsLiteral(html: string, name: string): string | null {
  const re = new RegExp(`(?:^|[^\\w$.])(?:(?:var|let|const)\\s+)?${escapeRe(name)}\\s*=\\s*`, 'g');
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    const start = m.index + m[0].length;
    const ch = html[start];
    if (ch !== '[' && ch !== '{') continue;
    const end = scanLiteralEnd(html, start);
    if (end > start) return html.slice(start, end);
  }
  return null;
}

/** Parse a JS literal: JSON.parse first, JSON5 as a fallback. */
export function parseJsLiteral(src: string, name: string): unknown {
  try {
    return JSON.parse(src);
  } catch {
    try {
      return JSON5.parse(src);
    } catch (e) {
      throw new ExtractError(`could not parse \`${name}\`: ${(e as Error).message}`, name);
    }
  }
}

export function extractJsVar(html: string, name: string): unknown {
  const src = findJsLiteral(html, name);
  if (src === null) throw new ExtractError(`variable \`${name}\` not found in page`, name);
  return parseJsLiteral(src, name);
}

/** Like extractJsVar but returns undefined when the variable is absent. */
export function extractOptionalJsVar(html: string, name: string): unknown {
  const src = findJsLiteral(html, name);
  return src === null ? undefined : parseJsLiteral(src, name);
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Index just past the bracket that closes the one at `start`, or -1. */
function scanLiteralEnd(s: string, start: number): number {
  const stack: string[] = [];
  let i = start;
  const n = s.length;
  while (i < n) {
    const c = s[i]!;
    if (c === '"' || c === "'" || c === '`') {
      i = skipString(s, i, c);
      if (i < 0) return -1;
      continue;
    }
    if (c === '/' && s[i + 1] === '/') {
      const nl = s.indexOf('\n', i);
      i = nl < 0 ? n : nl;
      continue;
    }
    if (c === '/' && s[i + 1] === '*') {
      const endC = s.indexOf('*/', i + 2);
      if (endC < 0) return -1;
      i = endC + 2;
      continue;
    }
    if (c === '[' || c === '{') stack.push(c === '[' ? ']' : '}');
    else if (c === ']' || c === '}') {
      if (stack.pop() !== c) return -1;
      if (stack.length === 0) return i + 1;
    } else if (c === '<' && s.startsWith('</script', i)) {
      return -1; // ran out of the script element
    }
    i++;
  }
  return -1;
}

function skipString(s: string, start: number, quote: string): number {
  let i = start + 1;
  while (i < s.length) {
    const c = s[i]!;
    if (c === '\\') {
      i += 2;
      continue;
    }
    if (c === quote) return i + 1;
    if (c === '\n' && quote !== '`') return -1;
    i++;
  }
  return -1;
}
