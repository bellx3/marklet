import { describe, it, expect, beforeEach } from 'vitest';
import {
    pushLayer,
    removeLayer,
    hasLayer,
    __resetRouterForTest,
    __pressBackForTest,
} from './router';

/**
 * 11-2절 #8.
 *
 * 회귀: removeLayer 호출을 hide 뒤로 미루면 "닫는 즉시 사라진다" 테스트가 실패하는 것을 확인함.
 *   픽셀오아시스 커밋 13195dc — 애니메이션이 끝난 뒤에 레이어를 떼서
 *   그 사이의 뒤로가기 한 번을 이미 화면에 없는 오버레이가 먹었다.
 */

beforeEach(() => __resetRouterForTest());

describe('레이어 스택', () => {
    it('위에 얹은 것부터 처리한다', async () => {
        const order: string[] = [];
        pushLayer('아래', () => {
            order.push('아래');
            return true;
        });
        pushLayer('위', () => {
            order.push('위');
            return true;
        });

        await __pressBackForTest();
        expect(order).toEqual(['위']);

        removeLayer('위');
        await __pressBackForTest();
        expect(order).toEqual(['위', '아래']);
    });

    it('false 를 돌려주면 아래로 내려간다', async () => {
        const seen: string[] = [];
        pushLayer('아래', () => {
            seen.push('아래');
            return true;
        });
        pushLayer('위', () => {
            seen.push('위');
            return false; // 내가 처리하지 않았다
        });

        await __pressBackForTest();
        expect(seen).toEqual(['위', '아래']);
    });

    it('전부 false 면 아무도 처리하지 않는다 (그때 앱이 종료된다)', async () => {
        pushLayer('a', () => false);
        pushLayer('b', () => false);
        expect(await __pressBackForTest()).toBeNull();
    });

    it('★ 닫는 즉시 레이어가 사라져 다음 뒤로가기가 아래로 간다', async () => {
        const hits: string[] = [];
        pushLayer('viewer', () => {
            hits.push('viewer');
            return true;
        });
        // 오버레이는 '닫기 시작하는 순간' 동기적으로 자기 레이어를 뗀다.
        pushLayer('sheet', () => {
            hits.push('sheet');
            removeLayer('sheet');
            return true;
        });

        await __pressBackForTest();
        await __pressBackForTest();
        expect(hits).toEqual(['sheet', 'viewer']);
    });

    it('같은 이름을 두 번 얹어도 하나만 남는다', async () => {
        let count = 0;
        const handler = () => {
            count++;
            return true;
        };
        pushLayer('dup', handler);
        pushLayer('dup', handler);
        await __pressBackForTest();
        removeLayer('dup');
        expect(hasLayer('dup')).toBe(false);
        expect(count).toBe(1);
    });

    it('비동기 핸들러를 기다린다 (미저장 확인 다이얼로그 경로)', async () => {
        const seen: string[] = [];
        pushLayer('아래', () => {
            seen.push('아래');
            return true;
        });
        pushLayer('editor', async () => {
            await Promise.resolve();
            seen.push('editor');
            return true; // 확인창을 띄웠으니 '내가 처리했다'
        });

        await __pressBackForTest();
        expect(seen).toEqual(['editor']);
    });

    it('없는 레이어를 떼도 터지지 않는다', () => {
        expect(() => removeLayer('없음')).not.toThrow();
    });
});

/**
 * ★★★ 2026-08-06. **다이얼로그가 떠 있는 동안 뒤로가기가 죽어 있었다.**
 *
 *   `busy` 는 "연타로 두 개가 한꺼번에 닫히는 것"을 막으려고 둔 잠금인데,
 *   핸들러가 **사용자 입력을 기다리면** 그 시간 내내 잠긴 채였다:
 *       편집 중 뒤로가기 → "저장하지 않은 편집이 있습니다" 확인 상자
 *       → 그 상자를 뒤로가기로 닫으려 하면 아무 반응이 없다
 *   안드로이드에서 뒤로가기가 안 먹는 것은 사용자가 앱을 의심하는 신호다.
 *
 *   ★★ 그리고 이 잠금은 **네이티브 리스너 안에만** 있었다. 브라우저 폴백(Esc)도
 *     테스트 도우미도 각자 for 문을 들고 있어서, 문제를 만드는 코드가
 *     개발 중에도 테스트에서도 한 번도 돌지 않았다. 셋을 한 함수로 합쳤다.
 */
describe('★★ 연타 잠금이 뒤로가기를 죽이지 않는다', () => {
    it('★ 핸들러가 다이얼로그를 띄우면 다음 뒤로가기가 그 다이얼로그로 간다', async () => {
        let 상자닫힘 = false;
        let 편집기닫힘 = false;
        let 사용자대답: (v: boolean) => void = () => {};

        pushLayer('editor', async () => {
            // 확인 상자를 띄운다 — 실제 Overlay.show() 가 하는 일과 같다.
            const 대답 = new Promise<boolean>((r) => {
                사용자대답 = r;
            });
            pushLayer('dialog', () => {
                상자닫힘 = true;
                removeLayer('dialog');
                사용자대답(false); // 뒤로가기 = 취소
                return true;
            });
            if (await 대답) 편집기닫힘 = true;
            return true;
        });

        // 첫 번째 뒤로가기 — 확인 상자가 뜬다. (핸들러는 아직 안 끝났다)
        const 첫번째 = __pressBackForTest();
        await Promise.resolve();
        expect(hasLayer('dialog'), '확인 상자가 안 떴다').toBe(true);

        // 두 번째 뒤로가기 — 이게 먹어야 한다.
        expect(await __pressBackForTest(), '잠겨서 아무도 처리하지 못했다').toBe('dialog');
        expect(상자닫힘).toBe(true);

        await 첫번째;
        expect(편집기닫힘, '취소했는데 편집기가 닫혔다').toBe(false);
    });

    it('연타는 여전히 막는다 (핸들러가 새 레이어를 안 얹을 때)', async () => {
        const 닫힌것: string[] = [];
        let 놓아주기: () => void = () => {};
        const 느리게 = new Promise<void>((r) => {
            놓아주기 = r;
        });

        pushLayer('아래', () => {
            닫힌것.push('아래');
            removeLayer('아래');
            return true;
        });
        pushLayer('위', async () => {
            await 느리게; // 저장·정리처럼 시간이 걸리는 일
            닫힌것.push('위');
            removeLayer('위');
            return true;
        });

        const 첫번째 = __pressBackForTest();
        await Promise.resolve();

        // 아직 '위' 가 처리 중이다 — 두 번째 누름이 '아래' 까지 닫으면 안 된다.
        expect(await __pressBackForTest()).toBeNull();
        expect(닫힌것).toEqual([]);

        놓아주기();
        await 첫번째;
        expect(닫힌것).toEqual(['위']);
        expect(hasLayer('아래'), '아래까지 같이 닫혔다').toBe(true);
    });

    it('처리가 끝나면 잠금이 풀린다', async () => {
        pushLayer('가', () => {
            removeLayer('가');
            return true;
        });
        expect(await __pressBackForTest()).toBe('가');

        pushLayer('나', () => {
            removeLayer('나');
            return true;
        });
        expect(await __pressBackForTest(), '앞선 누름이 잠금을 안 놓았다').toBe('나');
    });
});
