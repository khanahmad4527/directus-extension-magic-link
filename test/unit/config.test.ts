import { describe, expect, it } from 'vitest';
import { readConfig, toBool, toInt, toList, toMilliseconds } from '../../src/shared/config.js';

describe('env parsing', () => {
	it('reads lists from strings and from values Directus already cast', () => {
		expect(toList('a, b,,c')).toEqual(['a', 'b', 'c']);
		expect(toList(['a', ' b '])).toEqual(['a', 'b']);
		expect(toList(undefined)).toEqual([]);
		expect(toList('')).toEqual([]);
	});

	it('reads booleans', () => {
		expect(toBool(true, false)).toBe(true);
		expect(toBool('false', true)).toBe(false);
		expect(toBool('1', false)).toBe(true);
		expect(toBool(undefined, true)).toBe(true);
	});

	it('reads integers', () => {
		expect(toInt('5', 0)).toBe(5);
		expect(toInt(7, 0)).toBe(7);
		expect(toInt('nope', 3)).toBe(3);
	});

	it('reads durations like Directus getMilliseconds()', () => {
		expect(toMilliseconds('15m', 0)).toBe(900_000);
		expect(toMilliseconds('7d', 0)).toBe(604_800_000);
		expect(toMilliseconds(1000, 0)).toBe(1000);
		expect(toMilliseconds('garbage', 42)).toBe(42);
		expect(toMilliseconds(undefined, 42)).toBe(42);
	});
});

describe('values Directus split on commas', () => {
	// Directus' env loader turns any value containing a comma into an array of its parts
	const split = (value: string) => value.split(',');

	it('restores text settings', () => {
		const config = readConfig({
			MAGIC_LINK_EMAIL_SUBJECT: split('Hello, {{ user.first_name }}'),
			MAGIC_LINK_EMAIL_FROM: split('"Doe, John" <login@acme.com>'),
		});

		expect(config.emailSubject).toBe('Hello, {{ user.first_name }}');
		expect(config.emailFrom).toBe('"Doe, John" <login@acme.com>');
	});

	it('restores a JSON subject map', () => {
		const raw = '{"en-US": "Sign in, {{ projectName }}", "fr-FR": "Connexion, {{ projectName }}"}';

		expect(readConfig({ MAGIC_LINK_EMAIL_SUBJECT: split(raw) }).emailSubject).toEqual({
			'en-US': 'Sign in, {{ projectName }}',
			'fr-FR': 'Connexion, {{ projectName }}',
		});
	});

	it('still reads lists as lists', () => {
		expect(readConfig({ MAGIC_LINK_EMAIL_DENY_LIST: split('@a.io, @b.io') }).emailDenyList).toEqual(['@a.io', '@b.io']);
	});
});

describe('readConfig', () => {
	it('uses Directus-compatible defaults', () => {
		const config = readConfig({});

		expect(config.publicUrl).toBe('http://localhost:8055');
		expect(config.allowedProviders).toEqual(['default']);
		expect(config.ttl).toBe(15 * 60 * 1000);
		expect(config.stallTime).toBe(500);
		expect(config.requireTfa).toBe(true);
		expect(config.enablePages).toBe(false);
		expect(config.notifyInactive).toBe(true);
		expect(config.refreshCookie).toEqual({
			name: 'directus_refresh_token',
			options: { httpOnly: true, domain: undefined, maxAge: 604_800_000, secure: false, sameSite: 'strict' },
		});
		expect(config.sessionCookie.name).toBe('directus_session_token');
		expect(config.sessionCookie.options.maxAge).toBe(86_400_000);
	});

	it('follows Directus cookie and stall settings', () => {
		const config = readConfig({
			PUBLIC_URL: 'https://cms.acme.com/',
			LOGIN_STALL_TIME: 800,
			SESSION_COOKIE_NAME: 'sess',
			SESSION_COOKIE_SECURE: true,
			SESSION_COOKIE_SAME_SITE: 'lax',
			SESSION_COOKIE_DOMAIN: '.acme.com',
			SESSION_COOKIE_TTL: '2h',
		});

		expect(config.publicUrl).toBe('https://cms.acme.com');
		expect(config.stallTime).toBe(800);
		expect(config.sessionCookie).toEqual({
			name: 'sess',
			options: { httpOnly: true, domain: '.acme.com', maxAge: 7_200_000, secure: true, sameSite: 'lax' },
		});
	});

	it('lets MAGIC_LINK_ALLOWED_PROVIDERS be emptied to allow every provider', () => {
		expect(readConfig({ MAGIC_LINK_ALLOWED_PROVIDERS: '' }).allowedProviders).toEqual([]);
		expect(readConfig({ MAGIC_LINK_ALLOWED_PROVIDERS: 'default,ldap' }).allowedProviders).toEqual(['default', 'ldap']);
	});
});
