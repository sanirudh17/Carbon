/**
 * Lightweight, zero-dependency, XSS-safe syntax highlighter & language detector
 * for Carbon code previews. Produces typed spans rendered as React nodes so
 * search-match DOM highlighting (highlightPreview) composes cleanly on top.
 */

export type SyntaxTokenType =
  | 'plain'
  | 'comment'
  | 'string'
  | 'keyword'
  | 'number'
  | 'type'
  | 'fn'
  | 'attr'
  | 'operator'
  | 'punct';

export interface SyntaxToken {
  type: SyntaxTokenType;
  text: string;
}

const MAX_HIGHLIGHT_CHARS = 50_000;

const JS_TS_KEYWORDS = new Set([
  'abstract', 'any', 'as', 'asserts', 'async', 'await', 'bigint', 'boolean', 'break',
  'case', 'catch', 'class', 'const', 'continue', 'debugger', 'declare', 'default',
  'delete', 'do', 'else', 'enum', 'export', 'extends', 'false', 'finally', 'for',
  'from', 'function', 'get', 'if', 'implements', 'import', 'in', 'infer', 'instanceof',
  'interface', 'is', 'keyof', 'let', 'module', 'namespace', 'never', 'new', 'null',
  'number', 'object', 'of', 'override', 'private', 'protected', 'public', 'readonly',
  'return', 'satisfies', 'set', 'static', 'string', 'super', 'switch', 'symbol',
  'this', 'throw', 'true', 'try', 'type', 'typeof', 'undefined', 'unknown', 'var',
  'void', 'while', 'with', 'yield',
]);

const PYTHON_KEYWORDS = new Set([
  'False', 'None', 'True', 'and', 'as', 'assert', 'async', 'await', 'break', 'case',
  'class', 'continue', 'def', 'del', 'elif', 'else', 'except', 'finally', 'for',
  'from', 'global', 'if', 'import', 'in', 'is', 'lambda', 'match', 'nonlocal', 'not',
  'or', 'pass', 'raise', 'return', 'self', 'try', 'while', 'with', 'yield',
]);

const PYTHON_BUILTINS = new Set([
  'int', 'str', 'float', 'bool', 'list', 'dict', 'set', 'tuple', 'bytes', 'object',
  'Any', 'Optional', 'Union', 'List', 'Dict', 'Set', 'Tuple', 'Callable', 'Iterable',
  'Sequence', 'Mapping', 'Path', 'Exception', 'ValueError', 'TypeError', 'KeyError',
]);

const RUST_KEYWORDS = new Set([
  'as', 'async', 'await', 'break', 'const', 'continue', 'crate', 'dyn', 'else', 'enum',
  'extern', 'false', 'fn', 'for', 'if', 'impl', 'in', 'let', 'loop', 'match', 'mod',
  'move', 'mut', 'pub', 'ref', 'return', 'Self', 'self', 'static', 'struct', 'super',
  'trait', 'true', 'type', 'unsafe', 'use', 'where', 'while',
]);

const RUST_TYPES = new Set([
  'bool', 'char', 'str', 'u8', 'u16', 'u32', 'u64', 'u128', 'usize',
  'i8', 'i16', 'i32', 'i64', 'i128', 'isize', 'f32', 'f64',
  'String', 'Vec', 'Option', 'Result', 'Box', 'Arc', 'Rc', 'Mutex', 'RwLock',
  'HashMap', 'HashSet', 'BTreeMap', 'BTreeSet', 'VecDeque', 'Path', 'PathBuf',
  'Cow', 'Pin', 'Future', 'Some', 'None', 'Ok', 'Err',
]);

const GO_KEYWORDS = new Set([
  'break', 'case', 'chan', 'const', 'continue', 'default', 'defer', 'else', 'fallthrough',
  'for', 'func', 'go', 'goto', 'if', 'import', 'interface', 'map', 'package', 'range',
  'return', 'select', 'struct', 'switch', 'type', 'var', 'true', 'false', 'nil', 'iota',
]);

