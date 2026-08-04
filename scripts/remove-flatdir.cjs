#!/usr/bin/env node

/**
 * Capacitor Hook - flatDir 경고 제거
 *
 * cordova-plugin-purchase 가 Cordova 플러그인이라
 * android/capacitor-cordova-android-plugins/build.gradle 이 자동 생성되고
 * 거기에 flatDir 저장소 선언이 들어간다. Gradle 8은 매 빌드마다 경고를 쏟는다.
 * 그 파일은 cap sync 마다 다시 생성되므로 손으로 고쳐도 소용없다.
 */

const fs = require('fs');
const path = require('path');

const buildGradlePath = path.join(
    __dirname,
    '..',
    'android',
    'capacitor-cordova-android-plugins',
    'build.gradle',
);

console.log('🔧 [Post-Sync Hook] flatDir 경고 제거 중...');

try {
    if (!fs.existsSync(buildGradlePath)) {
        console.log('⚠️  build.gradle 파일을 찾을 수 없습니다:', buildGradlePath);
        process.exit(0);
    }

    let content = fs.readFileSync(buildGradlePath, 'utf8');
    const flatDirPattern = /repositories\s*\{([^}]*?)flatDir\s*\{[^}]*\}([^}]*?)\}/s;

    if (flatDirPattern.test(content)) {
        content = content.replace(
            flatDirPattern,
            "repositories {$1// flatDir 제거: fileTree(dir: 'src/main/libs')로 이미 처리됨$2}",
        );
        fs.writeFileSync(buildGradlePath, content, 'utf8');
        console.log('✅ flatDir 제거 완료!');
    } else {
        console.log('✨ flatDir가 이미 제거되어 있습니다.');
    }
} catch (error) {
    console.error('❌ flatDir 제거 중 오류:', error.message);
    // 경고 제거는 빌드를 막을 일이 아니다.
    process.exit(0);
}
