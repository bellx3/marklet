type Kind = 'info' | 'success' | 'error';

const DURATION: Record<Kind, number> = { info: 2200, success: 2200, error: 4000 };

let timer: ReturnType<typeof setTimeout> | null = null;

function show(kind: Kind, message: string): void {
    const root = document.querySelector<HTMLElement>('#toast-root');
    if (!root) return;

    // ★ 이전 토스트의 타이머를 반드시 취소한다. 안 하면 새 토스트가 옛 타이머에 지워진다.
    if (timer !== null) clearTimeout(timer);

    root.className = `toast toast-${kind} is-open`;
    // 오류는 즉시 읽히도록 assertive
    root.setAttribute('role', kind === 'error' ? 'alert' : 'status');
    root.setAttribute('aria-live', kind === 'error' ? 'assertive' : 'polite');
    root.textContent = message;

    timer = setTimeout(() => {
        root.classList.remove('is-open');
        timer = null;
    }, DURATION[kind]);
}

/**
 * ★ 토스트로 끝내도 되는 것과 안 되는 것 (9-7절)
 *
 *   토스트: 저장 성공 · 복사됨 · 취소됨 · 후원 감사 · 설정 변경 · 인코딩 폴백 안내
 *   다이얼로그(출구 버튼 포함): **저장 실패** · 권한 만료 · 파일 없음 ·
 *                              문서 크기 초과 · 텍스트 아님 · 초안 충돌
 *
 *   오른쪽 것들을 토스트로 처리하면 픽셀오아시스 작업 #21(저장 실패 무음)과 같은 사고가 난다.
 */
export const Toast = {
    info: (m: string) => show('info', m),
    success: (m: string) => show('success', m),
    error: (m: string) => show('error', m),
};