const GO_TYPES = new Set([
  'any', 'bool', 'byte', 'comparable', 'complex64', 'complex128', 'error', 'float32',
  'float64', 'int', 'int8', 'int16', 'int32', 'int64', 'rune', 'string', 'uint',
  'uint8', 'uint16', 'uint32', 'uint64', 'uintptr',
]);

const C_LIKE_KEYWORDS = new Set([
  'abstract', 'auto', 'bool', 'break', 'case', 'catch', 'char', 'class', 'const',
  'constexpr', 'continue', 'default', 'delete', 'do', 'double', 'else', 'enum',
  'explicit', 'extends', 'extern', 'false', 'final', 'finally', 'float', 'for',
  'foreach', 'friend', 'goto', 'if', 'implements', 'import', 'in', 'inline', 'int',
  'interface', 'internal', 'long', 'namespace', 'new', 'noexcept', 'null', 'nullptr',
  'operator', 'out', 'override', 'package', 'private', 'protected', 'public', 'readonly',
  'record', 'ref', 'register', 'return', 'sealed', 'short', 'signed', 'sizeof', 'static',
  'struct', 'super', 'switch', 'template', 'this', 'throw', 'throws', 'true', 'try',
  'typedef', 'typename', 'union', 'unsigned', 'using', 'var', 'virtual', 'void',
  'volatile', 'while', 'async', 'await',
]);

const C_LIKE_TYPES = new Set([
  'size_t', 'ssize_t', 'ptrdiff_t', 'int8_t', 'int16_t', 'int32_t', 'int64_t',
  'uint8_t', 'uint16_t', 'uint32_t', 'uint64_t', 'std', 'string', 'vector', 'map',
  'String', 'Object', 'List', 'Map', 'Set', 'Task', 'IEnumerable', 'Optional',
]);

const SQL_KEYWORDS = new Set([
  'SELECT', 'FROM', 'WHERE', 'INSERT', 'INTO', 'VALUES', 'UPDATE', 'SET', 'DELETE',
  'CREATE', 'TABLE', 'ALTER', 'DROP', 'INDEX', 'VIEW', 'TRIGGER', 'JOIN', 'INNER',
  'LEFT', 'RIGHT', 'FULL', 'OUTER', 'CROSS', 'ON', 'USING', 'AS', 'AND', 'OR', 'NOT',
  'IN', 'IS', 'NULL', 'LIKE', 'ILIKE', 'GLOB', 'BETWEEN', 'ORDER', 'BY', 'GROUP',
  'HAVING', 'LIMIT', 'OFFSET', 'DISTINCT', 'UNION', 'INTERSECT', 'EXCEPT', 'ALL',
  'CASE', 'WHEN', 'THEN', 'ELSE', 'END', 'WITH', 'RECURSIVE', 'PRIMARY', 'KEY',
  'FOREIGN', 'REFERENCES', 'UNIQUE', 'CHECK', 'DEFAULT', 'CONSTRAINT', 'CASCADE',
  'COUNT', 'SUM', 'AVG', 'MIN', 'MAX', 'COALESCE', 'NULLIF', 'CAST', 'EXISTS',
  'RETURNING', 'CONFLICT', 'DO', 'NOTHING', 'BEGIN', 'COMMIT', 'ROLLBACK',
  'TRANSACTION', 'ASC', 'DESC', 'TRUE', 'FALSE', 'IF', 'REPLACE', 'PRAGMA',
  'INTEGER', 'TEXT', 'REAL', 'BLOB', 'VARCHAR', 'BOOLEAN', 'TIMESTAMP', 'JSONB',
]);

const SHELL_KEYWORDS = new Set([
  'if', 'then', 'else', 'elif', 'fi', 'for', 'in', 'do', 'done', 'while', 'until',
  'case', 'esac', 'function', 'return', 'export', 'local', 'readonly', 'exit', 'true',
  'false', 'echo', 'printf', 'cd', 'ls', 'grep', 'sed', 'awk', 'cat', 'curl', 'wget',
  'git', 'npm', 'npx', 'pnpm', 'yarn', 'cargo', 'rustc', 'python', 'python3', 'node',
  'docker', 'kubectl', 'sudo', 'chmod', 'chown', 'mkdir', 'rm', 'cp', 'mv', 'find',
  'foreach', 'param', 'try', 'catch', 'finally', 'throw', 'switch', 'filter', 'begin',
  'process', 'end', 'powershell', 'pwsh',
]);

