import type MarkdownIt from 'markdown-it';
import type Token from 'markdown-it/lib/token.mjs';
import { sanitize } from './sanitize';
import { liftTaskCheckedState, postProcessSection } from './post-process';
import { record } from '../utils/perf';

/**
 * 청크 하나에 들어갈 최상위 토큰 수.
 *
 * ★★ 600 → 250 (2026-08-05 에뮬레이터 실측, 밀도 420 / 1080x2400).
 *   600KB 문서를 배경 렌더하는 ~11초 동안 메인 스레드가 100ms 넘게 막힌 시간의 합:
 *     600토큰 → 2361 · 1905 · 2380ms   (평균 2215)
 *     250토큰 →  812 ·  698 ·  431 · 1362ms (평균 826)
 *   **평균 2.7배 차이다.** 편차가 크니 한 번 재고 판단하지 마라 —
 *   위 숫자도 각각 세 번 이상 돌린 것이다.
 *   그 시간 동안 스크롤이 그대로 멎으므로 사용자가 바로 느낀다.
 *
 * ★ 공짜가 아니다. 청크가 늘면 <section> 도 늘고 총 렌더 시간이 길어진다.
 *     600KB : 전체 렌더 7.4초 → 7.9초 (+6%)
 *     2.5MB : 전체 렌더 25초 → 30초 (+21%), 검색 9.4초 → 12.3초 (+31%)
 *   그래도 250 을 고른 이유 — **버벅임은 읽는 내내 느끼고, 총 렌더 시간은
 *   검색·목차를 누를 때만 드러난다.** 그리고 2.5MB 는 확인 다이얼로그 뒤에 있는
 *   드문 경우지만 600KB 는 흔한 크기다.
 *
 * ★ 400 도 재 봤는데 600KB 에서 2381ms 로 600 과 차이가 없었다. 효과가 선형이 아니다.
 *
 * ────────────────────────────────────────────────────────────────
 * ★★★ 실기기 재측정 (2026-08-07, LG Q7 / Snapdragon 632 / 안드로이드 9 / 600KB).
 *   위 숫자는 전부 **에뮬레이터**에서 잰 것이다. 진짜 저사양 기기에서 다시 쟀다.
 *   각 값 3회, 아래는 그 범위다.
 *
 *     토큰   멈춤(chunk-stall-max)   전체 렌더(complete)
 *     150        111 ~ 142ms            1484 ~ 1808ms
 *     250        136 ~ 142ms            1106 ~ 1212ms   ← 지금 값
 *     400        168 ~ 220ms            1016 ~ 1271ms
 *
 *   ★★ **250 을 바꿀 이유가 없다.** 400 보다 멈춤이 30% 짧고, 150 보다 전체 렌더가
 *     30% 빠르다. 150 은 멈춤을 거의 못 줄이면서 전체만 크게 늘린다.
 *
 *   ★ 잴 때 주의 — 빌드·설치 직후 첫 회는 기기가 더워 값이 부풀려진다.
 *     같은 250 인데 161ms 로 찍힌 적이 있다(30초 쉬고 다시 재니 138ms).
 *     한 번 재고 판단하지 마라. 이 표도 값마다 세 번씩 돌린 것이다.
 */
