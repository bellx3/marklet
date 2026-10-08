//! 코드 색 — highlight.js(github 테마)와 비슷하게 칠하는 가벼운 토크나이저.
//!
//! 렌더러(src/markdown/highlight.ts)는 highlight.js 로 열두 언어(js · ts · python · java · kotlin · bash · json · yaml · xml/html · sql · css · markdown)를 칠한다.
//! 여기는 같은 언어를 **근사**한다 — 주석 · 문자열 · 숫자 · 예약어 · 내장 이름 · 정의 이름 정도다. 문법을 다 아는 것이 아니라서
//! 드문 꼴(정규식 리터럴 · 중첩 보간 · 여러 줄 앵커)에서는 색이 다를 수 있다. 모르는 언어는 칠하지 않는다(렌더러도 그렇다).
//! 결과는 UTF-16 위치(DirectWrite 의 글 범위)다.

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Tok {
    /// 예약어 · 형(`type`) · `this` / `self`
    Keyword,
    /// 함수 · 클래스 이름(정의 자리)
    Title,
    /// 숫자 · 리터럴 · 속성 이름 · 변수 · 메타
    Attr,
    /// 문자열 · 정규식
    Str,
    /// 내장 이름
    Builtin,
    Comment,
    /// 태그 · 선택자 이름 · 인용
    Name,
    /// 마크다운 제목
    Section,
    /// 목록 기호
    Bullet,
}

#[derive(Clone, Copy, PartialEq, Debug)]
pub struct Span {
    pub start: u32,
    pub end: u32,
    pub tok: Tok,
}

#[derive(Clone, Copy, PartialEq)]
enum Lang {
    Js,
    Ts,
    Python,
    Java,
    Kotlin,
    Bash,
    Json,
    Yaml,
    Xml,
    Sql,
    Css,
    Markdown,
}

fn lang_of(name: &str) -> Option<Lang> {
    Some(match name {
        "javascript" | "js" => Lang::Js,
        "typescript" | "ts" => Lang::Ts,
        "python" | "py" => Lang::Python,
        "java" => Lang::Java,
        "kotlin" => Lang::Kotlin,
        "bash" | "sh" | "shell" | "zsh" | "console" => Lang::Bash,
        "json" => Lang::Json,
        "yaml" | "yml" => Lang::Yaml,
        "xml" | "html" => Lang::Xml,
        "sql" => Lang::Sql,
        "css" => Lang::Css,
        "markdown" | "md" => Lang::Markdown,
        _ => return None,
    })
}

/// 렌더러가 칠하는 언어인가(mermaid 는 일부러 뺀다 — 다이어그램은 따로 그린다).
#[cfg(test)]
pub fn supported(lang: &str) -> bool {
    lang_of(lang).is_some()
}

/// 코드 한 덩어리의 색 구간. 서로 겹치지 않고 앞에서부터 순서대로다.
pub fn highlight(lang: &str, code: &str) -> Vec<Span> {
    let Some(l) = lang_of(lang) else {
        return Vec::new();
    };
    // 너무 큰 덩어리는 칠하지 않는다(렌더러도 느려진다).
    if code.len() > 400_000 {
        return Vec::new();
    }
    let s: Vec<char> = code.chars().collect();
    let mut raw: Vec<(usize, usize, Tok)> = Vec::new();
    match l {
        Lang::Js | Lang::Ts | Lang::Java | Lang::Kotlin | Lang::Python | Lang::Sql => {
            generic(l, &s, &mut raw)
        }
        Lang::Bash => bash(&s, &mut raw),
        Lang::Json => json(&s, &mut raw),
        Lang::Yaml => yaml(&s, &mut raw),
        Lang::Xml => xml(&s, &mut raw),
        Lang::Css => css(&s, &mut raw),
        Lang::Markdown => markdown(&s, &mut raw),
    }
    // 글자 위치 → UTF-16 위치
    let mut u16_at = Vec::with_capacity(s.len() + 1);
    let mut acc = 0u32;
    for c in &s {
        u16_at.push(acc);
        acc += c.len_utf16() as u32;
    }
    u16_at.push(acc);
    raw.into_iter()
        .filter(|(a, b, _)| b > a)
        .map(|(a, b, tok)| Span {
            start: u16_at[a],
            end: u16_at[b.min(s.len())],
            tok,
        })
        .collect()
}

// ── 공용 도우미 ───────────────────────────────────────────────────────────

fn starts(s: &[char], i: usize, pat: &str) -> bool {
    for (k, c) in (i..).zip(pat.chars()) {
        if s.get(k) != Some(&c) {
            return false;
        }
    }
    true
}

fn is_word_start(c: char) -> bool {
    c.is_alphabetic() || c == '_' || c == '$'
}
fn is_word(c: char) -> bool {
    c.is_alphanumeric() || c == '_' || c == '$'
}

fn line_end(s: &[char], i: usize) -> usize {
    let mut k = i;
    while k < s.len() && s[k] != '\n' {
        k += 1;
    }
    k
}

/// 따옴표 문자열의 끝(닫는 따옴표 다음). 백슬래시는 다음 글자를 건너뛴다. multiline 이 아니면 줄 끝에서 멈춘다.
fn string_end(s: &[char], start: usize, quote: char, multiline: bool) -> usize {
    let mut k = start + 1;
    while k < s.len() {
        match s[k] {
            '\\' => k += 2,
            c if c == quote => return k + 1,
            '\n' if !multiline => return k,
            _ => k += 1,
        }
    }
    s.len()
}

