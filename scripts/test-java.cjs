#!/usr/bin/env node

/**
 * 순수 자바 단위 테스트를 돌린다 (`npm run test:java`).
 *
 * ★★ 왜 Gradle 을 안 쓰는가.
 *   `./gradlew :app:testDebugUnitTest` 는 이 저장소에서 **동작하지 않는다.**
 *   저장소 경로에 한글이 들어 있어서(D:\dev\코드프로젝트\...) Gradle 이 윈도우에서
 *   쓰는 '클래스패스 jar'(매니페스트에 file: URL 을 적어 넣는 방식)가 깨진다.
 *   컴파일은 되는데 포크된 테스트 워커가 클래스를 못 찾고
 *   기본으로 들어 있는 ExampleUnitTest 까지 ClassNotFoundException 으로 죽는다
 *   (2026-08-05 실측 — 인코딩 옵션으로는 해결되지 않았다).
 *
 *   그래서 javac/java 를 직접 부른다. 대상이 **안드로이드에 기대지 않는 순수 클래스**뿐이라
 *   가능한 방법이다 — 그러라고 TextDecoding 을 플러그인에서 떼어 냈다.
 *
 * ★ 여기서 도는 것만 테스트된다. 새 순수 클래스를 만들면 아래 SOURCES 에 더해라.
 */

const { execFileSync, spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const repoRoot = path.resolve(__dirname, '..');
const isWindows = process.platform === 'win32';
const exe = (name) => (isWindows ? `${name}.exe` : name);

/** 안드로이드·Capacitor 에 기대지 않는 클래스만 넣는다. */
const SOURCES = [
    'android/app/src/main/java/com/marklet/md/mdfile/TextDecoding.java',
    'android/app/src/test/java/com/marklet/md/mdfile/MdFileDecodeTest.java',
];

const TEST_CLASSES = ['com.marklet.md.mdfile.MdFileDecodeTest'];

function findJdk() {
    const home = process.env.JAVA_HOME;
    if (home && fs.existsSync(path.join(home, 'bin', exe('javac')))) return home;
    try {
        const probe = isWindows ? 'where' : 'which';
        const bin = execFileSync(probe, ['javac'], { encoding: 'utf8' }).split(/\r?\n/).find(Boolean);
        if (bin) return path.resolve(path.dirname(bin), '..');
    } catch {
        /* 아래에서 안내한다 */
    }
    return null;
}

/** Gradle 캐시에서 jar 하나를 찾는다. 이름이 정확해야 한다. */
function findJar(name) {
    const cache = path.join(os.homedir(), '.gradle', 'caches');
    if (!fs.existsSync(cache)) return null;
    const stack = [cache];
    while (stack.length) {
        const dir = stack.pop();
        let entries;
        try {
            entries = fs.readdirSync(dir, { withFileTypes: true });
        } catch {
            continue;
        }
        for (const e of entries) {
            const p = path.join(dir, e.name);
            if (e.isDirectory()) stack.push(p);
            else if (e.name === name) return p;
        }
    }
    return null;
}

const jdk = findJdk();
if (!jdk) {
    console.error('❌ JDK 를 찾지 못했습니다. JAVA_HOME 을 지정하거나 javac 를 PATH 에 두세요.');
    process.exit(1);
}

const junit = findJar('junit-4.13.2.jar');
const hamcrest = findJar('hamcrest-core-1.3.jar');
if (!junit || !hamcrest) {
    console.error('❌ junit 4.13.2 / hamcrest-core 1.3 을 Gradle 캐시에서 찾지 못했습니다.');
    console.error('   안드로이드를 한 번 빌드하면 받아집니다:  cd android && ./gradlew assembleDebug');
    process.exit(1);
}

const out = path.join(repoRoot, 'android', 'app', 'build', 'jvm-test-classes');
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });

const sep = isWindows ? ';' : ':';
const deps = [junit, hamcrest].join(sep);

const compile = spawnSync(
    path.join(jdk, 'bin', exe('javac')),
    ['-encoding', 'UTF-8', '-d', out, '-cp', deps, ...SOURCES.map((s) => path.join(repoRoot, s))],
    { cwd: repoRoot, encoding: 'utf8' },
);
if (compile.status !== 0) {
    console.error(compile.stderr || compile.stdout);
    console.error('❌ 컴파일 실패');
    process.exit(1);
}

const run = spawnSync(
    path.join(jdk, 'bin', exe('java')),
    ['-Dfile.encoding=UTF-8', '-cp', [out, deps].join(sep), 'org.junit.runner.JUnitCore', ...TEST_CLASSES],
    { cwd: repoRoot, encoding: 'utf8' },
);

process.stdout.write(run.stdout ?? '');
if (run.status !== 0) {
    process.stderr.write(run.stderr ?? '');
    console.error('❌ 자바 테스트 실패');
    process.exit(1);
}
console.log('✅ 자바 단위 테스트 통과');
