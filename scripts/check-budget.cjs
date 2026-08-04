#!/usr/bin/env node

/**
 * 번들 예산 검사. npm run build 뒤에 자동 실행되고 초과하면 exit 1 로 빌드를 실패시킨다.
 *
 * 예산의 근거는 05_조사_렌더링스택.md 8장(esbuild min+gzip 실측):
 *   markdown-it 52.0 + 플러그인 5 + DOMPurify 10.6 + hljs 22.8 + js-yaml 13.2 = 약 104KB
 *   + 앱 UI 추정 40KB + CSS 8KB = 약 152KB
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const ROOT = path.join(__dirname, '..');
// ★ vite.config.ts 의 build.outDir 과 같아야 한다 (dist 가 아니라 www)
const ASSETS = path.join(ROOT, 'www', 'assets');
const SRC = path.join(ROOT, 'src');

const BUDGET_INITIAL_JS_KB = 200; // 목표 150, 상한 200
const BUDGET_INITIAL_CSS_KB = 15; // 목표 10, 상한 15

// ★ 지연 청크는 '한 덩어리'가 아니라 청크마다 상한이 다르다 (12-1절 14·15번).
//   하나의 공통 상한만 두면 KaTeX 가 두 배로 불어나도 Mermaid 상한 아래라 그냥 통과한다.
//   키 = 파일명에 들어 있는 문자열 (vite.config.ts 의 manualChunks 이름과 같아야 한다)
//   pkgs = 소스가 그 라이브러리를 실제로 쓰는지 판정할 때 찾을 import 지정자들
const LAZY_BUDGETS = {
    katex: {
        limitKb: 500, // 목표 400. 렌더링 스택 문서 예상 396KB
        // ★ 실제 import 지정자는 'katex' 하나가 아니다. 6-6절 math.ts 는
        //   '@vscode/markdown-it-katex' 와 'katex/dist/katex.min.css' 를 쓴다.
        //   둘 다 적어 두지 않으면 이 가드가 D10 에 영영 발동하지 않는 죽은 코드가 된다.
        pkgs: ['katex', '@vscode/markdown-it-katex'],
    },
    mermaid: {
        limitKb: 1000, // 목표 950. gzip 936KB 실측 — 낮추지 마라
        pkgs: ['mermaid'],
    },
};
const LAZY_NAMES = Object.keys(LAZY_BUDGETS);

/**
 * src/ 안에서 그 패키지들 중 하나라도 import 하고 있는가.
 *
 * ★ 이 판정이 없으면 개발 초기(아직 KaTeX·Mermaid 를 안 붙인 단계)에 빌드가 항상 실패한다.
 *   반대로 '없어도 통과'로만 두면 manualChunks 가 깨져 초기 번들에 섞여 들어가도 모른다.
 *   그래서 "소스가 쓰고 있는데 청크가 없다"일 때만 실패시킨다.
 *
 * ★ 매칭은 "여는 따옴표 + 패키지명"까지만 본다(접두사). 이유:
 *     'katex'                     → 잡힌다
 *     'katex/dist/katex.min.css'  → 잡힌다  ← 닫는 따옴표까지 요구하면 놓친다
 *     '@vscode/markdown-it-katex' → 'katex 로는 안 잡힌다(앞 글자가 '-' 라서).
 *                                   그래서 pkgs 에 따로 적어 둔다
 */
function isImportedInSrc(pkgs) {
    if (!fs.existsSync(SRC)) return false;
    const needles = pkgs.flatMap((p) => [`'${p}`, `"${p}`]);
    const stack = [SRC];
    while (stack.length) {
        const dir = stack.pop();
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const p = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                stack.push(p);
                continue;
            }
            if (!/\.(ts|tsx|js|mjs)$/.test(entry.name)) continue;
            const text = fs.readFileSync(p, 'utf8');
            if (needles.some((n) => text.includes(n))) return true;
        }
    }
    return false;
}

if (!fs.existsSync(ASSETS)) {
    console.error(`✗ 산출물 폴더가 없다: ${ASSETS}`);
    console.error('  vite.config.ts 의 build.outDir 이 www 인지 확인해라.');
    process.exit(1);
}

let initialJs = 0;
let initialCss = 0;
// ★ 최댓값이 아니라 합이다. KaTeX 는 JS 청크와 CSS 청크가 같이 나오고,
//   Rollup 이 동적 import 경계에서 더 쪼갤 수도 있다. 예산은 "그 기능을 켤 때
//   사용자가 치르는 총량"이어야 하므로 같은 이름의 파일을 전부 더한다.
//   (최댓값으로 재면 조각이 여럿일 때 상한을 넘어도 통과한다.)
const lazySum = {}; // 이름 -> gzip KB 합
const lazyCount = {}; // 이름 -> 파일 수
const rows = [];
const over = [];

for (const f of fs.readdirSync(ASSETS)) {
    const ext = path.extname(f);
    if (ext !== '.js' && ext !== '.css') continue;

    const gz = zlib.gzipSync(fs.readFileSync(path.join(ASSETS, f))).length / 1024;
    const lazyName = LAZY_NAMES.find((n) => f.includes(n));

    if (lazyName) {
        lazySum[lazyName] = (lazySum[lazyName] ?? 0) + gz;
        lazyCount[lazyName] = (lazyCount[lazyName] ?? 0) + 1;
    } else if (ext === '.js') initialJs += gz;
    else initialCss += gz;

    rows.push([lazyName ? `지연:${lazyName}` : '초기', gz, f]);
}

rows.sort((a, b) => b[1] - a[1]);
for (const [kind, gz, f] of rows) {
    console.log(`  ${kind.padEnd(12)}  ${gz.toFixed(1).padStart(7)}KB  ${f}`);
}

console.log('');
console.log(`초기 JS  (gzip): ${initialJs.toFixed(1)}KB / 상한 ${BUDGET_INITIAL_JS_KB}KB`);
console.log(`초기 CSS (gzip): ${initialCss.toFixed(1)}KB / 상한 ${BUDGET_INITIAL_CSS_KB}KB`);

for (const [name, { limitKb, pkgs }] of Object.entries(LAZY_BUDGETS)) {
    const got = lazySum[name];
    if (got === undefined) {
        if (isImportedInSrc(pkgs)) {
            // 쓰고 있는데 청크가 없다 = manualChunks 가 안 먹었거나 초기 번들에 섞였다.
            console.error(
                `✗ 지연 청크 '${name}' 가 없는데 소스는 ${pkgs.map((p) => `'${p}'`).join(' 또는 ')} 를 import 한다` +
                    ' — vite.config.ts 의 manualChunks 를 확인해라',
            );
            over.push(`${name} 청크 없음`);
        } else {
            console.log(`지연 ${name.padEnd(8)}: (아직 안 씀 — 건너뜀)`);
        }
        continue;
    }
    const n = lazyCount[name];
    const detail = n > 1 ? ` (${n}개 파일 합)` : '';
    console.log(`지연 ${name.padEnd(8)}: ${got.toFixed(1)}KB${detail} / 상한 ${limitKb}KB`);
    if (got > limitKb) over.push(`${name} ${got.toFixed(1)}KB`);
}

if (initialJs > BUDGET_INITIAL_JS_KB) over.push(`초기 JS ${initialJs.toFixed(1)}KB`);
if (initialCss > BUDGET_INITIAL_CSS_KB) over.push(`초기 CSS ${initialCss.toFixed(1)}KB`);

if (over.length) {
    console.error(`\n✗ 번들 예산 초과: ${over.join(', ')}`);
    process.exit(1);
}
console.log('\n✓ 번들 예산 통과');
