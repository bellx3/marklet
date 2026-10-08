/**
 * 오픈소스 고지문 만들기 — `npm run notices`
 *
 * 설치 파일에 **실제로 들어가는** 구성요소만 모아 THIRD_PARTY_NOTICES.txt 를 쓴다.
 * 대부분(MIT · BSD · ISC · Apache-2.0)이 '저작권 표시와 라이선스 전문을 배포물에 함께 넣을 것'을 요구한다.
 *
 * 구성요소는 두 갈래다.
 *  1) 렌더러(웹 창이 쓰는 TypeScript 번들): package.json 의 dependencies 가 아니라 **번들에 들어간 모듈**을 본다.
 *     mermaid 가 끌고 오는 d3 · dagre · cytoscape 같은 것은 dependencies 에 적혀 있지 않다.
 *     Vite(Rollup)의 청크가 알려 주는 모듈 목록(chunk.modules)을 그대로 쓰므로 빠지는 것이 없다.
 *  2) Rust 크레이트(Marklet.exe 에 정적으로 링크되는 것): `cargo metadata` 로 윈도우용 **정상 의존성**의 폐포를 구한다
 *     (빌드 도구 · 시험용은 배포물에 안 들어가므로 뺀다). Cargo.lock 에 고정된 버전이 그대로 나온다.
 *
 * ★ 같은 전문은 한 번만 싣고, 뒤에 나오는 구성요소는 "위와 같다"고 가리킨다(Apache-2.0 전문이 수백 번 되풀이되지 않게).
 * ★ 의존성을 바꿨으면 다시 돌려 파일을 커밋하라. 파일은 설치 파일에 실려 나간다(tauri.conf.json 의 bundle.resources).
 *   WebView2 런타임은 Microsoft 가 따로 배포하는 것이라 이 파일에 싣지 않는다(설치 파일에도 들어 있지 않다).
 */
import crypto from 'node:crypto';
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'THIRD_PARTY_NOTICES.txt');
const { build } = await import('vite');

const LICENSE_FILE = /^(licen[sc]e|unlicense|copying|notice)([-_.].*)?$/i;

/** 모듈 id → 그 모듈이 속한 패키지 폴더. node_modules 밖이면 null. */
function packageRoot(id) {
    const clean = id.replace(/^\0/, '').split('?')[0].replace(/\\/g, '/');
    const marker = '/node_modules/';
    const at = clean.lastIndexOf(marker);
    if (at < 0) return null;
    const rest = clean.slice(at + marker.length).split('/');
    const name = rest[0].startsWith('@') ? `${rest[0]}/${rest[1]}` : rest[0];
    return clean.slice(0, at + marker.length) + name;
}

/** package.json 의 repository 는 꼴이 제각각이다(git+https · git@github.com: · github: · owner/repo). 주소 하나로 맞춘다. */
function normalizeRepo(r) {
    let x = (r ?? '').replace(/^git\+/, '').replace(/\.git$/, '');
    x = x
        .replace(/^git@github\.com:/, 'https://github.com/')
        .replace(/^github:/, 'https://github.com/');
    x = x.replace(/^git:\/\//, 'https://');
    if (/^[\w.-]+\/[\w.-]+$/.test(x)) x = `https://github.com/${x}`;
    return x;
}

/** 이름만 싣는다. author 에 든 이메일 · 홈페이지는 우리 저장소에 다시 싣지 않는다(라이선스 파일 안의 저작권 표시는 요구 사항이라 그대로 둔다). */
function nameOnly(a) {
    return (typeof a === 'string' ? a : (a?.name ?? '')).replace(/<[^>]*>/g, '').replace(/\([^)]*\)/g, '').trim();
}

function readLicenseTexts(dir) {
    const files = fs
        .readdirSync(dir)
        .filter((f) => LICENSE_FILE.test(f) && fs.statSync(path.join(dir, f)).isFile())
        .sort();
    return files.map((f) => fs.readFileSync(path.join(dir, f), 'utf8').replace(/\r\n/g, '\n').trim());
}

// ── 1) 렌더러 번들 ──────────────────────────────────────────────────────
const result = await build({
    configFile: path.join(ROOT, 'vite.config.ts'),
    logLevel: 'silent',
    build: { write: false, minify: false },
});
const outputs = Array.isArray(result) ? result : [result];
const roots = new Set();
for (const o of outputs) {
    for (const item of o.output) {
        if (item.type !== 'chunk') continue;
        for (const id of Object.keys(item.modules)) {
            const r = packageRoot(id);
            if (r) roots.add(r);
        }
    }
}

const packages = new Map(); // "kind:name@version" → 정보
for (const dir of roots) {
    let pkg;
    try {
        pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
    } catch {
        continue;
    }
    const key = `npm:${pkg.name}@${pkg.version}`;
    if (packages.has(key)) continue;
    const license =
        typeof pkg.license === 'string'
            ? pkg.license
            : (pkg.license?.type ?? (pkg.licenses ?? []).map((l) => l.type).join(' OR ')) ||
              'UNKNOWN';
    const texts = readLicenseTexts(dir);
    packages.set(key, {
        kind: 'npm',
        name: pkg.name,
        version: pkg.version,
        // package.json 이 라이선스 이름을 안 적은 패키지(khroma)는 같이 실린 전문을 보라고만 적는다.
        license:
            license === 'UNKNOWN' && texts.length ? '(아래 전문 참조 / see text below)' : license,
        repo: normalizeRepo(
            typeof pkg.repository === 'string' ? pkg.repository : (pkg.repository?.url ?? pkg.homepage ?? ''),
        ),
        author: nameOnly(pkg.author),
        texts,
    });
}

