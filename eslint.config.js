import typescriptEslintParser from '@typescript-eslint/parser';
import typescriptEslintPlugin from '@typescript-eslint/eslint-plugin';
import prettierPlugin from 'eslint-plugin-prettier';
import prettierConfig from 'eslint-config-prettier';

export default [
    {
        ignores: ['node_modules/', 'dist/', 'scripts/', 'src-tauri/'],
    },
    {
        files: ['src/**/*.ts'],
        languageOptions: {
            parser: typescriptEslintParser,
            parserOptions: {
                ecmaVersion: 2020,
                sourceType: 'module',
            },
        },
        plugins: {
            '@typescript-eslint': typescriptEslintPlugin,
            prettier: prettierPlugin,
        },
        rules: {
            ...typescriptEslintPlugin.configs.recommended.rules,
            ...prettierConfig.rules,
            'prettier/prettier': 'warn',
            '@typescript-eslint/no-explicit-any': 'warn',
            '@typescript-eslint/no-unused-vars': 'warn',
            'no-undef': 'off', // TypeScript 가 이미 검사한다
        },
    },
];
