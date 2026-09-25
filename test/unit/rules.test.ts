import { describe, expect, it } from 'vitest';
import {
	compareVersions,
	isSafeRedirect,
	isUrlAllowed,
	isValidEmail,
	matchesAnyEmailPattern,
	matchesEmailPattern,
} from '../../src/shared/rules.js';

describe('matchesEmailPattern', () => {
	it.each([
		['jane@acme.com', 'jane@acme.com', true],
		['Jane@ACME.com', 'jane@acme.com', true],
		['jane@acme.com', 'john@acme.com', false],
		['jane@acme.com', '@acme.com', true],
		['jane@mail.acme.com', '@acme.com', false],
		['jane@mail.acme.com', '*.acme.com', true],
		['jane@acme.com', '*.acme.com', false],
		['jane@evilacme.com', '*.acme.com', false],
		['qa+1@acme.com', 'qa+*@acme.com', true],
		['qa1@acme.com', 'qa+*@acme.com', false],
		['jane@acme.com', '*@acme.com', true],
		['jane@acme.com.evil.io', '*@acme.com', false],
		['ops-1@acme.com', '/^ops-\\d+@acme\\.com$/', true],
		['OPS-1@acme.com', '/^ops-\\d+@acme\\.com$/', false],
		['OPS-1@acme.com', '/^ops-\\d+@acme\\.com$/i', true],
		['jane@acme.com', '/[/', false],
		['jane@acme.com', '', false],
		['jane@acme.com', '   ', false],
	])('%s against %s -> %s', (email, pattern, expected) => {
		expect(matchesEmailPattern(email, pattern)).toBe(expected);
	});

	it('escapes regex characters in globs', () => {
		expect(matchesEmailPattern('jane@acmexcom', '*@acme.com')).toBe(false);
	});

	it('matches any of several patterns', () => {
		expect(matchesAnyEmailPattern('a@b.io', ['@x.io', '@b.io'])).toBe(true);
		expect(matchesAnyEmailPattern('a@b.io', [])).toBe(false);
	});
});

describe('isUrlAllowed', () => {
	const list = ['https://app.acme.com/auth/magic', 'http://localhost:3000/login'];

	it('allows exact and origin+path matches, ignoring query and hash', () => {
		expect(isUrlAllowed('https://app.acme.com/auth/magic', list)).toBe(true);
		expect(isUrlAllowed('https://app.acme.com/auth/magic?x=1#y', list)).toBe(true);
	});

	it('rejects other paths, origins, schemes and junk', () => {
		expect(isUrlAllowed('https://app.acme.com/auth/magic/extra', list)).toBe(false);
		expect(isUrlAllowed('http://app.acme.com/auth/magic', list)).toBe(false);
		expect(isUrlAllowed('https://app.acme.com.evil.io/auth/magic', list)).toBe(false);
		expect(isUrlAllowed('javascript:alert(1)', list)).toBe(false);
		expect(isUrlAllowed('not a url', list)).toBe(false);
		expect(isUrlAllowed('https://app.acme.com/auth/magic', [])).toBe(false);
	});
});

describe('isSafeRedirect', () => {
	it('allows same-origin paths', () => {
		expect(isSafeRedirect('/admin', [])).toBe(true);
		expect(isSafeRedirect('/admin/content?x=1', [])).toBe(true);
	});

	it('rejects protocol-relative, backslash and absolute URLs unless allow-listed', () => {
		expect(isSafeRedirect('//evil.com', [])).toBe(false);
		expect(isSafeRedirect('/\\evil.com', [])).toBe(false);
		expect(isSafeRedirect('https://evil.com', [])).toBe(false);
		expect(isSafeRedirect('admin', [])).toBe(false);
		expect(isSafeRedirect('https://app.acme.com/x', ['https://app.acme.com/x'])).toBe(true);
	});
});

describe('isValidEmail', () => {
	it.each([
		['jane@acme.com', true],
		['jane+tag@sub.acme.io', true],
		['jane', false],
		['jane@acme', false],
		['jane @acme.com', false],
		['', false],
		[`${'a'.repeat(250)}@a.io`, false],
		[42, false],
		[null, false],
	])('%s -> %s', (value, expected) => {
		expect(isValidEmail(value)).toBe(expected);
	});
});

describe('compareVersions', () => {
	it.each([
		['11.10.0', '11.10.0', 0],
		['11.9.3', '11.10.0', -1],
		['11.17.4', '11.10.0', 1],
		['12.0.0', '11.10.0', 1],
		['11.10.0-rc.1', '11.10.0', 0],
		['11.10', '11.10.0', 0],
	])('%s vs %s -> %s', (a, b, expected) => {
		expect(compareVersions(a, b)).toBe(expected);
	});
});
