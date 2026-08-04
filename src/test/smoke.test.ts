import { describe, it, expect } from 'vitest';

/**
 * 테스트 하네스 자체를 검증한다. 앱 코드를 검증하지 않는다.
 *
 * 왜 있는가:
 *  1) `npm test` 가 "No test files found" 로 exit 1 이 되는 것을 막는다.
 *     `--passWithNoTests` 로 덮으면 나중에 include 글롭이 깨져 테스트가 통째로
 *     안 돌아도 초록불이 된다(15장 38번과 같은 실패 모드다).
 *  2) vitest + jsdom + setup.ts 조합이 실제로 동작하는지 D1 에서 확인한다.
 *     02_기술_설계서.md 14장이 미검증으로 남겨 둔 항목이다.
 *
 * ★ 실제 테스트가 생기면 이 파일을 지워도 된다. 그때는 1) 이 저절로 해결된다.
 */
describe('테스트 하네스', () => {
    it('jsdom 환경이 떠 있다', () => {
        expect(typeof document).toBe('object');
        expect(document.createElement('div')).toBeInstanceOf(HTMLElement);
    });

    it('setup.ts 의 beforeEach 가 body 를 비운다', () => {
        expect(document.body.innerHTML).toBe('');
    });

    it('requestAnimationFrame 이 채워져 있다', async () => {
        expect(typeof requestAnimationFrame).toBe('function');
        const t = await new Promise<number>((resolve) => requestAnimationFrame(resolve));
        expect(typeof t).toBe('number');
    });
});
