/**
 * 문서 안의 상대 경로 그림 → marklet-local:// 주소.
 *
 * 문서가 `![](./img/a.png)` 처럼 가리킨 그림을 문서 폴더 기준으로 풀어 낸다.
 * 메인(src-tauri/src/main.rs 의 image_protocol)이 그 스킴으로 **그림 확장자만** 내준다.
 *
 * 푸는 규칙은 Rust 의 links.rs `resolve_doc_link` 와 같다 — 어긋나면 한쪽이 거절한다.
 *  · 퍼센트를 푼 **뒤에** 조각을 나눈다. `%2F` · `%5C` 로 숨긴 구분자도, `%2e%2e` 도 걸린다.
 *  · `..` 는 루트(드라이브 · `\\서버\공유`) 위로 못 올라간다.
 *  · 조각에 `:` 가 있으면 거절한다(드라이브 문자 · 대체 데이터 스트림).
 *
 * 문서가 네트워크 공유(`\\서버\공유\폴더`)에 있으면 주소의 경로도 `//서버/공유/폴더/…` 로 앞의 두 슬래시를 지킨다.
 * 메인은 그 꼴을 UNC 경로로 읽고, 지금 열려 있는 문서와 같은 서버·공유일 때만 내준다.
 * (URL 파서에 맡기지 않는다 — 폴더 이름의 `#` · `?` · `%` 와 서버 이름의 변환이 경로를 바꿔 놓는다.)
 *
 * @returns 바꿀 필요가 없으면 null (원격 · data: · 절대 경로가 이미 있는 것)
 */
export function localImageUrl(src: string, docDir: string): string | null {
    const raw = src.trim();
    if (!raw || !docDir) return null;
    // 스킴이 있으면(http · https · data · marklet-local · C: …) 우리 몫이 아니다.
    if (/^[a-z][a-z0-9+.-]*:/i.test(raw)) return null;
    // 루트 기준(/x.png) · 네트워크 경로(//호스트 · \\호스트)는 문서 폴더의 파일이 아니다.
    if (/^[\\/]/.test(raw)) return null;

    const dir = splitRoot(docDir);
    if (!dir) return null;

    // 앵커 · 쿼리를 떼고 퍼센트를 푼다. 푼 뒤에 다시 본다 — `%2F%2F호스트` 로 숨긴 것도 걸린다.
    let rel: string;
    try {
        rel = decodeURIComponent(raw.split('#')[0].split('?')[0]);
    } catch {
        return null;
    }
    if (!rel || /^[\\/]/.test(rel)) return null;

    const segs = [...dir.segs];
    for (const s of rel.split(/[\\/]/)) {
        if (s === '' || s === '.') continue;
        if (s === '..') {
            segs.pop(); // 비어 있으면(루트) 그대로
            continue;
        }
        if (s.includes(':')) return null;
        segs.push(s);
    }
    return `marklet-local://f/${encodeURIComponent([dir.root, ...segs].join('/'))}`;
}

/**
 * 문서 폴더를 루트(`C:` · `//서버/공유`)와 그 아래 조각으로 가른다. 절대 경로가 아니면 null.
 * `\\?\UNC\서버\공유` · `\\?\C:` (긴 경로 꼴)은 접두사를 벗겨 같은 것으로 본다.
 */
function splitRoot(dir: string): { root: string; segs: string[] } | null {
    const d = dir
        .replace(/\//g, '\\')
        .replace(/^\\\\\?\\UNC\\/i, '\\\\')
        .replace(/^\\\\\?\\/, '');
    const parts = (s: string): string[] => s.split('\\').filter((p) => p !== '' && p !== '.');

    const drive = /^([A-Za-z]:)(?:\\(.*))?$/.exec(d);
    if (drive) return { root: drive[1], segs: parts(drive[2] ?? '') };

    const unc = /^\\\\([^\\]+)\\([^\\]+)(?:\\(.*))?$/.exec(d);
    if (unc) return { root: `//${unc[1]}/${unc[2]}`, segs: parts(unc[3] ?? '') };

    return null;
}
