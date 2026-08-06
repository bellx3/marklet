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

/** 접이식 표를 만든다. 값은 전부 textContent 로 넣는다 — HTML 을 만들지 않는다. */
export function renderFrontmatter(fm: Record<string, unknown>): HTMLElement {
    const details = document.createElement('details');
    details.className = 'md-frontmatter';

    const summary = document.createElement('summary');
    // ★ '문서' 키는 한국어 문서의 관례라 언어와 무관하게 계속 본다. 표시 기본값만 번역한다.
    summary.textContent = String(
        fm.title ?? fm[t.frontmatter.document] ?? fm['문서'] ?? t.frontmatter.info,
    );
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