// ── 2) Rust 크레이트 ────────────────────────────────────────────────────
function rustCrates() {
    let raw;
    try {
        raw = execSync(
            'cargo metadata --format-version 1 --manifest-path src-tauri/Cargo.toml --filter-platform x86_64-pc-windows-msvc',
            { cwd: ROOT, encoding: 'utf8', maxBuffer: 1 << 28 },
        );
    } catch (e) {
        throw new Error(`cargo metadata 를 못 돌렸다(Rust 툴체인이 필요하다): ${e.message}`);
    }
    const meta = JSON.parse(raw);
    const byId = new Map(meta.packages.map((p) => [p.id, p]));
    const nodes = new Map(meta.resolve.nodes.map((n) => [n.id, n]));
    const seen = new Set();
    const stack = [meta.resolve.root];
    while (stack.length) {
        const id = stack.pop();
        if (seen.has(id)) continue;
        seen.add(id);
        // 정상(normal) 의존성만 따라간다 — 빌드 스크립트 · 시험용은 설치 파일에 들어가지 않는다.
        for (const d of nodes.get(id).deps) if (d.dep_kinds.some((k) => k.kind === null)) stack.push(d.pkg);
    }
    return [...seen]
        .map((id) => byId.get(id))
        .filter((p) => p.name !== 'marklet')
        .map((p) => ({
            kind: 'rust',
            name: p.name,
            version: p.version,
            license: p.license ?? 'UNKNOWN',
            repo: normalizeRepo(p.repository ?? p.homepage ?? ''),
            author: (p.authors ?? []).map(nameOnly).filter(Boolean).slice(0, 3).join(', '),
            texts: readLicenseTexts(path.dirname(p.manifest_path)),
        }));
}
for (const c of rustCrates()) packages.set(`rust:${c.name}@${c.version}`, c);

// ── 3) 쓰기 ─────────────────────────────────────────────────────────────
const byName = (a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version);
const npm = [...packages.values()].filter((p) => p.kind === 'npm').sort(byName);
const rust = [...packages.values()].filter((p) => p.kind === 'rust').sort(byName);
const list = [...npm, ...rust];
const missing = list.filter((p) => p.texts.length === 0);

const rule = '='.repeat(78);
const out = [];
out.push(
    'Marklet — 오픈소스 고지문 (Third-Party Notices)',
    '',
    'Marklet 은 MIT 라이선스입니다(LICENSE). 이 설치 파일에는 아래 오픈소스 구성요소가 들어 있습니다.',
    'Marklet includes the open-source components listed below, each under its own license.',
    '',
    '· 렌더러(수식 · 다이어그램 · 편집 · 인쇄를 그리는 웹 창의 번들): npm 패키지 ' + npm.length + '개',
    '· 실행 파일(Marklet.exe)에 링크된 Rust 크레이트: ' + rust.length + '개 (Rust 표준 라이브러리: MIT OR Apache-2.0, https://github.com/rust-lang/rust)',
    '',
    'Microsoft Edge WebView2 런타임은 설치 파일에 들어 있지 않습니다. Windows 에 있는 것을 쓰고, 없으면 Microsoft 의 설치 프로그램이 따로 설치합니다.',
    '(The Microsoft Edge WebView2 Runtime is not part of this package; it is provided by Windows or installed separately by Microsoft.)',
    '',
    '같은 라이선스 전문은 한 번만 싣고, 뒤의 구성요소는 "위와 같다"고 가리킵니다. 이 파일은 scripts/make-notices.mjs 가 만듭니다 — 직접 고치지 않습니다.',
    '(Identical license texts are printed once; later components point back to the first occurrence.)',
    '',
    '목록 (Index)',
    '------------',
    `[npm ${npm.length}]`,
);
for (const p of npm) out.push(`  ${p.name}@${p.version}  —  ${p.license}`);
out.push(`[Rust ${rust.length}]`);
for (const p of rust) out.push(`  ${p.name}@${p.version}  —  ${p.license}`);

const printed = new Map(); // 전문 해시 → 처음 실은 구성요소
for (const p of list) {
    out.push('', rule, `${p.name}@${p.version}`, `License: ${p.license}`);
    if (p.repo) out.push(`Source: ${p.repo}`);
    if (p.author) out.push(`Author: ${p.author}`);
    out.push(rule, '');
    if (!p.texts.length) {
        // 라이선스 파일이 패키지에 없다. 패키지가 밝힌 라이선스 이름만 적는다.
        out.push(
            `(이 구성요소는 라이선스 전문 파일을 싣지 않았다. 패키지가 밝힌 라이선스: ${p.license})`,
        );
        continue;
    }
    const parts = [];
    for (const t of p.texts) {
        const h = crypto.createHash('sha1').update(t).digest('hex');
        const first = printed.get(h);
        if (first && first !== p) {
            parts.push(`(전문은 ${first.name}@${first.version} 항목과 같다 / same text as ${first.name}@${first.version})`);
        } else {
            printed.set(h, p);
            parts.push(t);
        }
    }
    out.push(parts.join('\n\n---\n\n'));
}
fs.writeFileSync(OUT, out.join('\n') + '\n', 'utf8');

const kb = Math.round(fs.statSync(OUT).size / 1024);
console.log(`${path.relative(ROOT, OUT)} — npm ${npm.length}개 · Rust ${rust.length}개, ${kb} KB`);
const counts = {};
for (const p of list) counts[p.license] = (counts[p.license] ?? 0) + 1;
console.log(
    Object.entries(counts)
        .sort((a, b) => b[1] - a[1])
        .map(([k, v]) => `${k} ${v}`)
        .join(' · '),
);
if (missing.length) {
    console.log(`라이선스 파일 없음 ${missing.length}개: ${missing.map((p) => p.name).join(', ')}`);
}