/// 숫자(정수 · 실수 · 16진 · 지수 · 밑줄 · 접미사)의 끝. 숫자로 시작하지 않으면 start.
fn number_end(s: &[char], start: usize) -> usize {
    let mut k = start;
    if s.get(k) == Some(&'0') && matches!(s.get(k + 1), Some('x' | 'X' | 'b' | 'B' | 'o' | 'O')) {
        k += 2;
        while k < s.len() && (s[k].is_ascii_hexdigit() || s[k] == '_') {
            k += 1;
        }
        return k;
    }
    let digits = |k: &mut usize| {
        while *k < s.len() && (s[*k].is_ascii_digit() || s[*k] == '_') {
            *k += 1;
        }
    };
    digits(&mut k);
    if s.get(k) == Some(&'.') && s.get(k + 1).map(|c| c.is_ascii_digit()).unwrap_or(false) {
        k += 1;
        digits(&mut k);
    }
    if matches!(s.get(k), Some('e' | 'E')) {
        let mut e = k + 1;
        if matches!(s.get(e), Some('+' | '-')) {
            e += 1;
        }
        if s.get(e).map(|c| c.is_ascii_digit()).unwrap_or(false) {
            k = e;
            digits(&mut k);
        }
    }
    // 접미사 한 글자(L · f · n …). 단어 뒤에 더 이어지면 숫자가 아니라 식별자 일부다.
    if k < s.len()
        && s[k].is_ascii_alphabetic()
        && k > start
        && !s.get(k + 1).map(|c| is_word(*c)).unwrap_or(false)
    {
        k += 1;
    }
    k
}

fn word_at(s: &[char], i: usize) -> usize {
    let mut k = i;
    while k < s.len() && is_word(s[k]) {
        k += 1;
    }
    k
}

// ── C 계열 · 파이썬 · SQL ────────────────────────────────────────────────────

struct Cfg {
    line_comments: &'static [&'static str],
    block_comment: Option<(&'static str, &'static str)>,
    quotes: &'static [char],
    backtick_multiline: bool,
    triple: bool,
    case_insensitive: bool,
    keywords: &'static [&'static str],
    literals: &'static [&'static str],
    builtins: &'static [&'static str],
    /// 이 다음에 오는 이름이 정의 이름이다
    defs: &'static [&'static str],
    decorators: bool,
}

const JS_KW: &[&str] = &[
    "as",
    "async",
    "await",
    "break",
    "case",
    "catch",
    "class",
    "const",
    "continue",
    "debugger",
    "default",
    "delete",
    "do",
    "else",
    "enum",
    "export",
    "extends",
    "finally",
    "for",
    "from",
    "function",
    "get",
    "if",
    "implements",
    "import",
    "in",
    "instanceof",
    "interface",
    "let",
    "new",
    "of",
    "package",
    "private",
    "protected",
    "public",
    "return",
    "set",
    "static",
    "super",
    "switch",
    "this",
    "throw",
    "try",
    "typeof",
    "var",
    "void",
    "while",
    "with",
    "yield",
];
const TS_KW: &[&str] = &[
    "as",
    "async",
    "await",
    "break",
    "case",
    "catch",
    "class",
    "const",
    "continue",
    "debugger",
    "default",
    "delete",
    "do",
    "else",
    "enum",
    "export",
    "extends",
    "finally",
    "for",
    "from",
    "function",
    "get",
    "if",
    "implements",
    "import",
    "in",
    "instanceof",
    "interface",
    "let",
    "new",
    "of",
    "package",
    "private",
    "protected",
    "public",
    "return",
    "set",
    "static",
    "super",
    "switch",
    "this",
    "throw",
    "try",
    "typeof",
    "var",
    "void",
    "while",
    "with",
    "yield",
    "type",
    "namespace",
    "declare",
    "abstract",
    "readonly",
    "keyof",
    "satisfies",
    "infer",
    "module",
    "override",
    "is",
];
const JS_LIT: &[&str] = &["true", "false", "null", "undefined", "NaN", "Infinity"];
const JS_BUILTIN: &[&str] = &[
    "console",
    "Math",
    "JSON",
    "Object",
    "Array",
    "Promise",
    "window",
    "document",
    "Map",
    "Set",
    "WeakMap",
    "WeakSet",
    "Date",
    "Error",
    "String",
    "Number",
    "Boolean",
    "RegExp",
    "Symbol",
    "parseInt",
    "parseFloat",
    "setTimeout",
    "setInterval",
    "clearTimeout",
    "clearInterval",
    "require",
    "module",
    "exports",
    "process",
    "Buffer",
    "fetch",
    "globalThis",
    "BigInt",
    "string",
    "number",
    "boolean",
    "any",
    "never",
    "unknown",
    "object",
];
const PY_KW: &[&str] = &[
    "and", "as", "assert", "async", "await", "break", "class", "continue", "def", "del", "elif",
    "else", "except", "finally", "for", "from", "global", "if", "import", "in", "is", "lambda",
    "nonlocal", "not", "or", "pass", "raise", "return", "try", "while", "with", "yield", "match",
    "case", "self", "cls",
];
const PY_LIT: &[&str] = &["True", "False", "None"];
const PY_BUILTIN: &[&str] = &[
    "print",
    "len",
    "range",
    "int",
    "str",
    "float",
    "list",
    "dict",
    "set",
    "tuple",
    "bool",
    "open",
    "type",
    "isinstance",
    "enumerate",
    "zip",
    "map",
    "filter",
    "sorted",
    "sum",
    "min",
    "max",
    "abs",
    "any",
    "all",
    "input",
    "id",
    "iter",
    "next",
    "object",
    "super",
    "repr",
    "reversed",
    "round",
    "hasattr",
    "getattr",
    "setattr",
    "format",
    "bytes",
    "Exception",
    "ValueError",
    "TypeError",
    "KeyError",
];
const JAVA_KW: &[&str] = &[
    "abstract",
    "assert",
    "boolean",
    "break",
    "byte",
    "case",
    "catch",
    "char",
    "class",
    "const",
    "continue",
    "default",
    "do",
    "double",
    "else",
    "enum",
    "exports",
    "extends",
    "final",
    "finally",
    "float",
    "for",
    "goto",
    "if",
    "implements",
    "import",
    "instanceof",
    "int",
    "interface",
    "long",
    "module",
    "native",
    "new",
    "package",
    "private",
    "protected",
    "public",
    "requires",
    "return",
    "short",
    "static",
    "strictfp",
    "super",
    "switch",
    "synchronized",
    "this",
    "throw",
    "throws",
    "transient",
    "try",
    "var",
    "void",
    "volatile",
    "while",
    "record",
    "sealed",
    "permits",
    "yield",
];
const KT_KW: &[&str] = &[
    "as",
    "break",
    "class",
    "continue",
    "do",
    "else",
    "for",
    "fun",
    "if",
    "in",
    "interface",
    "is",
    "object",
    "package",
    "return",
    "super",
    "this",
    "throw",
    "try",
    "typealias",
    "typeof",
    "val",
    "var",
    "when",
    "while",
    "by",
    "catch",
    "constructor",
    "delegate",
    "dynamic",
    "field",
    "file",
    "finally",
    "get",
    "import",
    "init",
    "param",
    "property",
    "receiver",
    "set",
    "setparam",
    "value",
    "where",
    "abstract",
    "actual",
    "annotation",
    "companion",
    "const",
    "crossinline",
    "data",
    "enum",
    "expect",
    "external",
    "final",
    "infix",
    "inline",
    "inner",
    "internal",
    "lateinit",
    "noinline",
    "open",
    "operator",
    "out",
    "override",
    "private",
    "protected",
    "public",
    "reified",
    "sealed",
    "suspend",
    "tailrec",
    "vararg",
];
const KT_BUILTIN: &[&str] = &[
    "println",
    "print",
    "listOf",
    "mutableListOf",
    "mapOf",
    "mutableMapOf",
    "setOf",
    "arrayOf",
    "String",
    "Int",
    "Long",
    "Double",
    "Float",
    "Boolean",
    "Unit",
    "Any",
    "Nothing",
    "List",
    "Map",
    "Set",
];
const SQL_KW: &[&str] = &[
    "select",
    "from",
    "where",
    "group",
    "by",
    "order",
    "having",
    "limit",
    "offset",
    "join",
    "inner",
    "left",
    "right",
    "outer",
    "full",
    "cross",
    "on",
    "as",
    "and",
    "or",
    "not",
    "in",
    "is",
    "like",
    "between",
    "exists",
    "union",
    "all",
    "distinct",
    "insert",
    "into",
    "values",
    "update",
    "set",
    "delete",
    "create",
    "table",
    "alter",
    "drop",
    "index",
    "view",
    "primary",
    "key",
    "foreign",
    "references",
    "constraint",
    "default",
    "unique",
    "check",
    "add",
    "column",
    "database",
    "schema",
    "case",
    "when",
    "then",
    "else",
    "end",
    "with",
    "over",
    "partition",
    "asc",
    "desc",
    "if",
    "begin",
    "commit",
    "rollback",
    "transaction",
    "grant",
    "revoke",
    "truncate",
    "replace",
    "returning",
    "using",
    "natural",
    "top",
    "fetch",
    "next",
    "rows",
    "only",
    "exec",
    "int",
    "integer",
    "varchar",
    "char",
    "text",
    "date",
    "datetime",
    "timestamp",
    "boolean",
    "bigint",
    "smallint",
    "decimal",
    "numeric",
    "float",
    "double",
];
const SQL_LIT: &[&str] = &["true", "false", "null"];
const SQL_BUILTIN: &[&str] = &[
    "count",
    "sum",
    "avg",
    "min",
    "max",
    "coalesce",
    "cast",
    "convert",
    "now",
    "upper",
    "lower",
    "length",
    "substring",
    "trim",
    "round",
    "floor",
    "ceil",
    "abs",
    "concat",
    "year",
    "month",
    "day",
    "row_number",
    "rank",
    "dense_rank",
    "lag",
    "lead",
    "nullif",
    "ifnull",
    "isnull",
];

