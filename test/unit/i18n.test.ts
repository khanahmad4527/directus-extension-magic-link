import { Liquid } from 'liquidjs';
import { describe, expect, it } from 'vitest';
import { toLocalizedText } from '../../src/shared/config.js';
import {
	FALLBACK_LOCALE,
	localeVariants,
	negotiateLocale,
	parseAcceptLanguage,
	renderMessages,
	SUPPORTED_LOCALES,
} from '../../src/shared/i18n.js';

describe('negotiateLocale', () => {
	it.each([
		[['fr-FR'], 'fr-FR'],
		[['FR-fr'], 'fr-FR'],
		[['fr_FR'], 'fr-FR'],
		[['fr-CA'], 'fr-FR'],
		[['fr'], 'fr-FR'],
		[['de-DE'], null],
		[[null, undefined, ''], null],
		[['de-DE', 'fr-FR'], 'fr-FR'],
		[['en-GB', 'fr-FR'], 'en-US'],
	] as const)('%j -> %s', (candidates, expected) => {
		expect(negotiateLocale([...candidates])).toBe(expected);
	});

	it('tries each candidate fully before the next', () => {
		expect(negotiateLocale(['fr-CA', 'en-US'], ['en-US', 'fr-FR'])).toBe('fr-FR');
	});

	it('works on any list of locales', () => {
		expect(negotiateLocale(['de-AT'], ['de-DE', 'en-US'])).toBe('de-DE');
	});
});

describe('parseAcceptLanguage', () => {
	it('orders by quality and drops wildcards and q=0', () => {
		expect(parseAcceptLanguage('en;q=0.5, fr-FR, de;q=0.8, *;q=0.1, es;q=0')).toEqual(['fr-FR', 'de', 'en']);
	});

	it('handles missing headers', () => {
		expect(parseAcceptLanguage(undefined)).toEqual([]);
		expect(parseAcceptLanguage('')).toEqual([]);
	});
});

describe('localeVariants', () => {
	it('adds the bare language', () => {
		expect(localeVariants('fr-FR')).toEqual(['fr-FR', 'fr']);
		expect(localeVariants('fr')).toEqual(['fr']);
	});
});

describe('renderMessages', () => {
	const liquid = new Liquid();
	const data = { projectName: 'Acme', email: 'jane@acme.com', user: { first_name: 'Jane' }, expiresInMinutes: 1 };

	it('ships the same keys for every locale', () => {
		const keys = Object.keys(renderMessages(liquid, FALLBACK_LOCALE, data)).sort();

		for (const locale of SUPPORTED_LOCALES) {
			expect(Object.keys(renderMessages(liquid, locale, data)).sort()).toEqual(keys);
		}
	});

	it('renders French with the data', () => {
		const t = renderMessages(liquid, 'fr-FR', data);

		expect(t.locale).toBe('fr-FR');
		expect(t.subject).toBe('Connexion à Acme');
		expect(t.greeting).toBe('Bonjour Jane,');
		expect(t.expiry).toContain('1 minute et');
	});

	it('pluralises and handles a missing first name', () => {
		const t = renderMessages(liquid, 'en-US', { ...data, user: { first_name: null }, expiresInMinutes: 15 });

		expect(t.greeting).toBe('Hi,');
		expect(t.expiry).toContain('15 minutes');
	});

	it('falls back to en-US for unknown locales', () => {
		const t = renderMessages(liquid, 'de-DE', data);

		expect(t.locale).toBe('en-US');
		expect(t.subject).toBe('Sign in to Acme');
	});
});

describe('toLocalizedText', () => {
	it('accepts a plain string, a JSON map or an already-parsed map', () => {
		expect(toLocalizedText('Hello {{ projectName }}')).toBe('Hello {{ projectName }}');
		expect(toLocalizedText('{"fr-FR":"Bonjour","en-US":"Hello"}')).toEqual({ 'fr-FR': 'Bonjour', 'en-US': 'Hello' });
		expect(toLocalizedText({ 'fr-FR': 'Bonjour' })).toEqual({ 'fr-FR': 'Bonjour' });
		expect(toLocalizedText('{ not json')).toBe('{ not json');
		expect(toLocalizedText(undefined)).toBeNull();
		expect(toLocalizedText('')).toBeNull();
	});
});
