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
    const out = { 이름없음: [], 작은타깃: [], 본문인라인: [], 낮은대비: [], 대체텍스트없음: [], 중복id: [], 제목계층: [], 문서계층: [] };

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
    /*
     * ★★★ 가상 요소로 넓힌 히트 영역을 **반드시 셈에 넣는다** (2026-08-06).
     *
     *   각주 링크는 글자 크기에 갇혀 17x20px 이라 markdown.css 가
     *   ::after { position:absolute; inset:-13px -4px } 로 실제 눌리는 넓이를
     *   25x46px 로 넓혀 놨다. 기기에서 elementFromPoint 로 확인했다 —
     *   보이는 상자 20px 바깥을 찍어도 그 링크가 잡힌다.
     *
     *   그런데 이 감사기는 getBoundingClientRect() 만 봤다. 그래서 **이미 고쳐진 것을
     *   매 문서마다 실패로 보고했다.** 헛경보를 내는 자는 곧 무시당하고, 그때는
     *   진짜 회귀가 같은 줄에 섞여 들어와도 그냥 넘어간다. 오늘 자바 테스트 목록과
     *   같은 종류의 고장이다 — 재는 도구가 틀리면 그 아래 모든 판단이 틀린다.
     */
    const withPseudo = (el, r) => {
        // 가상 요소는 **위치가 잡힌 조상** 기준이다. 호스트가 static 이면 이 계산이 성립하지 않는다.
        if (getComputedStyle(el).position === 'static') return r;
        let top = r.top, right = r.right, bottom = r.bottom, left = r.left;
        for (const which of ['::before', '::after']) {
            const s = getComputedStyle(el, which);
            if (!s.content || s.content === 'none' || s.position !== 'absolute') continue;
            const px = (v) => (v.endsWith('px') ? parseFloat(v) : NaN);
            const t = px(s.top), rt = px(s.right), b = px(s.bottom), l = px(s.left);
            // 음수 inset 만 넓힌다. auto 이거나 양수면 상자를 키우지 않는다.
            if (t < 0) top = Math.min(top, r.top + t);
            if (l < 0) left = Math.min(left, r.left + l);
            if (b < 0) bottom = Math.max(bottom, r.bottom - b);
            if (rt < 0) right = Math.max(right, r.right - rt);
        }
        return { top, right, bottom, left, width: right - left, height: bottom - top };
    };

    const hitBox = (el) => {
        const label = el.closest('label');
        if (label) return label.getBoundingClientRect();
        return withPseudo(el, el.getBoundingClientRect());
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

    /*
     * ── 6. 제목 계층
     *
     * ★★ 앱이 만든 제목과 **사용자 문서의 제목을 한 통에 세지 않는다** (2026-08-06).
     *   뷰어 화면에는 앱바 제목(h1)과 문서 자체의 첫 제목(h1)이 함께 있다. 통째로 세면
     *   "h1 이 2개" 가 **모든 문서에서** 뜬다 — 그런데 이건 고칠 수 있는 것이 아니다.
     *   사용자 글의 heading 단계를 앱이 낮춰 쓸 수는 없다.
     *   문서 쪽 계층 문제는 글쓴이의 것이므로 따로 모아 참고로만 남긴다.
     */
    const inDoc = (el) => !!el.closest('.md-target, .md-body');
    const hs = [...document.querySelectorAll('h1,h2,h3,h4,h5,h6')].filter(visible);
    const skips = (list, into, 꼬리) => {
        const levels = list.map((h) => +h.tagName[1]);
        for (let i = 1; i < levels.length; i++) {
            if (levels[i] - levels[i - 1] > 1) into.push('h' + levels[i - 1] + ' → h' + levels[i] + ' 건너뜀' + 꼬리);
        }
    };

    const 앱제목 = hs.filter((h) => !inDoc(h));
    const h1s = 앱제목.filter((h) => h.tagName === 'H1');
    if (h1s.length > 1) out.제목계층.push('앱 화면 제목 h1 이 ' + h1s.length + '개');
    // ★ 빈 제목은 스크린 리더가 "제목 수준 1" 이라고만 읽는다. 무엇의 제목인지 알 수 없다.
    for (const h of 앱제목) if (!(h.textContent || '').trim()) out.제목계층.push(desc(h) + ' 이 비어 있다');
    skips(앱제목, out.제목계층, '');
    skips(hs.filter(inDoc), out.문서계층, ' (사용자 글)');

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
    낮은대비: 'WCAG AA 미달 대비',
    대체텍스트없음: 'alt 없는 이미지',
    중복id: '중복 id',
    제목계층: '앱 화면의 제목 계층',
};

/*
 * ★★ 우리가 고칠 수 없는 것은 합계에서 뺀다 (2026-08-06).
 *   본문 인라인 링크는 줄 높이에 갇혀 48dp 가 될 수 없고(WCAG 2.5.8 도 예외로 둔다),
 *   문서 안의 제목 단계는 글쓴이가 정한 것이다.
 *   이걸 합계에 넣으면 링크가 하나라도 있는 문서에서는 '통과' 가 영영 안 뜬다 —
 *   그러면 이 감사기는 늘 빨간 상태가 되고, 아무도 안 본다.
 */
const 참고 = {
    본문인라인: '문서 본문의 작은 인라인 링크 (WCAG 2.5.8 예외 — 참고용)',
    문서계층: '문서 안의 제목 단계 (글쓴이의 글 — 참고용)',
};

const 항목출력 = (items) => {
    for (const it of items.slice(0, 12)) {
        console.log(`       ${typeof it === 'string' ? it : JSON.stringify(it, null, 0)}`);
    }
    if (items.length > 12) console.log(`       … 외 ${items.length - 12}건`);
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
    항목출력(items);
}
for (const [key, title] of Object.entries(참고)) {
    const items = result[key] ?? [];
    if (items.length === 0) continue;
    console.log(`  ℹ️  ${title} — ${items.length}건`);
    항목출력(items);
}
console.log(total === 0 ? '\n  통과\n' : `\n  합계 ${total}건\n`);
