import yaml from 'js-yaml';
import { t } from '../i18n';

export interface ParsedDocument {
    frontmatter: Record<string, unknown> | null;
    body: string;
}

// ﻿ = BOM. 윈도우에서 만든 파일에 붙어 있으면 매치가 실패하므로 함께 처리한다.
const FRONTMATTER_RE = /^﻿?---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

/** 정상 frontmatter 는 1KB 를 넘지 않는다. 넘으면 파싱하지 않는다. */
const MAX_FRONTMATTER_BYTES = 64 * 1024;

/**
 * 별칭(`*name`) 참조 상한.
 *
 * ★★★ **크기 상한만으로는 YAML 폭탄을 못 막는다.** 별칭은 입력이 작아도 결과가
 *   지수로 분다 — js-yaml 4.3.1 에는 확장 상한이 아예 없다(2026-08-06 실측):
 *       레벨 5 · 276바이트 →  2.4MB ·  17ms
 *       레벨 6 · 322바이트 → 21.8MB · 150ms
 *   레벨 8이면 414바이트로 1.8GB 다. 남이 보낸 .md 하나로 앱이 죽는다 —
 *   그런데 이 앱은 **어디서 왔는지 모르는 문서를 여는 것**이 존재 이유다.
 *
 * ★ 실제 frontmatter 는 별칭을 쓰지 않는다(제목·글쓴이·날짜뿐이다).
 *   그래도 0 으로 막지는 않는다 — 손으로 쓴 설정 파일에 몇 개 있을 수 있다.
 *   20개면 최악의 경우에도 노드가 수천 개를 넘지 않는다.
 *
 * ★ 넘으면 **문서를 못 열게 하지 말고** frontmatter 만 건너뛴다.
 *   본문은 멀쩡하고, 사용자가 잃는 것은 접이식 표 하나뿐이다.
 */
const MAX_ALIASES = 20;

/**
 * 값 자리에 오는 `*name` 만 센다.
 * ★ 따옴표 안의 별표(`title: "a * b"`)를 잘못 셀 수 있지만, 그래도 상한이 20이라
 *   현실적인 문장은 걸리지 않는다. 걸려도 결과는 '표 하나 안 보임' 이다.
 */
function aliasCount(yamlText: string): number {
    return (yamlText.match(/(?:^|[\s,[{])\*[A-Za-z0-9_-]+/g) ?? []).length;
}

export function parseDocument(source: string): ParsedDocument {
    const m = FRONTMATTER_RE.exec(source);
    if (!m) return { frontmatter: null, body: source };

    // ★ 크기와 별칭을 **둘 다** 본다. 하나로는 못 막는다 — 위 주석 참고.
    if (m[1].length > MAX_FRONTMATTER_BYTES || aliasCount(m[1]) > MAX_ALIASES) {
        return { frontmatter: null, body: source.slice(m[0].length) };
    }

    try {
        const data = yaml.load(m[1], {
            // ★ CORE_SCHEMA 로 고정. DEFAULT_SCHEMA 는 커스텀 태그를 받는다.
            //   실측: CORE_SCHEMA 는 !!js/function 을 "unknown tag" 로 거부한다.
            schema: yaml.CORE_SCHEMA,
            json: true,
        });
        if (data === null || typeof data !== 'object' || Array.isArray(data)) {
            return { frontmatter: null, body: source };
        }
        return {
            frontmatter: data as Record<string, unknown>,
            body: source.slice(m[0].length),
        };
    } catch {
        // YAML 이 깨졌으면 frontmatter 없는 것으로 취급. 문서는 정상적으로 열려야 한다.
        return { frontmatter: null, body: source };
    }
}

/**
 * 접이식 표의 요약(제목)으로 쓸 키들. 대소문자를 가리지 않는다.
 *
 * ★★★ 예전에는 `fm[t.frontmatter.document]` 로 찾았다 — **표시용 라벨을 키로 쓴 것**이다.
 *   영어 라벨은 `'Document'`(대문자 D)인데 문서에 흔히 쓰는 키는 소문자 `document` 다.
 *   그래서 **우리가 앱에 넣어 둔 영어 예제 문서조차** 제목이 안 잡히고
 *   'Document info' 라는 일반 문구로 떨어졌다(2026-08-06 실측).
 *
 *   게다가 한국어 카탈로그일 때는 라벨이 '문서'라서 `document` 를 아예 안 봤다 —
 *   **한국어 화면에서 영어 문서를 열면 제목이 영영 안 뜬다.**
 *   라벨과 키는 다른 것이다. 여기서는 키만 본다.
 *
 * ★ 언어와 무관하게 넷 다 본다. 남이 만든 문서가 어느 관례를 따를지 알 수 없다.
 */
const TITLE_KEYS = ['title', 'document', '문서', '제목'];

function summaryText(fm: Record<string, unknown>): string {
    const byLower = new Map(Object.keys(fm).map((k) => [k.toLowerCase(), k]));
    for (const key of TITLE_KEYS) {
        const actual = byLower.get(key);
        if (actual === undefined) continue;
        const v = fm[actual];
        // ★ 값이 비어 있으면 다음 후보로 넘어간다. 빈 제목은 제목이 아니다.
        if (v !== null && v !== undefined && String(v).trim() !== '') return String(v);
    }
    return t.frontmatter.info;
}

/** 접이식 표를 만든다. 값은 전부 textContent 로 넣는다 — HTML 을 만들지 않는다. */
export function renderFrontmatter(fm: Record<string, unknown>): HTMLElement {
    const details = document.createElement('details');
    details.className = 'md-frontmatter';

    const summary = document.createElement('summary');
    summary.textContent = summaryText(fm);
    details.appendChild(summary);

    const table = document.createElement('table');
    for (const [k, v] of Object.entries(fm)) {
        const tr = document.createElement('tr');
        const th = document.createElement('th');
        th.textContent = k;
        const td = document.createElement('td');
        td.textContent = Array.isArray(v) ? v.join(', ') : String(v ?? '');
        tr.append(th, td);
        table.appendChild(tr);
    }
    details.appendChild(table);
    return details;
}