const GENERIC_KEYWORDS = new Set([
  ...JS_TS_KEYWORDS,
  ...PYTHON_KEYWORDS,
  ...RUST_KEYWORDS,
  ...GO_KEYWORDS,
]);

const KNOWN_GENERIC_TYPES = new Set([
  ...RUST_TYPES,
  ...PYTHON_BUILTINS,
  ...GO_TYPES,
  'Array', 'Promise', 'Record', 'Partial', 'Required', 'Pick', 'Omit', 'Readonly',
  'Map', 'Set', 'WeakMap', 'WeakSet', 'Date', 'RegExp', 'Error', 'URL', 'Buffer',
  'HTMLElement', 'HTMLDivElement', 'HTMLInputElement', 'React', 'FC', 'RefObject',
]);

/**
 * Shared language detector used by both ClipPreview labels (`Code (Rust)`)
 * and `highlightCodeTokens`.
 */
export function detectCodeLanguage(text: string): string | null {
  const t = (text || '').trim();
  if (!t) return null;

  // HTML / XML
  if (/^\s*<(!DOCTYPE\s+html|html[\s>]|xml[\s?]|svg[\s>])/i.test(t) || /^\s*<[a-z][\w-]*(\s[^>]*)?>[\s\S]*<\/[a-z][\w-]*>\s*$/i.test(t)) {
    return 'HTML';
  }
  // JSON
  if ((t.startsWith('{') && t.endsWith('}')) || (t.startsWith('[') && t.endsWith(']'))) {
    try {
      const parsed = JSON.parse(t);
      if (parsed && typeof parsed === 'object') return 'JSON';
    } catch {
      /* not strict JSON — fall through */
    }
  }
  // CSS / SCSS
  if (/^\s*(?:@media|@keyframes|@supports|:root|[a-z.#*][\w.#:>\s[\]="'~+*-]*)\s*\{[\s\S]*\}/i.test(t) && /[a-z-]+\s*:\s*[^;{}]+;/.test(t)) {
    return 'CSS';
  }
  // Rust
  if (/\b(fn\s+\w+\s*[<(]|pub\s+(?:crate\s+)?(fn|struct|enum|mod|trait|use)\b|impl(?:<[^>]+>)?\s+\w+|let\s+mut\b|use\s+[a-z_]\w*::|#\[derive\()/.test(t)) {
    return 'Rust';
  }
  // Go
  if (/^\s*package\s+[a-z]\w*\b/m.test(t) || /\bfunc\s+(?:\([^)]+\)\s*)?\w+\s*\(/.test(t) || (/\bdefer\b|\bgo\s+\w+\(|:=/.test(t) && /[{}]/.test(t))) {
    return 'Go';
  }
  // C / C++
  if (/^\s*#include\s*[<"][^>"]+[>"]/m.test(t) || /\bstd::\w+|\bnullptr\b|\btemplate\s*</.test(t)) {
    return 'C++';
  }
  // SQL
  if (/^\s*(?:SELECT|INSERT\s+INTO|UPDATE|DELETE\s+FROM|CREATE\s+(?:TABLE|INDEX|VIEW)|ALTER\s+TABLE|DROP\s+(?:TABLE|INDEX|VIEW)|WITH\s+\w+\s+AS)\b/i.test(t)) {
    return 'SQL';
  }
  // TypeScript
  if (
    (/\b(interface|type)\s+[A-Z]\w*\s*(?:<[^>]+>)?\s*[={]/.test(t) ||
      /:\s*(?:string|number|boolean|unknown|void|never|React\.|Record<|Promise<|Array<|RefObject<)\b/.test(t) ||
      /:\s*'[^']*'\s*\|/.test(t) ||
      /\bas\s+const\b/.test(t)) &&
    /[{}()<>|;=]/.test(t)
  ) {
    return 'TypeScript';
  }
  // JavaScript
  if (/\b(export|import|const|let|var|function|async|await)\b/.test(t) && (/[{}();]/.test(t) || /=>/.test(t))) {
    return 'JavaScript';
  }
  // Python
  if (/^\s*(?:async\s+)?def\s+\w+\s*\([^)]*\)\s*(?:->\s*[^:]+)?:\s*$/m.test(t) || (/^\s*(?:class\s+\w+|from\s+[\w.]+\s+import\s+)/m.test(t) && /:\s*$/m.test(t))) {
    return 'Python';
  }
  // Java / C#
  if (/\b(?:public|private|protected)\s+(?:static\s+)?(?:class|interface|record|void|async\s+Task)\b/.test(t) || /\bSystem\.Console\b|\bSystem\.out\.println\b/.test(t)) {
    return /\bnamespace\b|\busing\s+System\b|\bTask</.test(t) ? 'C#' : 'Java';
  }
  // Shell / PowerShell
  if (/^#!\/(?:usr\/bin\/env\s+)?(?:ba|z|fi)?sh\b|^\s*(?:export\s+\w+=|Set-Location\b|Get-ChildItem\b|Get-Process\b|Write-Output\b|\$\w+\s*=)/m.test(t)) {
    return 'Shell';
  }
  // TOML
  if (/^\s*\[[a-zA-Z0-9_.-]+\]\s*$/m.test(t) && /^\s*[a-zA-Z0-9_.-]+\s*=\s*.+$/m.test(t)) {
    return 'TOML';
  }
  // YAML (at least 2 key: value lines, not prose sentences)
  if (/^(?:[a-zA-Z_][\w.-]*:\s*(?:\S.*)?\r?\n){2,}/.test(t) && !/[{};]/.test(t)) {
    return 'YAML';
  }
  return null;
}

function pushToken(tokens: SyntaxToken[], type: SyntaxTokenType, text: string) {
  if (!text) return;
  const last = tokens[tokens.length - 1];
  if (last && last.type === type) {
    last.text += text;
  } else {
    tokens.push({ type, text });
  }
}

function tokenizeJson(code: string): SyntaxToken[] {
  const tokens: SyntaxToken[] = [];
  const re = /("(?:\\.|[^"\\])*")(\s*:)?|\b(true|false|null)\b|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|[{}[\],:]/g;
  let lastIdx = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(code)) !== null) {
    if (m.index > lastIdx) {
      pushToken(tokens, 'plain', code.slice(lastIdx, m.index));
    }
    if (m[1]) {
      pushToken(tokens, m[2] ? 'attr' : 'string', m[1]);
      if (m[2]) pushToken(tokens, 'punct', m[2]);
    } else if (m[3]) {
      pushToken(tokens, 'keyword', m[3]);
    } else if (/^[{}[\],:]$/.test(m[0])) {
      pushToken(tokens, 'punct', m[0]);
    } else {
      pushToken(tokens, 'number', m[0]);
    }
    lastIdx = re.lastIndex;
  }
  if (lastIdx < code.length) pushToken(tokens, 'plain', code.slice(lastIdx));
  return tokens;
}

function tokenizeHtml(code: string): SyntaxToken[] {
  const tokens: SyntaxToken[] = [];
  const re = /<!--[\s\S]*?-->|<!DOCTYPE[^>]*>|<\/?[a-zA-Z][\w:-]*|\/?>|([a-zA-Z_:@][\w:.-]*)(\s*=\s*)("(?:[^"]*)"|'(?:[^']*)'|\{[^}]*\})/g;
  let lastIdx = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(code)) !== null) {
    if (m.index > lastIdx) pushToken(tokens, 'plain', code.slice(lastIdx, m.index));
    const full = m[0];
    if (full.startsWith('<!--')) {
      pushToken(tokens, 'comment', full);
    } else if (full.startsWith('<!DOCTYPE') || full.startsWith('<!doctype')) {
      pushToken(tokens, 'keyword', full);
    } else if (m[1]) {
      pushToken(tokens, 'attr', m[1]);
      pushToken(tokens, 'punct', m[2]);
      pushToken(tokens, 'string', m[3]);
    } else if (full.startsWith('<')) {
      const prefix = full.startsWith('</') ? '</' : '<';
      pushToken(tokens, 'punct', prefix);
      pushToken(tokens, 'keyword', full.slice(prefix.length));
    } else {
      pushToken(tokens, 'punct', full);
    }
    lastIdx = re.lastIndex;
  }
  if (lastIdx < code.length) pushToken(tokens, 'plain', code.slice(lastIdx));
  return tokens;
}

