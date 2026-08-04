import type MarkdownIt from 'markdown-it';
import type Token from 'markdown-it/lib/token.mjs';
import { sanitize } from './sanitize';
import { liftTaskCheckedState, postProcessSection } from './post-process';
import { record } from '../utils/perf';

/** 청크 하나에 들어갈 최상위 토큰 수. ★ 기기 실측 후 조정할 값이다(12장). */
export const TOKENS_PER_CHUNK = 600;

/**
 * 토큰 배열을 nesting 균형이 맞는 지점에서만 자른다.
 * depth 가 0인 지점 = 최상위 블록 경계이므로 여기서 잘라야 태그가 안 깨진다.
 */
export function sliceTokens(tokens: Token[], perChunk = TOKENS_PER_CHUNK): Array<[number, number]> {
    const ranges: Array<[number, number]> = [];
    let start = 0;
    let depth = 0;
    for (let i = 0; i < tokens.length; i++) {
        depth += tokens[i].nesting;
        if (depth === 0 && i - start + 1 >= perChunk) {
            ranges.push([start, i + 1]);
            start = i + 1;
        }
    }
    if (start < tokens.length) ranges.push([start, tokens.length]);
    return ranges;
}

/** 다음 프레임까지 양보. 화면이 꺼지면 rAF 가 멈추므로 setTimeout 폴백을 함께 둔다. */
function yieldToBrowser(): Promise<void> {
    return new Promise((resolve) => {
        let done = false;
        const finish = () => {
            if (!done) {
                done = true;
                resolve();
            }
        };
        requestAnimationFrame(finish);
        setTimeout(finish, 32);
    });
}

export interface Heading {
    level: number;
    text: string;
    id: string;
    /** 소스의 시작 줄 번호. 검색 결과에서 청크를 찾을 때 쓴다. */
    line: number;
}

export interface RenderHandle {
    headings: Heading[];
    /** 전체 렌더가 끝나면 resolve. 취소되면 reject 하지 않고 그냥 resolve 한다. */
    complete: Promise<void>;
    /** 목차/검색 점프용 — 남은 청크를 즉시 전부 붙인다. */
    renderRest(): Promise<void>;
    cancel(): void;
}

/**
 * 문서를 한 번만 파싱하고 토큰 슬라이스를 프레임마다 하나씩 DOM 에 붙인다.
 * 첫 청크는 양보 없이 즉시 붙여서 첫 화면을 빨리 띄운다.
 *
 * ★ 소스 텍스트를 잘라 청크마다 md.render() 를 부르지 마라. 각주 정의와 참조 링크가
 *   다른 청크에 있으면 연결이 끊긴다. markdown-it 은 그 정의들을 env 에 모으므로
 *   문서를 한 번에 파싱해야 한다.
 */
