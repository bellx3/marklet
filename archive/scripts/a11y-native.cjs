#!/usr/bin/env node

/**
 * 네이티브 접근성 트리 감사 — 스크린 리더가 **실제로 받는 것**을 본다.
 *
 *   adb shell uiautomator dump /sdcard/ui.xml
 *   adb shell cat /sdcard/ui.xml > ui-dump.xml
 *   node scripts/a11y-native.cjs ui-dump.xml [화면이름]
 *
 * ★★ 왜 CDP 감사(a11y-audit.mjs)로 안 되는가.
 *   저쪽은 DOM 을 본다. 하지만 토크백이 읽는 것은 **웹뷰가 안드로이드 쪽으로 넘긴
 *   AccessibilityNodeInfo 트리**다. 그 변환에서 빠지는 것이 있다 —
 *   aria 를 붙였는데 네이티브 노드에는 안 나타나거나, DOM 에서는 하나인데
 *   네이티브에서는 둘로 쪼개지거나.
 *
 * ★★★ 접근성 서비스가 켜져 있어야 웹뷰가 이 트리를 만든다. 안 켜면 웹뷰 노드
 *   하나만 나오고 속은 텅 비어 있다 — 그걸 보고 "문제 없음" 이라고 하면 안 된다.
 *   그래서 노드 수가 너무 적으면 아래에서 경고한다.
 *
 * ★ 이 기기 밀도 450 → 48dp = 135px. 다른 기기면 --dp 로 준다.
 */

const fs = require('node:fs');

const file = process.argv[2] ?? 'ui-dump.xml';
const label = process.argv[3] ?? '(현재 화면)';
const dpArg = process.argv.find((a) => a.startsWith('--px='));
const MIN_PX = dpArg ? Number(dpArg.slice(5)) : 135;

const xml = fs.readFileSync(file, 'utf8');
const nodes = [...xml.matchAll(/<node ([^>]*?)\/?>/g)].map((m) => {
    const a = {};
    for (const p of m[1].matchAll(/([\w-]+)="([^"]*)"/g)) a[p[1]] = p[2];
    return a;
});

const box = (n) => {
    const b = (/\[(\d+),(\d+)]\[(\d+),(\d+)]/.exec(n.bounds) ?? []).slice(1).map(Number);
    return b.length === 4 ? { w: b[2] - b[0], h: b[3] - b[1] } : { w: 0, h: 0 };
};
const 이름of = (n) => (n['content-desc'] || n.text || '').trim();
const 조작of = (n) => n.clickable === 'true' || n.checkable === 'true';

const pkgs = [...new Set(nodes.map((n) => n.package).filter(Boolean))];
const 문제 = [];

console.log(`\n═══ 네이티브 접근성 트리 · ${label} ═══`);
console.log(`  패키지 ${pkgs.join(', ')} · 노드 ${nodes.length}개`);

for (const n of nodes) {
    const { w, h } = box(n);
    if (w <= 0 || h <= 0) continue;
    const 이름 = 이름of(n);
    const 조작 = 조작of(n);
    if (!조작 && !이름) continue;
    const cls = (n.class || '').split('.').pop();
    console.log(
        `  ${조작 ? '[누름]' : '      '}${n.focusable === 'true' ? '초점O' : '초점X'} ` +
            `${cls.padEnd(12)} ${`${w}x${h}`.padEnd(10)} ${JSON.stringify(이름.slice(0, 40))}`,
    );
    if (조작 && !이름) 문제.push(`이름 없는 조작 요소 — ${cls} ${w}x${h}`);
    if (조작 && (w < MIN_PX || h < MIN_PX))
        문제.push(`48dp(${MIN_PX}px) 미만 — ${w}x${h} ${JSON.stringify(이름.slice(0, 26))}`);
    if (조작 && n.focusable !== 'true')
        문제.push(`누를 수 있는데 초점을 못 받는다 — ${JSON.stringify(이름.slice(0, 26))}`);
}

console.log('\n  ── 판정');
if (nodes.length < 6) {
    console.log(
        '  ⚠ 노드가 너무 적다. 접근성 서비스가 꺼져 있으면 웹뷰가 트리를 만들지 않는다.\n' +
            '    이 상태의 "문제 없음" 은 아무것도 뜻하지 않는다.',
    );
}
console.log(문제.length ? 문제.map((x) => `  ❌ ${x}`).join('\n') : '  ✅ 문제 없음');
console.log('');
process.exitCode = 문제.length ? 1 : 0;