function tokenizeCss(code: string): SyntaxToken[] {
  const tokens: SyntaxToken[] = [];
  const re = /\/\*[\s\S]*?\*\/|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|@[a-zA-Z-]+|!important\b|#[0-9a-fA-F]{3,8}\b|--[a-zA-Z0-9-]+|([a-zA-Z-]+)(\s*:)|\b([a-zA-Z-]+)(?=\()|\b\d+(?:\.\d+)?(?:px|rem|em|vh|vw|dvh|dvw|%|ms|s|deg|fr|ch)?\b|[{}();:,]/g;
  let lastIdx = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(code)) !== null) {
    if (m.index > lastIdx) pushToken(tokens, 'plain', code.slice(lastIdx, m.index));
    const full = m[0];
    if (full.startsWith('/*')) {
      pushToken(tokens, 'comment', full);
    } else if (full.startsWith('"') || full.startsWith("'")) {
      pushToken(tokens, 'string', full);
    } else if (full.startsWith('@') || full === '!important') {
      pushToken(tokens, 'keyword', full);
    } else if (full.startsWith('#') || full.startsWith('--')) {
      pushToken(tokens, 'type', full);
    } else if (m[1]) {
      pushToken(tokens, 'attr', m[1]);
      pushToken(tokens, 'punct', m[2]);
    } else if (m[3]) {
      pushToken(tokens, 'fn', m[3]);
    } else if (/^[{}();:,]$/.test(full)) {
      pushToken(tokens, 'punct', full);
    } else {
      pushToken(tokens, 'number', full);
    }
    lastIdx = re.lastIndex;
  }
  if (lastIdx < code.length) pushToken(tokens, 'plain', code.slice(lastIdx));
  return tokens;
}