export const TOKENS_PER_CHUNK = 250;

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

    /*
     * ★★★ 토큰이 하나도 없어도 **범위 하나는 돌려준다** (2026-08-06).
     *
     *   빈 배열을 돌려주면 renderProgressive 의 `renderRange(0)` 이
     *   `ranges[0]` 을 구조 분해하다 터진다:
     *       TypeError: undefined is not iterable
     *
     *   그리고 그런 문서는 **드물지 않다** — 0바이트 파일, 공백만 있는 파일,
     *   frontmatter 만 있는 파일(옵시디언 템플릿·메타데이터 노트)이 전부 여기다.
     *   뷰어에 try/catch 폴백이 있어 화면이 죽지는 않았지만, 그 폴백은
     *   **예상 못 한 렌더 실패**를 위한 그물이다. 정상 입력이 거기로 떨어지면
     *   "렌더 실패" 가 로그에 찍히고, 실제로는 원문 보기 경로로 그려진다.
     */
    if (ranges.length === 0) ranges.push([0, 0]);
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
     *
     * ★ 상한을 넘거든 **이 값이 토큰 수를 따라 움직이는지부터 보라.**
     *   저사양 기기에서는 안 움직인다 — 토큰을 절반으로 줄여도 139ms 그대로였다
     *   (2026-08-07 LG Q7). 그때 비용은 청크당 고정 비용이지 토큰 수가 아니다.
     *   자세한 것은 아래 maxStallMs 주석에 있다.
     *
     * ★ 매 청크마다 기록하면 링버퍼가 100개짜리라 다른 항목을 밀어낸다. 최대값만 남긴다.
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

    /**
     * 청크 하나가 **화면을 실제로 붙잡은 시간**의 최대값.
     *
     * ★★ maxChunkMs 와 다르다. 그쪽은 renderRange() 안의 JS 만 잰다 —
     *   innerHTML 을 넣는 것까지는 재지만 그 뒤에 브라우저가 하는
     *   스타일 계산·레이아웃·페인트는 빠진다. 그래서 실제로 화면이 215ms 멎을 때도
     *   83.9ms 로 찍혔다(2026-08-05 2.5MB 실측). 상한이 100ms 인데
     *   **넘는 일이 영영 없으니 "줄여라"는 지침이 발동하지 않았다.**
     *
     *   여기서는 '붙이기 시작'부터 '브라우저가 다음 프레임을 준 순간'까지를 잰다.
     *   그게 사용자가 스크롤을 못 하는 시간이다. 이미 있는 yield 를 가로질러 재므로
     *   추가 비용은 없다.
     *
     * ★★★ **0번 청크도 반드시 잰다** (2026-08-07 LG Q7 실측으로 발견).
     *   예전에는 appendedAt 을 루프 안에서만 세웠다. 그래서
     *     ① 동기로 붙이는 0번 청크의 멈춤이 **한 번도 안 잡혔다** — 문서를 여는 순간
     *        사용자가 제일 크게 느끼는 그 멈춤이다
     *     ② 청크가 하나뿐인 문서는 루프가 아예 안 돌아 **기록 자체가 없었다**
     *   실측: 600KB 를 문단 두 개로만 담은 문서(줄바꿈 없는 긴 글)는 토큰이 6개라
     *   청크가 1개가 된다. 화면은 **729ms** 멎었는데 진단에는 chunk-max 50.3ms 만 남고
     *   chunk-stall-max 는 없었다. 차이는 브라우저의 스타일·레이아웃·페인트다 —
     *   이 지표가 존재하는 이유가 정확히 그것인데, 가장 심한 경우에 침묵했다.
     *
     *   ★ 그리고 이 경우는 TOKENS_PER_CHUNK 를 줄여도 소용없다. 토큰이 6개뿐이라
     *     더 쪼갤 자리가 없다. 그래서 숫자를 보고 상수를 만지기 전에 청크 수부터 봐야 한다.
     */
    let maxStallMs = 0;
    let appendedAt = performance.now();

    const loop = async () => {
        while (next < ranges.length) {
            if (cancelled) break;
            await yieldToBrowser();
            if (appendedAt > 0) {
                maxStallMs = Math.max(maxStallMs, performance.now() - appendedAt);
                appendedAt = 0;
            }
            // ★★ await 뒤에 조건을 **다시** 본다. 기다리는 동안 renderRest() 가
            //   남은 청크를 전부 붙여 next 를 끝까지 올려놨을 수 있다.
            //   이 검사를 빼면 ranges[next] 가 undefined 가 되어 여기서 터지고
            //   (TypeError: undefined is not iterable) 렌더가 조용히 멈춘다.
            //   실제 경로: 큰 문서를 열자마자 목차·검색을 누르면 그대로 밟는다.
            if (cancelled || next >= ranges.length) break;
            appendedAt = performance.now();
            container.appendChild(renderRange(next));
            next++;
        }
        /*
         * ★ 아직 재지 못한 붙이기가 남아 있으면(=청크가 하나뿐이라 루프가 안 돌았거나
         *   마지막 청크였다) 프레임 하나를 더 기다려 그 멈춤까지 담는다.
         */
        if (!cancelled && appendedAt > 0) {
            await yieldToBrowser();
            maxStallMs = Math.max(maxStallMs, performance.now() - appendedAt);
            appendedAt = 0;
        }
        if (maxChunkMs > 0) record('doc:chunk-max', maxChunkMs);
        /*
         * ★ 이쪽이 사용자가 느끼는 값이다 — 화면이 실제로 멎어 있는 시간.
         *
         * ★★★ **"100ms 를 넘으면 TOKENS_PER_CHUNK 를 줄여라" 라고 적혀 있었는데,
         *   그대로 하면 더 나빠진다.** (2026-08-07 LG Q7 실측)
         *
         *   그 기기에서 이 값은 140ms 안팎으로 상한을 넘는다. 규칙대로 250→150 으로
         *   줄여 봤더니
         *     멈춤   137 → 127ms  (8% 개선)
         *     전체   1134 → 1667ms (47% 악화)
         *   같은 실측에서 chunk-max 는 **거의 안 줄었다**(139 → 139ms). 즉 저사양에서
         *   청크 하나의 비용은 토큰 수가 아니라 **고정 비용**이 지배한다 —
         *   sanitize(DOMPurify) · innerHTML 파싱 · postProcess · 스타일 재계산.
         *   토큰을 줄이면 청크 수만 늘어 그 고정 비용을 더 자주 치른다.
         *
         *   그러니 이 값이 상한을 넘거든 **청크를 쪼개기 전에 청크 하나의 고정 비용부터
         *   재라.** 숫자 없이 상수만 만지면 총 렌더 시간을 반쯤 더 쓰고 끝난다.
         *   (세 값 비교표는 TOKENS_PER_CHUNK 주석에 있다.)
         */
        if (maxStallMs > 0) record('doc:chunk-stall-max', maxStallMs);
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
