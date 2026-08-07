import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it, expect } from 'vitest';

/**
 * 스토어에 보내는 글자의 길이 (03_출시_절차서).
 *
 * ★★★ 왜 여기서 재는가. 플레이는 **커밋할 때** 길이를 본다 — 즉 AAB 를 다 만들고
 *   업로드까지 끝낸 다음에 403 으로 되돌린다(2026-08-07, 1.0.6 을 올리다 두 번 겪었다):
 *
 *       "The release created has notes in language en-US with length 551,
 *        which is too long (max: 500)."
 *
 *   한 번에 47초씩 날아갔고, 길이를 알려 주는 곳이 그 오류 메시지밖에 없어서
 *   줄이고 다시 빌드하기를 반복했다. **글자를 세는 데에 빌드가 필요할 이유가 없다.**
 *
 * ★ 한국어는 한 글자가 1 로 세어진다(UTF-16 코드 단위). 이모지·기호를 쓰면 2 가 될 수
 *   있으므로 `length` 로 재는 것이 플레이가 재는 것과 같다.
 *
 * ★ 마지막 줄바꿈은 빼고 센다 — 플레이에 보낼 때 trimEnd 된다(promote.cjs).
 */

const root = resolve(__dirname, '..');

/** 파일을 읽어 플레이에 실제로 보내지는 모양(CR 제거 · 끝 줄바꿈 제거)으로 돌려준다 */
function asSent(path: string): string {
    return readFileSync(resolve(root, path), 'utf8').replace(/\r/g, '').replace(/\n+$/, '');
}

/** 플레이 콘솔의 상한 (2026-08-07 확인) */
const LIMIT = {
    releaseNotes: 500,
    title: 30,
    shortDescription: 80,
    fullDescription: 4000,
};

describe('릴리스 노트 — 언어마다 500자', () => {
    const dir = resolve(root, 'android/app/src/main/play/release-notes');
    const langs = readdirSync(dir);

    it('언어 폴더가 있다 — 없으면 아래 검사가 통째로 공치다', () => {
        expect(langs.length).toBeGreaterThan(0);
    });

    it.each(langs)('%s 가 500자 이하다', (lang) => {
        const text = asSent(`android/app/src/main/play/release-notes/${lang}/default.txt`);
        // ★ 실패 메시지에 몇 자 넘었는지 적는다. 그게 없으면 또 줄여 보고 다시 재게 된다.
        expect(
            text.length,
            `${lang}: ${text.length}자 — ${text.length - LIMIT.releaseNotes}자 초과`,
        ).toBeLessThanOrEqual(LIMIT.releaseNotes);
    });

    it.each(langs)('%s 가 비어 있지 않다', (lang) => {
        expect(
            asSent(`android/app/src/main/play/release-notes/${lang}/default.txt`).length,
        ).toBeGreaterThan(0);
    });
});

describe('스토어 등록정보 길이', () => {
    /* 없는 파일은 건너뛴다 — 언어를 나중에 더할 수 있다. */
    const cases: [string, number][] = [
        ['store/ko-KR/title.txt', LIMIT.title],
        ['store/ko-KR/short-description.txt', LIMIT.shortDescription],
        ['store/ko-KR/full-description.txt', LIMIT.fullDescription],
        ['store/en-US/full-description.txt', LIMIT.fullDescription],
    ];

    it.each(cases)('%s 가 상한 안에 있다', (path, limit) => {
        if (!existsSync(resolve(root, path))) return;
        const text = asSent(path);
        expect(text.length, `${path}: ${text.length}자 (상한 ${limit})`).toBeLessThanOrEqual(limit);
    });
});
