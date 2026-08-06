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
const CSS = path.join(repoRoot, 'src', 'styles', 'markdown.css');

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
];

/** 검사에서 빼도 되는 색. **이유를 적어야 뺀다.** */
const EXEMPT = {
    '--md-border': '경계선 장식이다. 컨트롤의 유일한 윤곽이 아니다(버튼은 글자로 읽힌다).',
    '--md-quote-bar': '인용 막대는 장식이다. 인용 글자 자체는 본문색으로 읽힌다.',
    '--md-warn-bar': '경고 막대는 장식이다. 경고 글자가 따로 검사된다.',
    '--md-hit-outline': '현재 결과를 **덧붙여** 알리는 외곽선이다. 바탕색만으로도 이미 갈린다.',
    '--md-measure': '길이',
    '--md-pad-x': '길이',
    '--md-font-size': '길이',
    '--md-line-height': '길이',
    '--md-font-body': '글꼴',
    '--md-font-code': '글꼴',
};

function block(css, selector) {
    const i = css.indexOf(selector);
    if (i < 0) throw new Error(`${selector} 블록을 찾지 못했습니다`);
    const open = css.indexOf('{', i);
    const close = css.indexOf('\n}', open);
    return css.slice(open, close);
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

const css = fs.readFileSync(CSS, 'utf8');
const themes = {
    밝은: vars(block(css, ':root {')),
    어두운: { ...vars(block(css, ':root {')), ...vars(block(css, "[data-theme='dark'] {")) },
};

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
const 미검사 = Object.keys(themes.밝은).filter((k) => !used.has(k) && !EXEMPT[k]);
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