fn cfg_of(l: Lang) -> Cfg {
    match l {
        Lang::Js | Lang::Ts => Cfg {
            line_comments: &["//"],
            block_comment: Some(("/*", "*/")),
            quotes: &['\'', '"', '`'],
            backtick_multiline: true,
            triple: false,
            case_insensitive: false,
            keywords: if l == Lang::Ts { TS_KW } else { JS_KW },
            literals: JS_LIT,
            builtins: JS_BUILTIN,
            defs: &[
                "function",
                "class",
                "interface",
                "enum",
                "type",
                "namespace",
            ],
            decorators: true,
        },
        Lang::Python => Cfg {
            line_comments: &["#"],
            block_comment: None,
            quotes: &['\'', '"'],
            backtick_multiline: false,
            triple: true,
            case_insensitive: false,
            keywords: PY_KW,
            literals: PY_LIT,
            builtins: PY_BUILTIN,
            defs: &["def", "class"],
            decorators: true,
        },
        Lang::Java => Cfg {
            line_comments: &["//"],
            block_comment: Some(("/*", "*/")),
            quotes: &['\'', '"'],
            backtick_multiline: false,
            triple: false,
            case_insensitive: false,
            keywords: JAVA_KW,
            literals: JS_LIT,
            builtins: &[],
            defs: &["class", "interface", "enum", "record"],
            decorators: true,
        },
        Lang::Kotlin => Cfg {
            line_comments: &["//"],
            block_comment: Some(("/*", "*/")),
            quotes: &['\'', '"'],
            backtick_multiline: false,
            triple: true,
            case_insensitive: false,
            keywords: KT_KW,
            literals: JS_LIT,
            builtins: KT_BUILTIN,
            defs: &["fun", "class", "interface", "object", "typealias"],
            decorators: true,
        },
        _ => Cfg {
            line_comments: &["--"],
            block_comment: Some(("/*", "*/")),
            quotes: &['\'', '"', '`'],
            backtick_multiline: false,
            triple: false,
            case_insensitive: true,
            keywords: SQL_KW,
            literals: SQL_LIT,
            builtins: SQL_BUILTIN,
            defs: &[],
            decorators: false,
        },
    }
}