function tokenizeYamlToml(code: string): SyntaxToken[] {
  const tokens: SyntaxToken[] = [];
  const re = /#[^\n]*|^\s*\[[^\]]+\]|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|(^|\n)(\s*[a-zA-Z0-9_.-]+)(\s*[:=])|\b(true|false|null|yes|no)\b|-?\b\d+(?:\.\d+)?\b|[{}[\],]/gm;
  let lastIdx = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(code)) !== null) {
    if (m.index > lastIdx) pushToken(tokens, 'plain', code.slice(lastIdx, m.index));
    const full = m[0];
    if (full.startsWith('#')) {
      pushToken(tokens, 'comment', full);
    } else if (/^\s*\[/.test(full) && full.endsWith(']') && full.length > 2) {
      pushToken(tokens, 'type', full);
    } else if (full.startsWith('"') || full.startsWith("'")) {
      pushToken(tokens, 'string', full);
    } else if (m[2] && m[3]) {
      if (m[1]) pushToken(tokens, 'plain', m[1]);
      pushToken(tokens, 'attr', m[2]);
      pushToken(tokens, 'punct', m[3]);
    } else if (m[4]) {
      pushToken(tokens, 'keyword', m[4]);
    } else if (/^[{}[\],]$/.test(full)) {
      pushToken(tokens, 'punct', full);
    } else {
      pushToken(tokens, 'number', full);
    }
    lastIdx = re.lastIndex;
  }
  if (lastIdx < code.length) pushToken(tokens, 'plain', code.slice(lastIdx));
  return tokens;
}

