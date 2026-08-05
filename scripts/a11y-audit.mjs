#!/usr/bin/env node

/**
 * 접근성 감사 — 기기에 붙어 있는 웹뷰를 CDP 로 훑는다.
 *
 *   node scripts/a11y-audit.mjs <포트> [화면이름]
 *
 * ★ 무엇을 보는가.
 *   1) 이름 없는 조작 요소 — TalkBack 이 "버튼" 이라고만 읽는다. 뭘 하는 버튼인지 알 수 없다.
 *   2) 48dp 미만 터치 타깃 — 손이 큰 사람·떨림이 있는 사람이 못 누른다(10-1절).
 *   3) 글자 대비 — WCAG AA (본문 4.5:1, 큰 글자 3:1).
 *   4) 이미지 대체 텍스트 · 제목 계층 · 중복 id.
 *
 * ★ 숨은 화면(hidden)은 건너뛴다. 셸이 화면 여섯 개를 전부 DOM 에 붙여 두기 때문에
 *   그냥 훑으면 지금 안 보이는 것까지 잡혀서 결과를 못 믿게 된다.
 */

import { readFileSync } from 'node:fs';

const port = process.argv[2];
const label = process.argv[3] ?? '(현재 화면)';
if (!port) {
    console.error('사용: node scripts/a11y-audit.mjs <포트> [화면이름]');
    process.exit(1);
}

void readFileSync; // (사용 안 함 — 린트 방지)

const EXPR = String.raw`
(() => {
    const out = { 이름없음: [], 작은타깃: [], 본문인라인: [], 낮은대비: [], 대체텍스트없음: [], 중복id: [], 제목계층: [] };

    // ── 지금 보이는 화면만
    const visible = (el) => {
        for (let n = el; n && n !== document.body; n = n.parentElement) {
            if (n.hidden) return false;
            const s = getComputedStyle(n);
            if (s.display === 'none' || s.visibility === 'hidden') return false;
        }
        return true;
    };

    const desc = (el) => {
        const cls = el.className && typeof el.className === 'string' ? '.' + el.className.trim().split(/\s+/).join('.') : '';
        return el.tagName.toLowerCase() + cls;
    };

    // ── 1. 조작 요소의 접근성 이름
    const INTERACTIVE = 'button, a[href], input, select, textarea, [role="button"], [role="menuitem"], [role="radio"], [tabindex]:not([tabindex="-1"])';
    for (const el of document.querySelectorAll(INTERACTIVE)) {
        if (!visible(el)) continue;
        const name =
            (el.getAttribute('aria-label') || '').trim() ||
            (el.getAttribute('aria-labelledby')
                ? (document.getElementById(el.getAttribute('aria-labelledby'))?.textContent || '').trim()
                : '') ||
            (el.textContent || '').trim() ||
            (el.getAttribute('title') || '').trim() ||
            (el.tagName === 'INPUT' && el.labels?.length ? (el.labels[0].textContent || '').trim() : '') ||
            (el.getAttribute('placeholder') || '').trim();
        if (!name) out.이름없음.push(desc(el));
    }

    // ── 2. 터치 타깃 48dp
    const MIN = 48;

    /*
     * ★ 실제로 눌리는 넓이를 재야 한다.
     *   1) <label> 로 감싼 입력은 **라벨 전체**가 타깃이다(스위치가 28px 이어도 행이 56px 이면 된다).
     *   2) 본문 안의 인라인 링크는 줄 높이에 갇혀 있어 48dp 를 만들 수 없다.
     *      WCAG 2.2 의 2.5.8 도 그래서 인라인은 예외로 둔다. 따로 모아 둔다.
     */
    const hitBox = (el) => {
        const label = el.closest('label');
        if (label) return label.getBoundingClientRect();
        return el.getBoundingClientRect();
    };
    const isInline = (el) => {
        // 문서 본문 안에 있고, 글자 흐름 속에 놓인 것
        if (!el.closest('.md-target, .md-body')) return false;
        return getComputedStyle(el).display.startsWith('inline');
    };

    for (const el of document.querySelectorAll(INTERACTIVE)) {
        if (!visible(el)) continue;
        const r = hitBox(el);
        if (r.width === 0 && r.height === 0) continue;
        const w = Math.round(r.width), h = Math.round(r.height);
        if (h >= MIN && w >= MIN) continue;

        const row = { 요소: desc(el), 이름: (el.getAttribute('aria-label') || el.textContent || '').trim().slice(0, 20), 크기: w + 'x' + h };
        if (isInline(el)) out.본문인라인.push(row);
        else out.작은타깃.push(row);
    }

    // ── 3. 대비
    const parseRgb = (s) => {
        const m = s.match(/rgba?\(([^)]+)\)/);
        if (!m) return null;
        const p = m[1].split(',').map((x) => parseFloat(x));
        return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 };
    };
    const lum = (c) => {
        const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
        return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b);
    };
    const bgOf = (el) => {
        for (let n = el; n; n = n.parentElement) {
            const c = parseRgb(getComputedStyle(n).backgroundColor);
            if (c && c.a > 0.5) return c;
        }
        return { r: 255, g: 255, b: 255, a: 1 };
    };
    const seen = new Set();
    for (const el of document.querySelectorAll('*')) {
        if (!visible(el)) continue;
        // 자기 자신이 직접 들고 있는 글자만
        const own = [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim());
        if (!own) continue;
        const s = getComputedStyle(el);
        const fg = parseRgb(s.color);
        if (!fg) continue;
        const bg = bgOf(el);
        const L1 = lum(fg), L2 = lum(bg);
        const ratio = (Math.max(L1, L2) + 0.05) / (Math.min(L1, L2) + 0.05);
        const px = parseFloat(s.fontSize);
        const bold = parseInt(s.fontWeight, 10) >= 700;
        const large = px >= 24 || (px >= 18.66 && bold);
        const need = large ? 3 : 4.5;
        if (ratio < need) {
            const key = desc(el) + '|' + s.color;
            if (seen.has(key)) continue;
            seen.add(key);
            out.낮은대비.push({
                요소: desc(el),
                글: (el.textContent || '').trim().slice(0, 24),
                대비: ratio.toFixed(2),
                필요: need,
                크기: px + 'px',
            });
        }
    }

    // ── 4. 이미지 대체 텍스트
    for (const img of document.querySelectorAll('img')) {
        if (!visible(img)) continue;
        if (!img.hasAttribute('alt')) out.대체텍스트없음.push(img.getAttribute('src')?.slice(0, 40) ?? '(src 없음)');
    }

    // ── 5. 중복 id (aria-labelledby 가 엉뚱한 것을 가리키게 된다)
    const ids = new Map();
    for (const el of document.querySelectorAll('[id]')) {
        ids.set(el.id, (ids.get(el.id) ?? 0) + 1);
    }
    for (const [id, n] of ids) if (n > 1) out.중복id.push(id + ' x' + n);

    // ── 6. 제목 계층 (한 화면에 h1 은 하나, 단계를 건너뛰지 않는다)
    const hs = [...document.querySelectorAll('h1,h2,h3,h4,h5,h6')].filter(visible);
    const levels = hs.map((h) => +h.tagName[1]);
    if (levels.filter((l) => l === 1).length > 1) out.제목계층.push('h1 이 ' + levels.filter((l) => l === 1).length + '개');
    for (let i = 1; i < levels.length; i++) {
        if (levels[i] - levels[i - 1] > 1) out.제목계층.push('h' + levels[i - 1] + ' → h' + levels[i] + ' 건너뜀');
    }

    return JSON.stringify(out);
})()
`;