export function renderProgressive(
    md: MarkdownIt,
    source: string,
    container: HTMLElement,
): RenderHandle {
    const env: Record<string, unknown> = {};
    // ★ 전체 1회 파싱 — env(각주·참조 정의)를 완성시킨다
    const tokens = md.parse(source, env);
    const ranges = sliceTokens(tokens);

    container.replaceChildren();

    let cancelled = false;
    let next = 1; // 0번은 아래에서 동기로 붙인다

    /**
     * 청크 하나의 최장 처리 시간 (12-1절 #6, 목표 50ms / 상한 100ms).
     * ★ 이 값이 상한을 넘으면 TOKENS_PER_CHUNK 를 줄여라 — 스크롤이 끊긴다.
     *   매 청크마다 기록하면 링버퍼가 100개짜리라 다른 항목을 밀어낸다. 최대값만 남긴다.
     */
    let maxChunkMs = 0;

    const renderRange = (index: number): HTMLElement => {
        const t0 = performance.now();
        const [a, b] = ranges[index];
        const raw = md.renderer.render(tokens.slice(a, b), md.options, env);
        const section = document.createElement('section');
        section.className = 'md-chunk';
        if (index > 0) {
            // 화면 밖 청크는 레이아웃을 건너뛴다.
            // 이게 2^25 클램프와 레이아웃 비용을 동시에 줄인다.
            section.style.contentVisibility = 'auto';
            section.style.containIntrinsicSize = 'auto 1500px';
        }
        section.innerHTML = sanitize(liftTaskCheckedState(raw));
        postProcessSection(section);
        maxChunkMs = Math.max(maxChunkMs, performance.now() - t0);
        return section;
    };

    container.appendChild(renderRange(0));

    let resolveComplete!: () => void;
    const complete = new Promise<void>((r) => {
        resolveComplete = r;
    });

    const loop = async () => {
        while (next < ranges.length) {
            if (cancelled) break;
            await yieldToBrowser();
            // ★★ await 뒤에 조건을 **다시** 본다. 기다리는 동안 renderRest() 가
            //   남은 청크를 전부 붙여 next 를 끝까지 올려놨을 수 있다.
            //   이 검사를 빼면 ranges[next] 가 undefined 가 되어 여기서 터지고
            //   (TypeError: undefined is not iterable) 렌더가 조용히 멈춘다.
            //   실제 경로: 큰 문서를 열자마자 목차·검색을 누르면 그대로 밟는다.
            if (cancelled || next >= ranges.length) break;
            container.appendChild(renderRange(next));
            next++;
        }
        if (maxChunkMs > 0) record('doc:chunk-max', maxChunkMs);
        resolveComplete();
    };
    void loop();

    return {
        headings: extractHeadings(tokens),
        complete,
        async renderRest() {
            // 양보 없이 붙인다. 목차 점프처럼 '지금 당장 필요한' 경우에만 쓴다.
            while (next < ranges.length && !cancelled) {
                container.appendChild(renderRange(next));
                next++;
            }
        },
        cancel() {
            cancelled = true;
        },
    };
}

/**
 * 서식 없이 원문만 보여주는 경로(4MB 초과 문서).
 * ★ 파싱만 건너뛸 뿐 2^25 클램프는 똑같이 받으므로 여기서도 청크로 나눈다.
 */
export function renderPlainProgressive(
    source: string,
    container: HTMLElement,
    linesPerChunk = 2000,
): RenderHandle {
    const lines = source.split('\n');
    container.replaceChildren();

    let cancelled = false;
    let next = 0;
    const total = Math.ceil(lines.length / linesPerChunk);

    const append = (i: number) => {
        const pre = document.createElement('pre');
        pre.className = 'md-chunk md-plain';
        if (i > 0) {
            pre.style.contentVisibility = 'auto';
            pre.style.containIntrinsicSize = 'auto 1500px';
        }
        // textContent 로 넣으므로 이스케이프가 자동이다. innerHTML 을 쓰지 마라.
        pre.textContent = lines.slice(i * linesPerChunk, (i + 1) * linesPerChunk).join('\n');
        container.appendChild(pre);
    };

    append(0);
    next = 1;

    let resolveComplete!: () => void;
    const complete = new Promise<void>((r) => {
        resolveComplete = r;
    });

    void (async () => {
        while (next < total && !cancelled) {
            await yieldToBrowser();
            // ★ 위 renderProgressive 와 같은 이유로 await 뒤에 조건을 다시 본다.
            if (cancelled || next >= total) break;
            append(next);
            next++;
        }
        resolveComplete();
    })();

    return {
        headings: [],
        complete,
        async renderRest() {
            while (next < total && !cancelled) {
                append(next);
                next++;
            }
        },
        cancel() {
            cancelled = true;
        },
    };
}

/** 목차용 헤딩 추출 — markdown-it-table-of-contents 대신 토큰에서 직접 뽑는다. */
export function extractHeadings(tokens: Token[]): Heading[] {
    const out: Heading[] = [];
    for (let i = 0; i < tokens.length; i++) {
        const t = tokens[i];
        if (t.type !== 'heading_open') continue;
        const inline = tokens[i + 1];
        out.push({
            level: Number(t.tag.slice(1)), // h2 -> 2
            text: inline?.content ?? '',
            id: t.attrGet('id') ?? '', // markdown-it-anchor 가 붙여준 id
            line: t.map ? t.map[0] : 0,
        });
    }
    return out;
}
