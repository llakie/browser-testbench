import stylistic from '@stylistic/eslint-plugin';
import babelParser from '@babel/eslint-parser';

const controlStatements = ['if', 'for', 'while', 'do', 'switch', 'try'];
const plugins = {
    '@stylistic': stylistic,
};
const rules = {
    curly: ['error', 'all'],
    'no-else-return': ['error', { allowElseIf: false }],
    '@stylistic/brace-style': ['error', '1tbs', { allowSingleLine: false }],
    '@stylistic/padding-line-between-statements': [
        'error',
        { blankLine: 'always', prev: '*', next: controlStatements },
        { blankLine: 'always', prev: controlStatements, next: '*' },
    ],
};

export default [
    {
        ignores: ['.kilo/**', 'dist/**', 'node_modules/**'],
    },
    {
        files: ['**/*.{js,mjs}'],
        languageOptions: {
            ecmaVersion: 'latest',
            sourceType: 'module',
        },
        plugins,
        rules,
    },
    {
        files: ['**/*.ts'],
        languageOptions: {
            ecmaVersion: 'latest',
            parser: babelParser,
            parserOptions: {
                babelOptions: {
                    presets: ['@babel/preset-typescript'],
                },
                requireConfigFile: false,
            },
            sourceType: 'module',
        },
        plugins,
        rules,
    },
];
