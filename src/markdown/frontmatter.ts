import yaml from 'js-yaml';
import { t } from '../i18n';

export interface ParsedDocument {
    frontmatter: Record<string, unknown> | null;
    body: string;
}

// ﻿ = BOM. 윈도우에서 만든 파일에 붙어 있으면 매치가 실패하므로 함께 처리한다.
const FRONTMATTER_RE = /^﻿?---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

/** 정상 frontmatter 는 1KB 를 넘지 않는다. 넘으면 파싱하지 않는다(YAML 폭탄 방어). */
const MAX_FRONTMATTER_BYTES = 64 * 1024;

export function parseDocument(source: string): ParsedDocument {
    const m = FRONTMATTER_RE.exec(source);
    if (!m) return { frontmatter: null, body: source };

    if (m[1].length > MAX_FRONTMATTER_BYTES) {
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