fn has(list: &[&str], w: &str, ci: bool) -> bool {
    if ci {
        list.iter().any(|k| k.eq_ignore_ascii_case(w))
    } else {
        list.contains(&w)
    }
}

fn generic(l: Lang, s: &[char], out: &mut Vec<(usize, usize, Tok)>) {
    let cfg = cfg_of(l);
    let n = s.len();
    let mut i = 0;
    // 직전 의미 있는 낱말이 정의 예약어였는가
    let mut after_def = false;
    while i < n {
        let c = s[i];
        if c.is_whitespace() {
            i += 1;
            continue;
        }
        // 주석
        if let Some(lc) = cfg.line_comments.iter().find(|p| starts(s, i, p)) {
            // 파이썬 · 셸의 `#` 은 주석이다(문자열 안은 아래에서 먼저 먹는다)
            let _ = lc;
            let e = line_end(s, i);
            out.push((i, e, Tok::Comment));
            i = e;
            continue;
        }
        if let Some((open, close)) = cfg.block_comment {
            if starts(s, i, open) {
                let mut k = i + open.len();
                while k < n && !starts(s, k, close) {
                    k += 1;
                }
                let e = (k + close.len()).min(n);
                out.push((i, e, Tok::Comment));
                i = e;
                continue;
            }
        }
        // 파이썬의 문자열 접두사(r · f · b · rb · u …)
        if l == Lang::Python && (c.is_ascii_alphabetic()) {
            let w = word_at(s, i);
            if w - i <= 2
                && s[i..w]
                    .iter()
                    .all(|c| matches!(c, 'r' | 'R' | 'f' | 'F' | 'b' | 'B' | 'u' | 'U'))
                && matches!(s.get(w), Some('\'' | '"'))
            {
                let q = s[w];
                let e = if cfg.triple && starts(s, w, &q.to_string().repeat(3)) {
                    triple_end(s, w, q)
                } else {
                    string_end(s, w, q, false)
                };
                out.push((i, e, Tok::Str));
                i = e;
                continue;
            }
        }
        // 문자열
        if cfg.quotes.contains(&c) {
            let e = if cfg.triple && starts(s, i, &c.to_string().repeat(3)) {
                triple_end(s, i, c)
            } else {
                string_end(s, i, c, c == '`' && cfg.backtick_multiline)
            };
            // SQL 의 큰따옴표 · 백틱은 이름이다 — 문자열 색은 작은따옴표만
            let tok = if l == Lang::Sql && c != '\'' {
                None
            } else {
                Some(Tok::Str)
            };
            if let Some(t) = tok {
                out.push((i, e, t));
            }
            i = e;
            after_def = false;
            continue;
        }
        // 데코레이터 · 어노테이션
        if cfg.decorators && c == '@' && s.get(i + 1).map(|c| is_word_start(*c)).unwrap_or(false) {
            let e = word_at(s, i + 1);
            out.push((i, e, Tok::Attr));
            i = e;
            continue;
        }
        // 숫자
        if c.is_ascii_digit()
            || (c == '.' && s.get(i + 1).map(|c| c.is_ascii_digit()).unwrap_or(false))
        {
            let start = if c == '.' { i + 1 } else { i };
            let e = number_end(s, start).max(start + 1);
            out.push((i, e, Tok::Attr));
            i = e;
            after_def = false;
            continue;
        }
        // 낱말
        if is_word_start(c) {
            let e = word_at(s, i);
            let w: String = s[i..e].iter().collect();
            let ci = cfg.case_insensitive;
            if after_def {
                out.push((i, e, Tok::Title));
                after_def = false;
            } else if has(cfg.keywords, &w, ci) {
                out.push((i, e, Tok::Keyword));
                after_def = cfg.defs.contains(&w.as_str());
            } else if has(cfg.literals, &w, ci) {
                out.push((i, e, Tok::Attr));
            } else if has(cfg.builtins, &w, ci) {
                out.push((i, e, Tok::Builtin));
            }
            i = e;
            continue;
        }
        after_def = false;
        i += 1;
    }
}

fn triple_end(s: &[char], start: usize, q: char) -> usize {
    let close = q.to_string().repeat(3);
    let mut k = start + 3;
    while k < s.len() {
        if s[k] == '\\' {
            k += 2;
            continue;
        }
        if starts(s, k, &close) {
            return k + 3;
        }
        k += 1;
    }
    s.len()
}

// ── 셸 ────────────────────────────────────────────────────────────────────

const BASH_KW: &[&str] = &[
    "if", "then", "else", "elif", "fi", "case", "esac", "for", "while", "until", "do", "done",
    "in", "function", "select", "time", "coproc",
];
const BASH_BUILTIN: &[&str] = &[
    "break",
    "cd",
    "continue",
    "eval",
    "exec",
    "exit",
    "export",
    "getopts",
    "hash",
    "pwd",
    "readonly",
    "return",
    "shift",
    "test",
    "trap",
    "umask",
    "unset",
    "alias",
    "bind",
    "builtin",
    "command",
    "declare",
    "echo",
    "enable",
    "help",
    "let",
    "local",
    "mapfile",
    "printf",
    "read",
    "readarray",
    "source",
    "type",
    "typeset",
    "ulimit",
    "unalias",
    "set",
    "shopt",
    "bg",
    "dirs",
    "disown",
    "fg",
    "history",
    "jobs",
    "kill",
    "popd",
    "pushd",
    "suspend",
    "wait",
    "which",
    "ls",
    "cat",
    "grep",
    "sed",
    "awk",
    "mkdir",
    "rm",
    "cp",
    "mv",
    "chmod",
    "chown",
    "curl",
    "wget",
    "git",
    "npm",
    "node",
    "docker",
    "sudo",
    "apt",
    "apt-get",
    "brew",
    "pip",
    "python",
    "tar",
    "ssh",
    "scp",
    "find",
    "sort",
    "head",
    "tail",
    "touch",
    "xargs",
    "make",
];