const res = await fetch(`http://127.0.0.1:${port}/json/list`).then((r) => r.json());
const page = res.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
if (!page) {
    console.error('페이지 타깃을 찾지 못했습니다. adb forward 가 걸려 있는지 확인하세요.');
    process.exit(1);
}

const { WebSocket } = await import('ws').catch(() => ({ WebSocket: globalThis.WebSocket }));
const ws = new WebSocket(page.webSocketDebuggerUrl);

const result = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('시간 초과')), 15000);
    ws.onopen = () =>
        ws.send(
            JSON.stringify({
                id: 1,
                method: 'Runtime.evaluate',
                params: { expression: EXPR, returnByValue: true, awaitPromise: true },
            }),
        );
    ws.onmessage = (m) => {
        const msg = JSON.parse(m.data.toString());
        if (msg.id !== 1) return;
        clearTimeout(timer);
        ws.close();
        if (msg.result?.exceptionDetails) {
            reject(
                new Error(
                    msg.result.exceptionDetails.text +
                        ' ' +
                        (msg.result.exceptionDetails.exception?.description ?? ''),
                ),
            );
            return;
        }
        resolve(JSON.parse(msg.result.result.value));
    };
    ws.onerror = (e) => reject(new Error(String(e.message ?? e)));
});

const TITLES = {
    이름없음: '이름 없는 조작 요소 (TalkBack 이 "버튼" 이라고만 읽는다)',
    작은타깃: '48dp 미만 터치 타깃 — 앱 UI (10-1절)',
    본문인라인: '48dp 미만 — 문서 본문의 인라인 링크 (WCAG 2.5.8 예외지만 누르기 어렵다)',
    낮은대비: 'WCAG AA 미달 대비',
    대체텍스트없음: 'alt 없는 이미지',
    중복id: '중복 id',
    제목계층: '제목 계층',
};

console.log(`\n═══ 접근성 감사 · ${label} ═══`);
let total = 0;
for (const [key, title] of Object.entries(TITLES)) {
    const items = result[key] ?? [];
    total += items.length;
    if (items.length === 0) {
        console.log(`  ✅ ${title}`);
        continue;
    }
    console.log(`  ❌ ${title} — ${items.length}건`);
    for (const it of items.slice(0, 12)) {
        console.log(`       ${typeof it === 'string' ? it : JSON.stringify(it, null, 0)}`);
    }
    if (items.length > 12) console.log(`       … 외 ${items.length - 12}건`);
}
console.log(total === 0 ? '\n  통과\n' : `\n  합계 ${total}건\n`);
