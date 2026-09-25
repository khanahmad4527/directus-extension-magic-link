import js from '@eslint/js';
import prettier from 'eslint-config-prettier';
import { defineConfig } from 'eslint/config';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default defineConfig(
	{ ignores: ['dist', 'node_modules'] },
	js.configs.recommended,
	tseslint.configs.strictTypeChecked,
	tseslint.configs.stylisticTypeChecked,
	{
		languageOptions: {
			globals: globals.node,
			parserOptions: {
				projectService: { allowDefaultProject: ['*.js', 'examples/*/*.js', 'test/e2e/fixtures/extensions/*/*.js'] },
				tsconfigRootDir: import.meta.dirname,
			},
		},
		rules: {
			'@typescript-eslint/consistent-type-definitions': ['error', 'type'],
			'@typescript-eslint/consistent-type-imports': ['error', { fixStyle: 'inline-type-imports' }],
			// Directus awaits async hook/init handlers even though their types say `void`
			'@typescript-eslint/no-misused-promises': ['error', { checksVoidReturn: { arguments: false } }],
			// `||` is intended for strings: an empty env value or setting falls back to the default, as in Directus core
			'@typescript-eslint/prefer-nullish-coalescing': ['error', { ignorePrimitives: { string: true } }],
			'@typescript-eslint/restrict-template-expressions': ['error', { allowNumber: true }],
			'@typescript-eslint/no-unused-vars': ['error', { ignoreRestSiblings: true }],
			eqeqeq: ['error', 'always'],
			'no-console': 'error',
			'prefer-const': 'error',
		},
	},
	{
		files: ['test/**/*.ts'],
		rules: {
			'@typescript-eslint/no-non-null-assertion': 'off',
			'@typescript-eslint/no-unsafe-assignment': 'off',
			'@typescript-eslint/no-unsafe-member-access': 'off',
			'@typescript-eslint/no-unsafe-return': 'off',
			'@typescript-eslint/no-unsafe-argument': 'off',
			'@typescript-eslint/no-unsafe-call': 'off',
			'@typescript-eslint/no-explicit-any': 'off',
		},
	},
	{
		files: ['**/*.js'],
		extends: [tseslint.configs.disableTypeChecked],
	},
	prettier,
);