fn bash(s: &[char], out: &mut Vec<(usize, usize, Tok)>) {
    let n = s.len();
    let mut i = 0;
    let mut line_start = true;
    while i < n {
        let c = s[i];
        if c == '\n' {
            line_start = true;
            i += 1;
            continue;
        }
        if c.is_whitespace() {
            i += 1;
            continue;
        }
        // `$ ` 로 시작하는 줄의 프롬프트(console)
        if line_start && c == '$' && s.get(i + 1) == Some(&' ') {
            out.push((i, i + 1, Tok::Attr));
            i += 1;
            line_start = false;
            continue;
        }
        line_start = false;
        // 주석: 낱말 시작의 `#`
        if c == '#' && (i == 0 || s[i - 1].is_whitespace() || s[i - 1] == ';') {
            let e = line_end(s, i);
            out.push((i, e, Tok::Comment));
            i = e;
            continue;
        }
        if c == '\'' {
            let e = string_end(s, i, '\'', true);
            out.push((i, e, Tok::Str));
            i = e;
            continue;
        }
        if c == '"' {
            // 큰따옴표 안의 $변수는 따로 칠하지 않고 문자열 색으로 둔다
            let e = string_end(s, i, '"', true);
            out.push((i, e, Tok::Str));
            i = e;
            continue;
        }
        if c == '$' {
            let mut e = i + 1;
            if s.get(e) == Some(&'{') {
                while e < n && s[e] != '}' && s[e] != '\n' {
                    e += 1;
                }
                e = (e + 1).min(n);
            } else if s
                .get(e)
                .map(|c| {
                    is_word_start(*c)
                        || c.is_ascii_digit()
                        || matches!(c, '?' | '@' | '*' | '#' | '!')
                })
                .unwrap_or(false)
            {
                e += 1;
                while e < n && is_word(s[e]) {
                    e += 1;
                }
            } else {
                i += 1;
                continue;
            }
            out.push((i, e, Tok::Attr));
            i = e;
            continue;
        }
        if is_word_start(c)
            || (c == '-' && s.get(i + 1).map(|c| c.is_alphabetic()).unwrap_or(false) && false)
        {
            let mut e = i;
            while e < n && (is_word(s[e]) || s[e] == '-' || s[e] == '.') {
                e += 1;
            }
            // `name=value` 의 name 은 변수
            let w: String = s[i..e].iter().collect();
            if BASH_KW.contains(&w.as_str()) {
                out.push((i, e, Tok::Keyword));
            } else if BASH_BUILTIN.contains(&w.as_str()) {
                out.push((i, e, Tok::Builtin));
            } else if s.get(e) == Some(&'=')
                && w.chars().all(|c| c.is_ascii_alphanumeric() || c == '_')
            {
                out.push((i, e, Tok::Attr));
            }
            i = e.max(i + 1);
            continue;
        }
        if c.is_ascii_digit() {
            let e = number_end(s, i).max(i + 1);
            out.push((i, e, Tok::Attr));
            i = e;
            continue;
        }
        i += 1;
    }
}

// ── JSON ──────────────────────────────────────────────────────────────────

fn json(s: &[char], out: &mut Vec<(usize, usize, Tok)>) {
    let n = s.len();
    let mut i = 0;
    while i < n {
        let c = s[i];
        if c == '"' {
            let e = string_end(s, i, '"', false);
            let mut k = e;
            while k < n && (s[k] == ' ' || s[k] == '\t') {
                k += 1;
            }
            let key = s.get(k) == Some(&':');
            out.push((i, e, if key { Tok::Attr } else { Tok::Str }));
            i = e;
            continue;
        }
        if c.is_ascii_digit()
            || (c == '-' && s.get(i + 1).map(|c| c.is_ascii_digit()).unwrap_or(false))
        {
            let start = if c == '-' { i + 1 } else { i };
            let e = number_end(s, start).max(start + 1);
            out.push((i, e, Tok::Attr));
            i = e;
            continue;
        }
        if c.is_alphabetic() {
            let e = word_at(s, i);
            let w: String = s[i..e].iter().collect();
            if matches!(w.as_str(), "true" | "false" | "null") {
                out.push((i, e, Tok::Attr));
            }
            i = e;
            continue;
        }
        i += 1;
    }
}

// ── YAML ──────────────────────────────────────────────────────────────────

fn yaml(s: &[char], out: &mut Vec<(usize, usize, Tok)>) {
    let n = s.len();
    let mut ls = 0;
    while ls <= n {
        let le = line_end(s, ls);
        yaml_line(s, ls, le, out);
        ls = le + 1;
    }
}

fn yaml_value(s: &[char], mut i: usize, end: usize, out: &mut Vec<(usize, usize, Tok)>) {
    while i < end {
        let c = s[i];
        if c == '#' && (i == 0 || s[i - 1].is_whitespace()) {
            out.push((i, end, Tok::Comment));
            return;
        }
        if c == '"' || c == '\'' {
            let e = string_end(s, i, c, false).min(end);
            out.push((i, e, Tok::Str));
            i = e;
            continue;
        }
        if c.is_ascii_digit()
            || (c == '-' && s.get(i + 1).map(|c| c.is_ascii_digit()).unwrap_or(false))
        {
            // 낱말 안의 숫자(abc1)는 건너뛴다
            if i > 0 && is_word(s[i - 1]) {
                i += 1;
                continue;
            }
            let start = if c == '-' { i + 1 } else { i };
            let e = number_end(s, start).max(start + 1).min(end);
            // 숫자 뒤에 글자가 이어지면 숫자가 아니다(1.2.3 · 2024-01-01 은 그대로 둔다)
            if e < end && (is_word(s[e]) || s[e] == '.' || s[e] == '-') {
                while i < end && !s[i].is_whitespace() {
                    i += 1;
                }
                continue;
            }
            out.push((i, e, Tok::Attr));
            i = e;
            continue;
        }
        if c.is_alphabetic() {
            let e = word_at(s, i).min(end);
            let w: String = s[i..e].iter().collect();
            if matches!(
                w.as_str(),
                "true" | "false" | "null" | "yes" | "no" | "True" | "False" | "Null" | "~"
            ) {
                out.push((i, e, Tok::Attr));
            }
            i = e;
            continue;
        }
        i += 1;
    }
}