function isPascalCaseType(word: string): boolean {
  // Multi-hump PascalCase (e.g. ClipItem, HttpClient, HashMap) or known type —
  // avoids coloring ordinary capitalized English words like "Please" or "Hello".
  if (KNOWN_GENERIC_TYPES.has(word)) return true;
  if (/^[A-Z][a-z]+[A-Z][A-Za-z0-9_]*$/.test(word)) return true;
  if (/^[A-Z]{2,}[A-Z0-9_]*$/.test(word) && word.length >= 2) return true;
  return false;
}

function tokenizeGeneric(code: string, lang: string | null): SyntaxToken[] {
  const tokens: SyntaxToken[] = [];
  const isPy = lang === 'Python';
  const isShell = lang === 'Shell';
  const isRust = lang === 'Rust';
  const isGo = lang === 'Go';
  const isCLike = lang === 'C++' || lang === 'Java' || lang === 'C#';
  const isSql = lang === 'SQL';

  const keywords = isPy
    ? PYTHON_KEYWORDS
    : isRust
      ? RUST_KEYWORDS
      : isGo
        ? GO_KEYWORDS
        : isCLike
          ? C_LIKE_KEYWORDS
          : isSql
            ? SQL_KEYWORDS
            : isShell
              ? SHELL_KEYWORDS
              : lang === 'JavaScript' || lang === 'TypeScript'
                ? JS_TS_KEYWORDS
                : GENERIC_KEYWORDS;

  const builtInTypes = isRust
    ? RUST_TYPES
    : isPy
      ? PYTHON_BUILTINS
      : isGo
        ? GO_TYPES
        : isCLike
          ? C_LIKE_TYPES
          : KNOWN_GENERIC_TYPES;

  const pattern = isSql
    ? /--[^\n]*|\/\*[\s\S]*?\*\/|'(?:''|[^'])*'|"(?:\\.|[^"\\])*"|\b\d+(?:\.\d+)?\b|\b[A-Za-z_]\w*\b|<>|!=|<=|>=|::|[(),;.*=<>!+-]/g
    : isShell
      ? /#[^\n]*|"(?:\\.|[^"\\])*"|'[^']*'|\$\{[^}]+\}|\$[A-Za-z_][\w:]*|(?:^|(?<=\s))--?[A-Za-z][\w-]*|\b0x[0-9a-fA-F]+\b|\b\d+(?:\.\d+)?\b|\b[A-Za-z_][\w-]*\b|&&|\|\||>>|<<|[|><;{}()[\]]/g
      : isPy
        ? /#[^\n]*|"""[\s\S]*?"""|'''[\s\S]*?'''|[fFbBrRuU]?"(?:\\.|[^"\\])*"|[fFbBrRuU]?'(?:\\.|[^'\\])*'|@[A-Za-z_][\w.]*|\b0x[0-9a-fA-F_]+\b|\b\d[\d_]*(?:\.[\d_]+)?\b|\b[A-Za-z_]\w*\b|->|:=|==|!=|<=|>=|\*\*|\/\/|[{}()[\].,:;=+\-*/%<>!&|^~]/g
        : isRust
          ? /\/\/[^\n]*|\/\*[\s\S]*?\*\/|#!?\[[^\]]*\]|r#*"[\s\S]*?"#*|\b[b]?"(?:\\.|[^"\\])*"|'(?:static|[a-z_]\w*)\b|'(?:\\.|[^'\\])'|\b0x[0-9a-fA-F_]+\b|\b\d[\d_]*(?:\.[\d_]+)?(?:u8|u16|u32|u64|u128|usize|i8|i16|i32|i64|i128|isize|f32|f64)?\b|\b[A-Za-z_]\w*!|\b[A-Za-z_]\w*\b|=>|->|::|&&|\|\||==|!=|<=|>=|\.\.=?|[{}()[\].,:;=+\-*/%<>!&|^~?]/g
          : /\/\/[^\n]*|\/\*[\s\S]*?\*\/|^\s*#[a-zA-Z_]\w*|`(?:\\.|[^`\\])*`|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|@[A-Za-z_]\w*|\b0x[0-9a-fA-F_]+\b|\b\d[\d_]*(?:\.[\d_]+)?n?\b|\b[A-Za-z_]\w*\b|===|!==|=>|->|::|:=|&&|\|\||\?\?|\?\.|==|!=|<=|>=|<<|>>|\.\.\.|[{}()[\].,:;=+\-*/%<>!&|^~?]/gm;

  let lastIdx = 0;
  let m: RegExpExecArray | null;
  while ((m = pattern.exec(code)) !== null) {
    if (m.index > lastIdx) pushToken(tokens, 'plain', code.slice(lastIdx, m.index));
    const full = m[0];
    const nextChar = code[pattern.lastIndex] || '';

    if (
      full.startsWith('//') ||
      full.startsWith('/*') ||
      ((isPy || isShell) && full.startsWith('#')) ||
      (isSql && full.startsWith('--'))
    ) {
      pushToken(tokens, 'comment', full);
    } else if (isRust && (full.startsWith('#[') || full.startsWith('#!['))) {
      pushToken(tokens, 'attr', full);
    } else if (isCLike && /^\s*#/.test(full)) {
      pushToken(tokens, 'keyword', full);
    } else if (isRust && /^'(?:static|[a-z_]\w*)$/.test(full)) {
      pushToken(tokens, 'attr', full);
    } else if (
      full.startsWith('"') ||
      full.startsWith("'") ||
      full.startsWith('`') ||
      (isPy && /^[fFbBrRuU]["']/.test(full)) ||
      (isRust && /^(?:r#*"|b")/.test(full))
    ) {
      pushToken(tokens, 'string', full);
    } else if (full.startsWith('@') || full.startsWith('$') || (isShell && full.startsWith('-'))) {
      pushToken(tokens, 'attr', full);
    } else if (isRust && full.endsWith('!') && /^[A-Za-z_]/.test(full)) {
      pushToken(tokens, 'fn', full);
    } else if (/^\d/.test(full)) {
      pushToken(tokens, 'number', full);
    } else if (/^[A-Za-z_]/.test(full)) {
      const lookup = isSql ? full.toUpperCase() : full;
      if (keywords.has(lookup)) {
        pushToken(tokens, 'keyword', full);
      } else if (builtInTypes.has(full)) {
        pushToken(tokens, 'type', full);
      } else if (nextChar === '(' && !isSql) {
        pushToken(tokens, 'fn', full);
      } else if (!isSql && !isShell && (lang !== null ? /^[A-Z][A-Za-z0-9_]*$/.test(full) : isPascalCaseType(full))) {
        pushToken(tokens, 'type', full);
      } else {
        pushToken(tokens, 'plain', full);
      }
    } else if (/^(?:===|!==|=>|->|::|:=|&&|\|\||\?\?|\?\.|==|!=|<=|>=|<>|<<|>>|\*\*|\/\/|\.\.\.|\.\.=?|[=+\-*/%<>!&|^~?])$/.test(full)) {
      pushToken(tokens, 'operator', full);
    } else {
      pushToken(tokens, 'punct', full);
    }
    lastIdx = pattern.lastIndex;
  }
  if (lastIdx < code.length) pushToken(tokens, 'plain', code.slice(lastIdx));
  return tokens;
}

export function highlightCodeTokens(code: string, lang: string | null): SyntaxToken[] {
  if (!code) return [];
  if (code.length > MAX_HIGHLIGHT_CHARS) {
    return [{ type: 'plain', text: code }];
  }
  const resolved = lang ?? detectCodeLanguage(code);
  switch (resolved) {
    case 'JSON':
      return tokenizeJson(code);
    case 'HTML':
      return tokenizeHtml(code);
    case 'CSS':
      return tokenizeCss(code);
    case 'YAML':
    case 'TOML':
      return tokenizeYamlToml(code);
    default:
      return tokenizeGeneric(code, resolved);
  }
}
