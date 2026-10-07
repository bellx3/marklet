/**
 * 문서 안의 상대 경로 그림 → marklet-local:// 주소.
 *
 * 문서가 `![](./img/a.png)` 처럼 가리킨 그림을 문서 폴더 기준으로 풀어 낸다.
 * 메인(desktop/main.cjs)이 그 스킴으로 **그림 확장자만** 내준다.
 *
 * @returns 바꿀 필요가 없으면 null (원격 · data: · 절대 경로가 이미 있는 것)
 */
export function localImageUrl(src: string, docDir: string): string | null {
    if (!src || !docDir) return null;
    // 스킴이 있으면(http · https · data · marklet-local …) 우리 몫이 아니다.
    if (/^[a-z][a-z0-9+.-]*:/i.test(src)) return null;
    // 루트 기준(/x.png)은 문서 폴더가 아니라 앱 주소를 가리켜 의미가 없다.
    if (src.startsWith('/') || src.startsWith('//')) return null;

    // 윈도우 경로(D:\a\b)를 URL 로 만든다. 역슬래시를 슬래시로, 드라이브 문자 앞에 슬래시를 붙인다.
    const base = `file:///${docDir.replace(/\\/g, '/').replace(/^\/+/, '')}/`;
    let resolved: URL;
    try {
        resolved = new URL(src, base);
    } catch {
        return null;
    }
    // new URL 이 '..' 를 접어 준다. pathname 은 '/D:/docs/img/a.png' 꼴이다.
    const abs = decodeURIComponent(resolved.pathname);
    return `marklet-local://f/${encodeURIComponent(abs.replace(/^\//, ''))}`;
}