fn yaml_line(s: &[char], ls: usize, le: usize, out: &mut Vec<(usize, usize, Tok)>) {
    let mut i = ls;
    while i < le && s[i] == ' ' {
        i += 1;
    }
    if i >= le {
        return;
    }
    if s[i] == '#' {
        out.push((i, le, Tok::Comment));
        return;
    }
    if starts(s, i, "---") || starts(s, i, "...") {
        out.push((i, i + 3, Tok::Attr));
        return;
    }
    // 목록 기호 `- ` (여러 겹 가능)
    while i < le && s[i] == '-' && s.get(i + 1) == Some(&' ') {
        out.push((i, i + 1, Tok::Bullet));
        i += 1;
        while i < le && s[i] == ' ' {
            i += 1;
        }
    }
    // 키: `key:` · `"key":` 다음이 공백이거나 줄 끝
    let key_start = i;
    let mut k = i;
    if k < le && (s[k] == '"' || s[k] == '\'') {
        k = string_end(s, k, s[k], false).min(le);
    } else {
        while k < le && s[k] != ':' && s[k] != '#' {
            k += 1;
        }
        // 키 뒤의 공백은 키가 아니다
        while k > key_start && s[k - 1] == ' ' {
            k -= 1;
        }
    }
    let mut colon = k;
    while colon < le && s[colon] == ' ' {
        colon += 1;
    }
    if colon < le && s[colon] == ':' && (colon + 1 >= le || s[colon + 1] == ' ') && k > key_start {
        out.push((key_start, k, Tok::Attr));
        yaml_value(s, colon + 1, le, out);
    } else {
        yaml_value(s, key_start, le, out);
    }
}

// ── XML · HTML ────────────────────────────────────────────────────────────

fn xml(s: &[char], out: &mut Vec<(usize, usize, Tok)>) {
    let n = s.len();
    let mut i = 0;
    while i < n {
        if s[i] != '<' {
            // 글 안의 `&amp;` 같은 문자 참조
            if s[i] == '&' {
                let mut k = i + 1;
                while k < n && k - i < 10 && (s[k].is_ascii_alphanumeric() || s[k] == '#') {
                    k += 1;
                }
                if s.get(k) == Some(&';') && k > i + 1 {
                    out.push((i, k + 1, Tok::Attr));
                    i = k + 1;
                    continue;
                }
            }
            i += 1;
            continue;
        }
        if starts(s, i, "<!--") {
            let mut k = i + 4;
            while k < n && !starts(s, k, "-->") {
                k += 1;
            }
            let e = (k + 3).min(n);
            out.push((i, e, Tok::Comment));
            i = e;
            continue;
        }
        if starts(s, i, "<!") || starts(s, i, "<?") {
            let mut k = i + 2;
            while k < n && s[k] != '>' {
                k += 1;
            }
            let e = (k + 1).min(n);
            out.push((i, e, Tok::Attr));
            i = e;
            continue;
        }
        // 태그
        let mut k = i + 1;
        if s.get(k) == Some(&'/') {
            k += 1;
        }
        if !s.get(k).map(|c| c.is_alphabetic()).unwrap_or(false) {
            i += 1;
            continue;
        }
        let name_start = k;
        while k < n && (is_word(s[k]) || matches!(s[k], '-' | ':' | '.')) {
            k += 1;
        }
        out.push((name_start, k, Tok::Name));
        // 속성들
        while k < n && s[k] != '>' {
            let c = s[k];
            if c == '"' || c == '\'' {
                let e = string_end(s, k, c, true);
                out.push((k, e, Tok::Str));
                k = e;
            } else if is_word_start(c) || c == ':' || c == '@' {
                let a = k;
                while k < n && (is_word(s[k]) || matches!(s[k], '-' | ':' | '.' | '@')) {
                    k += 1;
                }
                out.push((a, k, Tok::Attr));
            } else {
                k += 1;
            }
        }
        i = (k + 1).min(n);
    }
}

// ── CSS ───────────────────────────────────────────────────────────────────

