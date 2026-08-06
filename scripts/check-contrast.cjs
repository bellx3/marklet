#!/usr/bin/env node

/**
 * 색 대비 검사 (`npm run build` 가 부른다).
 *
 * ★★ 왜 필요한가 (2026-08-06).
 *   어두운 테마에서 **지금 보고 있는 검색 결과의 글자가 2.73:1** 이었다.
 *   WCAG AA 기준(4.5:1)의 절반을 조금 넘는 값이다. 나머지 검색 결과는 5.18:1 로
 *   멀쩡했으니, 하필 **사용자가 눈으로 좇는 그 한 곳**만 안 읽혔다.
 *
 *   색은 눈으로 봐서는 통과 여부를 모른다. 특히 어두운 테마는 "그럭저럭 보인다" 는
 *   느낌과 실제 수치가 크게 어긋난다. 그래서 재는 쪽을 코드에 둔다.
 *
 * ★ 여기 없는 조합은 검사되지 않는다. 새 색을 만들면 PAIRS 에 더해라.
 *   (자바 테스트 목록을 손으로 관리하다 빼먹은 적이 있어서, 여기는 **변수를 전부 훑고
 *    PAIRS 에 한 번도 안 나온 색을 따로 보고**한다. 조용히 빠지지 않게.)
 */

const fs = require('fs');
const path = require('path');

const repoRoot = path.resolve(__dirname, '..');
/** 테마 변수가 들어 있는 파일들. 한 파일만 보면 --surface 같은 색을 통째로 놓친다. */
const CSS_FILES = ['base.css', 'markdown.css'].map((f) => path.join(repoRoot, 'src', 'styles', f));

/** [이름, 글자 변수, 바탕 변수, 최소 대비] — 4.5 는 본문 글자, 3 은 큰 글자·경계선. */
const PAIRS = [
    ['본문 글자', '--md-fg', '--md-bg', 4.5],
    ['흐린 글자', '--md-fg-muted', '--md-bg', 4.5],
    ['링크', '--md-link', '--md-bg', 4.5],
    ['인라인 코드', '--md-fg', '--md-code-bg-inline', 4.5],
    ['코드 블록', '--md-fg', '--md-code-bg-block', 4.5],
    ['경고 글자', '--md-warn-fg', '--md-warn-bg', 4.5],
    ['검색 결과', '--md-fg', '--md-hit-bg', 4.5],
    // ★ 이 줄이 이 파일을 만든 이유다. inherit 로 두면 어두운 테마에서 2.73:1 이 된다.
    ['현재 검색 결과', '--md-hit-fg-current', '--md-hit-bg-current', 4.5],
    ['카드 위 글자', '--md-fg', '--surface', 4.5],
    ['카드 위 흐린 글자', '--md-fg-muted', '--surface', 4.5],
    ['강조 버튼 글자', '--accent-fg', '--accent', 4.5],
    /*
     * ★★ 포커스 링은 **버튼 바깥**(outline-offset: 2px)에 그려진다. 그래서 버튼 채움이 아니라
     *   그 뒤 표면과 견줘야 한다. currentColor 로 뒀더니 밝은 테마 [삭제] 가 1.00:1 이었다.
     */
    ['포커스 링(표면 위)', '--md-fg', '--surface', 3],
    ['포커스 링(바탕 위)', '--md-fg', '--md-bg', 3],
    ['기본 포커스 링', '--md-link', '--surface', 3],
    /* ★ 체크 표시는 상태를 알리는 그림이다(WCAG 1.4.11). 칠해진 상자 위에 놓인다. */
    ['체크 표시', '--md-check-fg', '--md-link', 3],
    ['칠해진 체크 상자', '--md-link', '--md-bg', 3],
];

/**
 * 검사에서 빼도 되는 **색**. ★ 이유를 적어야 뺀다.
 * (길이·글꼴 같은 색이 아닌 변수는 아래에서 자동으로 빠진다.)
 */
