/**
 * 안드로이드로 동기화된 웹 자산이 **지금 버전의 것인지** 검사한다.
 *
 * ★★★ 왜 필요한가 (2026-08-07, 실제로 이렇게 나갔다).
 *
 *   `npm run build:aab` 도 `npm run publish:internal` 도 **gradle 만 부른다.**
 *   웹을 다시 만들지 않고 `cap sync` 도 하지 않는다. 그런데 두 가지 버전이
 *   서로 다른 시점에 굳는다:
 *
 *     versionName   ← gradle 이 **빌드할 때** package.json 을 읽는다  (항상 최신)
 *     __APP_VERSION__ ← vite 가 **웹을 만들 때** package.json 을 읽는다 (마지막 build 시점)
 *
 *   그래서 package.json 을 1.0.6 으로 올리고 build:aab 만 돌리면
 *   **versionName 은 1.0.6 인데 설정 화면은 1.0.5 라고 말하는 AAB** 가 나온다.
 *   1.0.6 을 그 상태로 두 트랙에 올렸고, 사장님이 앱에서 보고 찾아내셨다.
 *
 *   버전 표시만의 문제가 아니다 — **마지막 `npm run build` 이후에 고친 웹 코드가
 *   통째로 빠진 AAB** 가 조용히 나간다. 오늘은 운 좋게 버전 한 줄만 어긋났다.
 *
 * ★ 그래서 릴리스 경로에서는 (1) 웹을 다시 만들어 sync 하고 (2) 그러고도 이 검사를 한다.
 *   (1)만 두면 gradlew 를 직접 부르는 사람이 그대로 당한다. (2)만 두면 매번 손으로
 *   다시 만들어야 한다. 둘 다 있어야 한다 — `assert-no-dev-server.cjs` 와 같은 자리다.
 *
 * ★ 표지는 `Marklet <버전>` 이다. 진단 화면의 `` `Marklet ${__APP_VERSION__}` `` 이
 *   번들에서 이 모양으로 접힌다. 버전 문자열만 찾으면 다른 라이브러리의 "1.0.7" 같은
 *   것에 걸려 **틀렸는데 통과할 수 있다**(실제로 mermaid 번들에 1.0.7 이 있다).
 */

const fs = require('fs');
const path = require('path');

const repoRoot = path.resolve(__dirname, '..', '..');
const ASSET_DIR = path.join(repoRoot, 'android', 'app', 'src', 'main', 'assets', 'public', 'assets');

/** 번들에 찍히는 표지. diagnostics.ts 의 `Marklet ${__APP_VERSION__}` 이 접힌 모양. */
const marker = (version) => `Marklet ${version}`;

function assertWebAssetsFresh() {
    const version = require(path.join(repoRoot, 'package.json')).version;

    if (!fs.existsSync(ASSET_DIR)) {
        console.error('❌ 안드로이드로 동기화된 웹 자산이 없습니다.');
        console.error('   npm run build && npx cap sync android 를 먼저 하세요.');
        process.exit(1);
    }

    const bundles = fs.readdirSync(ASSET_DIR).filter((f) => /^main-.*\.js$/.test(f));
    if (bundles.length === 0) {
        console.error('❌ main 번들을 찾지 못했습니다:', ASSET_DIR);
        process.exit(1);
    }

    const text = bundles.map((f) => fs.readFileSync(path.join(ASSET_DIR, f), 'utf8')).join('\n');

    if (text.includes(marker(version))) return;

    /*
     * 여기부터는 실패다. **무엇이 어긋났는지까지 말해 준다** — 그게 없으면
     * "다시 빌드해 보세요" 를 몇 번씩 반복하게 된다(오늘 릴리스 노트 길이가 그랬다).
     */
    const found = [...text.matchAll(/Marklet (\d+\.\d+\.\d+)/g)].map((m) => m[1]);
    const unique = [...new Set(found)];

    console.error('❌ 동기화된 웹 자산이 지금 버전의 것이 아닙니다.');
    console.error(`   package.json : ${version}`);
    console.error(`   번들 안      : ${unique.length ? unique.join(', ') : '(표지를 못 찾음)'}`);
    if (!unique.length) {
        console.error('');
        console.error('   표지 자체를 못 찾았습니다. diagnostics.ts 의');
        console.error('   `Marklet ${__APP_VERSION__}` 가 바뀌었다면 이 검사기도 같이 고치세요.');
    } else {
        console.error('');
        console.error('   이대로 올리면 versionName 은 새 버전인데 설정 화면은 옛 버전을 말합니다.');
        console.error('   그리고 마지막 빌드 이후에 고친 웹 코드가 통째로 빠집니다.');
    }
    console.error('');
    console.error('   고치는 법: npm run build && npx cap sync android');
    process.exit(1);
}

module.exports = { assertWebAssetsFresh };
