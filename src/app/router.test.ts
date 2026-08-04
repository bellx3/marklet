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