const EXEMPT = {
    '--md-border': '경계선 장식이다. 컨트롤의 유일한 윤곽이 아니다(버튼은 글자로 읽힌다).',
    '--md-quote-bar': '인용 막대는 장식이다. 인용 글자 자체는 본문색으로 읽힌다.',
    '--md-warn-bar': '경고 막대는 장식이다. 경고 글자가 따로 검사된다.',
    '--md-hit-outline': '현재 결과를 **덧붙여** 알리는 외곽선이다. 바탕색만으로도 이미 갈린다.',
    '--md-bg': '바탕 자체다. 여러 짝에서 뒷배경으로 이미 쓰인다.',
    '--surface': '표면 자체다. 여러 짝에서 뒷배경으로 이미 쓰인다.',
    '--accent': '강조 버튼 바탕. 그 위 글자를 따로 검사한다.',
    '--md-code-bg-inline': '코드 바탕. 그 위 글자를 따로 검사한다.',
    '--md-code-bg-block': '코드 바탕. 그 위 글자를 따로 검사한다.',
    '--md-warn-bg': '경고 바탕. 그 위 글자를 따로 검사한다.',
    '--md-hit-bg': '검색 결과 바탕. 그 위 글자를 따로 검사한다.',
    '--md-hit-bg-current': '현재 결과 바탕. 그 위 글자를 따로 검사한다.',
};

/** 색인가. `#rgb`·`#rrggbb` 만 잰다 — 길이·글꼴·그림자는 대비를 따질 값이 아니다. */
function isColor(v) {
    return /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(v.trim());
}

function vars(text) {
    const out = {};
    for (const m of text.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) out[m[1]] = m[2].trim();
    return out;
}

function rgb(hex) {
    const h = hex.replace('#', '').trim();
    const full = h.length === 3 ? [...h].map((c) => c + c).join('') : h;
    return [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16));
}

function luminance([r, g, b]) {
    const f = (v) => {
        v /= 255;
        return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
    };
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}

function contrast(a, b) {
    const [hi, lo] = [luminance(rgb(a)), luminance(rgb(b))].sort((x, y) => y - x);
    return (hi + 0.05) / (lo + 0.05);
}

const sources = CSS_FILES.map((f) => fs.readFileSync(f, 'utf8'));

/** 모든 파일의 같은 셀렉터 블록을 합친다. 뒤에 오는 파일이 이긴다(CSS 순서와 같다). */
function mergedVars(selector) {
    let out = {};
    for (const css of sources) {
        let from = 0;
        for (;;) {
            const i = css.indexOf(selector, from);
            if (i < 0) break;
            const open = css.indexOf('{', i);
            const close = css.indexOf('\n}', open);
            out = { ...out, ...vars(css.slice(open, close)) };
            from = close + 1;
        }
    }
    return out;
}
const 기본 = mergedVars(':root {');
const themes = {
    밝은: 기본,
    어두운: { ...기본, ...mergedVars("[data-theme='dark'] {") },
};

if (Object.keys(기본).length < 10) {
    console.error('❌ 테마 변수를 거의 못 읽었습니다. 이건 통과가 아닙니다.');
    process.exit(1);
}

let failed = 0;
for (const [themeName, v] of Object.entries(themes)) {
    console.log(`\n── ${themeName} 테마`);
    for (const [name, fgVar, bgVar, need] of PAIRS) {
        const fg = v[fgVar];
        const bg = v[bgVar];
        if (!fg || !bg) {
            console.error(`  ✗ ${name}: 변수가 없습니다 (${fgVar}=${fg}, ${bgVar}=${bg})`);
            failed++;
            continue;
        }
        const r = contrast(fg, bg);
        const ok = r >= need;
        if (!ok) failed++;
        console.log(
            `  ${ok ? ' ' : '✗'} ${name.padEnd(14)} ${r.toFixed(2)} / ${need}   ${fg} on ${bg}`,
        );
    }
}

// ★ PAIRS 에 한 번도 안 나온 색을 보고한다. 조용히 빠지는 걸 막는 장치다.
const used = new Set(PAIRS.flatMap(([, fg, bg]) => [fg, bg]));
const 미검사 = Object.keys(themes.밝은).filter(
    (k) => isColor(themes.밝은[k]) && !used.has(k) && !EXEMPT[k],
);
if (미검사.length) {
    console.error(`\n✗ 검사되지 않은 색이 있습니다: ${미검사.join(', ')}`);
    console.error('  PAIRS 에 더하거나, 왜 안 봐도 되는지 EXEMPT 에 이유를 적으세요.');
    failed++;
}

if (failed) {
    console.error(`\n❌ 색 대비 검사 실패 (${failed}건)`);
    process.exit(1);
}
console.log('\n✓ 색 대비 통과');
