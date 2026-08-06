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
 * ★★ 대상 목록을 손으로 적지 않는다 (2026-08-06).
 *   전에는 SOURCES·TEST_CLASSES 를 배열에 박아 두고 "새 클래스를 만들면 더해라" 고
 *   적어 뒀는데, 바로 그날 UriErrors 를 만들면서 **그 줄을 빼먹었다.**
 *   테스트 파일을 새로 쓰고 `npm run test:java` 가 초록으로 지나가는데
 *   실제로는 한 줄도 안 돌고 있었다 — 이 프로젝트에서 가장 위험한 종류의 실패다.
 *   그래서 훑어서 찾는다. 안드로이드에 기대는 파일은 import 로 걸러 낸다.
 */

const { execFileSync, spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const repoRoot = path.resolve(__dirname, '..');
const isWindows = process.platform === 'win32';
const exe = (name) => (isWindows ? `${name}.exe` : name);

const JAVA_ROOTS = ['android/app/src/main/java', 'android/app/src/test/java'];

/** 이 중 하나라도 import 하면 안드로이드 런타임이 필요하다 — JVM 에서 못 돈다. */
const NEEDS_ANDROID = /^import\s+(android|androidx|com\.getcapacitor|dalvik)\./m;

function javaFiles(dir) {
    const out = [];
    if (!fs.existsSync(dir)) return out;
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) out.push(...javaFiles(p));
        else if (e.name.endsWith('.java')) out.push(p);
    }
    return out;
}

const all = JAVA_ROOTS.flatMap((r) => javaFiles(path.join(repoRoot, r)));
const skipped = [];
const SOURCES = [];

for (const file of all) {
    if (NEEDS_ANDROID.test(fs.readFileSync(file, 'utf8'))) {
        skipped.push(path.relative(repoRoot, file));
        continue;
    }
    SOURCES.push(file);
}

/** 패키지 + 클래스 이름으로 완전한 이름을 만든다. */
function className(file) {
    const src = fs.readFileSync(file, 'utf8');
    const pkg = src.match(/^package\s+([\w.]+)\s*;/m);
    const name = path.basename(file, '.java');
    return pkg ? `${pkg[1]}.${name}` : name;
}

const TEST_CLASSES = SOURCES.filter(
    (f) => f.includes(`${path.sep}test${path.sep}`) && /Test\.java$/.test(f),
).map(className);

if (TEST_CLASSES.length === 0) {
    console.error('❌ 돌릴 테스트 클래스를 찾지 못했습니다. 이건 통과가 아닙니다.');
    process.exit(1);
}

// ★ 무엇이 빠졌는지 반드시 보여 준다. 조용히 빼면 '전부 돌았다'로 읽힌다.
if (skipped.length) {
    console.log(`ℹ 안드로이드에 기대어 건너뜀 (${skipped.length}개):`);
    for (const s of skipped) console.log(`   ${s}`);
}
console.log(`▶ 테스트 클래스 ${TEST_CLASSES.length}개: ${TEST_CLASSES.join(', ')}`);

function findJdk() {
    const home = process.env.JAVA_HOME;
    if (home && fs.existsSync(path.join(home, 'bin', exe('javac')))) return home;
    try {
        const probe = isWindows ? 'where' : 'which';
        const bin = execFileSync(probe, ['javac'], { encoding: 'utf8' })
            .split(/\r?\n/)
            .find(Boolean);
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
    console.error(
        '   안드로이드를 한 번 빌드하면 받아집니다:  cd android && ./gradlew assembleDebug',
    );
    process.exit(1);
}

const out = path.join(repoRoot, 'android', 'app', 'build', 'jvm-test-classes');
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });

const sep = isWindows ? ';' : ':';
const deps = [junit, hamcrest].join(sep);

const compile = spawnSync(
    path.join(jdk, 'bin', exe('javac')),
    ['-encoding', 'UTF-8', '-d', out, '-cp', deps, ...SOURCES],
    { cwd: repoRoot, encoding: 'utf8' },
);
if (compile.status !== 0) {
    console.error(compile.stderr || compile.stdout);
    console.error('❌ 컴파일 실패');
    process.exit(1);
}

const run = spawnSync(
    path.join(jdk, 'bin', exe('java')),
    [
        '-Dfile.encoding=UTF-8',
        '-cp',
        [out, deps].join(sep),
        'org.junit.runner.JUnitCore',
        ...TEST_CLASSES,
    ],
    { cwd: repoRoot, encoding: 'utf8' },
);

process.stdout.write(run.stdout ?? '');
if (run.status !== 0) {
    process.stderr.write(run.stderr ?? '');
    console.error('❌ 자바 테스트 실패');
    process.exit(1);
}
console.log('✅ 자바 단위 테스트 통과');