fn css(s: &[char], out: &mut Vec<(usize, usize, Tok)>) {
    let n = s.len();
    let mut i = 0;
    let mut depth = 0i32;
    // 블록 안에서 `이름:` 다음이면 값이다
    let mut in_value = false;
    while i < n {
        let c = s[i];
        if starts(s, i, "/*") {
            let mut k = i + 2;
            while k < n && !starts(s, k, "*/") {
                k += 1;
            }
            let e = (k + 2).min(n);
            out.push((i, e, Tok::Comment));
            i = e;
            continue;
        }
        match c {
            '{' => {
                depth += 1;
                in_value = false;
                i += 1;
            }
            '}' => {
                depth = (depth - 1).max(0);
                in_value = false;
                i += 1;
            }
            ';' => {
                in_value = false;
                i += 1;
            }
            '"' | '\'' => {
                let e = string_end(s, i, c, false);
                out.push((i, e, Tok::Str));
                i = e;
            }
            '@' => {
                let e = word_at(s, i + 1).max(i + 1);
                let mut e2 = e;
                while e2 < n && (s[e2].is_alphanumeric() || s[e2] == '-') {
                    e2 += 1;
                }
                out.push((i, e2, Tok::Keyword));
                i = e2;
            }
            '!' if starts(s, i, "!important") => {
                out.push((i, i + 10, Tok::Keyword));
                i += 10;
            }
            '#' => {
                // 색상값(값 자리) · id 선택자
                let mut e = i + 1;
                while e < n && (s[e].is_ascii_alphanumeric() || s[e] == '-' || s[e] == '_') {
                    e += 1;
                }
                out.push((i, e, Tok::Attr));
                i = e;
            }
            '.' if !in_value || !s.get(i + 1).map(|c| c.is_ascii_digit()).unwrap_or(false) => {
                if depth == 0 || !in_value {
                    let mut e = i + 1;
                    while e < n && (s[e].is_alphanumeric() || s[e] == '-' || s[e] == '_') {
                        e += 1;
                    }
                    if e > i + 1 {
                        out.push((i, e, Tok::Attr));
                    }
                    i = e.max(i + 1);
                } else {
                    i += 1;
                }
            }
            ':' => {
                if depth == 0 {
                    // 가상 클래스 · 가상 요소
                    let mut e = i + 1;
                    if s.get(e) == Some(&':') {
                        e += 1;
                    }
                    let ws = e;
                    while e < n && (s[e].is_alphanumeric() || s[e] == '-') {
                        e += 1;
                    }
                    if e > ws {
                        out.push((i, e, Tok::Name));
                    }
                    i = e.max(i + 1);
                } else {
                    in_value = true;
                    i += 1;
                }
            }
            c if c.is_ascii_digit()
                || (c == '-' && s.get(i + 1).map(|c| c.is_ascii_digit()).unwrap_or(false)) =>
            {
                let start = if c == '-' { i + 1 } else { i };
                let mut e = number_end(s, start).max(start + 1);
                // 단위(px · em · % …)
                while e < n && (s[e].is_ascii_alphabetic() || s[e] == '%') {
                    e += 1;
                }
                out.push((i, e, Tok::Attr));
                i = e;
            }
            c if is_word_start(c) || c == '-' => {
                let mut e = i;
                while e < n && (s[e].is_alphanumeric() || s[e] == '-' || s[e] == '_') {
                    e += 1;
                }
                if e == i {
                    i += 1;
                    continue;
                }
                // 뒤에서 가장 가까운 비공백 글자
                let mut k = e;
                while k < n && (s[k] == ' ' || s[k] == '\t') {
                    k += 1;
                }
                if depth > 0 && !in_value && s.get(k) == Some(&':') {
                    out.push((i, e, Tok::Attr)); // 속성 이름
                } else if depth == 0 {
                    out.push((i, e, Tok::Name)); // 태그 선택자
                } else if s.get(e) == Some(&'(') {
                    out.push((i, e, Tok::Builtin)); // rgb( · calc(
                }
                i = e;
            }
            _ => i += 1,
        }
    }
}

// ── 마크다운 ──────────────────────────────────────────────────────────────

fn markdown(s: &[char], out: &mut Vec<(usize, usize, Tok)>) {
    let n = s.len();
    let mut ls = 0;
    while ls <= n {
        let le = line_end(s, ls);
        let mut i = ls;
        while i < le && s[i] == ' ' {
            i += 1;
        }
        if i < le {
            if s[i] == '#' {
                let mut h = i;
                while h < le && s[h] == '#' {
                    h += 1;
                }
                if h - i <= 6 && s.get(h) == Some(&' ') {
                    out.push((i, le, Tok::Section));
                }
            } else if s[i] == '>' {
                out.push((i, le, Tok::Name));
            } else if starts(s, i, "```") || starts(s, i, "~~~") {
                out.push((i, le, Tok::Comment));
            } else {
                // 목록 기호
                let mut b = i;
                if matches!(s[b], '-' | '*' | '+') && s.get(b + 1) == Some(&' ') {
                    out.push((b, b + 1, Tok::Bullet));
                    b += 1;
                } else {
                    let mut d = b;
                    while d < le && s[d].is_ascii_digit() {
                        d += 1;
                    }
                    if d > b && s.get(d) == Some(&'.') && s.get(d + 1) == Some(&' ') {
                        out.push((b, d + 1, Tok::Bullet));
                        b = d + 1;
                    }
                }
                // 줄 안의 `코드`
                let mut k = b;
                while k < le {
                    if s[k] == '`' {
                        let mut e = k + 1;
                        while e < le && s[e] != '`' {
                            e += 1;
                        }
                        if e < le {
                            out.push((k, e + 1, Tok::Comment));
                            k = e + 1;
                            continue;
                        }
                    }
                    k += 1;
                }
            }
        }
        ls = le + 1;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn toks(lang: &str, code: &str) -> Vec<(String, Tok)> {
        let u: Vec<u16> = code.encode_utf16().collect();
        highlight(lang, code)
            .into_iter()
            .map(|s| {
                (
                    String::from_utf16_lossy(&u[s.start as usize..s.end as usize]),
                    s.tok,
                )
            })
            .collect()
    }

    fn has(v: &[(String, Tok)], text: &str, tok: Tok) -> bool {
        v.iter().any(|(t, k)| t == text && *k == tok)
    }

    #[test]
    fn unknown_language_is_not_colored() {
        assert!(highlight("rust", "fn main() {}").is_empty());
        assert!(highlight("", "x").is_empty());
        assert!(!supported("mermaid"));
        assert!(supported("TS".to_lowercase().as_str()));
    }

    #[test]
    fn typescript_basics() {
        let v = toks(
            "ts",
            "const a: number = 42; // 주석\nfunction foo(s: string) { return `t` + 'x'; }\n/* b */",
        );
        assert!(has(&v, "const", Tok::Keyword));
        assert!(has(&v, "number", Tok::Builtin));
        assert!(has(&v, "42", Tok::Attr));
        assert!(has(&v, "// 주석", Tok::Comment));
        assert!(has(&v, "function", Tok::Keyword));
        assert!(has(&v, "foo", Tok::Title));
        assert!(has(&v, "`t`", Tok::Str));
        assert!(has(&v, "'x'", Tok::Str));
        assert!(has(&v, "/* b */", Tok::Comment));
    }

    #[test]
    fn utf16_offsets_survive_non_bmp_and_hangul() {
        // 😀 는 UTF-16 으로 두 칸이다
        let code = "// 😀 한글\nlet x = 1;";
        let u: Vec<u16> = code.encode_utf16().collect();
        let spans = highlight("js", code);
        let comment = spans.iter().find(|s| s.tok == Tok::Comment).unwrap();
        assert_eq!(
            String::from_utf16_lossy(&u[comment.start as usize..comment.end as usize]),
            "// 😀 한글"
        );
        let one = spans.iter().find(|s| s.tok == Tok::Attr).unwrap();
        assert_eq!(
            String::from_utf16_lossy(&u[one.start as usize..one.end as usize]),
            "1"
        );
    }

    #[test]
    fn python_strings_decorators_and_defs() {
        let v = toks(
            "py",
            "@app.route\ndef f(self):\n    s = f\"a{b}\" + '''doc\nstring'''\n    return None # x",
        );
        assert!(has(&v, "@app", Tok::Attr));
        assert!(has(&v, "def", Tok::Keyword));
        assert!(has(&v, "f", Tok::Title));
        assert!(has(&v, "self", Tok::Keyword));
        assert!(has(&v, "f\"a{b}\"", Tok::Str));
        assert!(has(&v, "'''doc\nstring'''", Tok::Str));
        assert!(has(&v, "None", Tok::Attr));
        assert!(has(&v, "# x", Tok::Comment));
    }

    #[test]
    fn json_keys_and_values() {
        let v = toks("json", "{\"a\": [1, -2.5e3, true, null, \"x\"]}");
        assert!(has(&v, "\"a\"", Tok::Attr));
        assert!(has(&v, "1", Tok::Attr));
        assert!(has(&v, "-2.5e3", Tok::Attr));
        assert!(has(&v, "true", Tok::Attr));
        assert!(has(&v, "\"x\"", Tok::Str));
    }

    #[test]
    fn yaml_keys_lists_and_comments() {
        let v = toks(
            "yaml",
            "# c\nname: \"x\" # tail\nlist:\n  - a: 1\n  - true\nurl: http://x.y:80/z\n",
        );
        assert!(has(&v, "# c", Tok::Comment));
        assert!(has(&v, "name", Tok::Attr));
        assert!(has(&v, "\"x\"", Tok::Str));
        assert!(has(&v, "# tail", Tok::Comment));
        assert!(has(&v, "-", Tok::Bullet));
        assert!(has(&v, "a", Tok::Attr));
        assert!(has(&v, "1", Tok::Attr));
        assert!(has(&v, "true", Tok::Attr));
        assert!(has(&v, "url", Tok::Attr));
    }

    #[test]
    fn xml_tags_attributes_and_comments() {
        let v = toks("html", "<!-- c --><div class=\"a\" id='b'>x &amp; y</div>");
        assert!(has(&v, "<!-- c -->", Tok::Comment));
        assert!(has(&v, "div", Tok::Name));
        assert!(has(&v, "class", Tok::Attr));
        assert!(has(&v, "\"a\"", Tok::Str));
        assert!(has(&v, "&amp;", Tok::Attr));
    }

    #[test]
    fn sql_keywords_are_case_insensitive() {
        let v = toks("sql", "SELECT count(*) FROM t WHERE a = 'x' -- c");
        assert!(has(&v, "SELECT", Tok::Keyword));
        assert!(has(&v, "count", Tok::Builtin));
        assert!(has(&v, "FROM", Tok::Keyword));
        assert!(has(&v, "'x'", Tok::Str));
        assert!(has(&v, "-- c", Tok::Comment));
    }

    #[test]
    fn css_selectors_properties_values() {
        let v = toks(
            "css",
            ".a:hover { color: #fff; margin: 0 10px !important; }\n/* c */",
        );
        assert!(has(&v, ".a", Tok::Attr));
        assert!(has(&v, ":hover", Tok::Name));
        assert!(has(&v, "color", Tok::Attr));
        assert!(has(&v, "#fff", Tok::Attr));
        assert!(has(&v, "10px", Tok::Attr));
        assert!(has(&v, "!important", Tok::Keyword));
        assert!(has(&v, "/* c */", Tok::Comment));
    }

    #[test]
    fn bash_and_markdown() {
        let v = toks("sh", "# c\nif [ -f $HOME/x ]; then echo \"hi\"; fi\nNAME=1");
        assert!(has(&v, "# c", Tok::Comment));
        assert!(has(&v, "if", Tok::Keyword));
        assert!(has(&v, "$HOME", Tok::Attr));
        assert!(has(&v, "echo", Tok::Builtin));
        assert!(has(&v, "\"hi\"", Tok::Str));
        assert!(has(&v, "NAME", Tok::Attr));
        let m = toks("md", "# 제목\n- 항목 `코드`\n> 인용");
        assert!(has(&m, "# 제목", Tok::Section));
        assert!(has(&m, "-", Tok::Bullet));
        assert!(has(&m, "`코드`", Tok::Comment));
        assert!(has(&m, "> 인용", Tok::Name));
    }

    #[test]
    fn spans_do_not_overlap_and_stay_in_range() {
        for (l, code) in [
            ("ts", "const s = 'unterminated\nlet y = \"also"),
            ("py", "'''open"),
            ("html", "<div class=\"x"),
            ("css", "a { b: \"c"),
            ("yaml", "k: 'v"),
            ("json", "{\"k"),
        ] {
            let n = code.encode_utf16().count() as u32;
            let mut last = 0;
            for s in highlight(l, code) {
                assert!(
                    s.start >= last && s.end > s.start && s.end <= n,
                    "{l}: {s:?}"
                );
                last = s.end;
            }
        }
    }
}
