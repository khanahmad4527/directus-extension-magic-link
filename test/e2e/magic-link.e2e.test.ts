import { createHmac, randomInt, randomUUID } from 'node:crypto';
import { rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { compareVersions } from '../../src/shared/rules.js';

const DIRECTUS = process.env['DIRECTUS_URL'] ?? 'http://localhost:8155';
const MAILPIT = process.env['MAILPIT_URL'] ?? 'http://localhost:8125';
const TEMPLATES = path.resolve(import.meta.dirname, 'fixtures/templates');
const RUN = randomUUID().slice(0, 8);
// Set by scripts/e2e.sh: full | upgrade (pages on, full PUBLIC_URL), defaults (pages off, PUBLIC_URL "/"), nourl (pages on, PUBLIC_URL "/")
const MODE = process.env['E2E_MODE'] ?? 'full';
const SUITE = `Directus ${process.env['DIRECTUS_VERSION'] ?? ''} ${process.env['DB_CLIENT'] ?? ''}`.trim();

type Json = Record<string, any>;

let adminToken = '';
let roleId = '';
let directusVersion = '';

const randomIp = () => `10.${randomInt(256)}.${randomInt(256)}.${randomInt(1, 255)}`;
const address = (name: string) => `${name}-${RUN}@example.com`;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function call(
	pathname: string,
	init: { method?: string; body?: unknown; token?: string; headers?: Record<string, string>; form?: Record<string, string> } = {},
) {
	const headers: Record<string, string> = { 'x-test-ip': randomIp(), ...init.headers };
	let body: string | undefined;

	if (init.form) {
		headers['content-type'] = 'application/x-www-form-urlencoded';
		body = new URLSearchParams(init.form).toString();
	} else if (init.body !== undefined) {
		headers['content-type'] = 'application/json';
		body = JSON.stringify(init.body);
	}

	if (init.token) headers['authorization'] = `Bearer ${init.token}`;

	const res = await fetch(`${DIRECTUS}${pathname}`, { method: init.method ?? (body ? 'POST' : 'GET'), headers, body, redirect: 'manual' });
	const raw = await res.text();

	return { status: res.status, headers: res.headers, text: raw, json: parseJson(raw) };
}

function parseJson(raw: string): Json | null {
	try {
		return raw ? (JSON.parse(raw) as Json) : null;
	} catch {
		return null;
	}
}

function cookie(headers: Headers, name: string): string | null {
	for (const value of headers.getSetCookie()) {
		const [pair] = value.split(';');
		const [key, ...rest] = pair!.split('=');
		if (key === name) return rest.join('=');
	}

	return null;
}

async function admin(pathname: string, method = 'GET', body?: unknown) {
	const res = await call(pathname, { method, body, token: adminToken });
	if (res.status >= 400) throw new Error(`${method} ${pathname} -> ${res.status} ${res.text}`);
	return res.json?.['data'];
}

async function createUser(email: string, fields: Json = {}): Promise<string> {
	const user = await admin('/users', 'POST', {
		email,
		password: 'password123',
		status: 'active',
		role: roleId,
		first_name: 'Test',
		...fields,
	});
	return user.id;
}

async function requestLink(email: string, extra: Json = {}, headers: Record<string, string> = {}) {
	return call('/magic-link/request', { body: { email, ...extra }, headers });
}

type Mail = { From: { Name: string; Address: string }; To: { Address: string }[]; Subject: string; Text: string; HTML: string };

// Mailpit's `to:` search matches substrings, so keep only exact recipients
async function mailsTo(email: string): Promise<Mail[]> {
	const search = (await fetch(`${MAILPIT}/api/v1/search?query=${encodeURIComponent(`to:"${email}"`)}`).then((res) => res.json())) as {
		messages: { ID: string; To: { Address: string }[] }[];
	};

	const exact = search.messages.filter((message) => message.To.some(({ Address }) => Address.toLowerCase() === email.toLowerCase()));
	return Promise.all(exact.map(({ ID }) => fetch(`${MAILPIT}/api/v1/message/${ID}`).then((res) => res.json() as Promise<Mail>)));
}

async function waitForMails(email: string, count = 1): Promise<Mail[]> {
	for (let i = 0; i < 50; i++) {
		const mails = await mailsTo(email);
		if (mails.length >= count) return mails;
		await sleep(200);
	}

	throw new Error(`Expected ${count} email(s) to ${email}`);
}

async function events(email: string): Promise<Json[]> {
	return (await call(`/magic-link-test/events?email=${encodeURIComponent(email)}`)).json as Json[];
}

async function waitForRequestEvent(email: string, count = 1): Promise<Json> {
	for (let i = 0; i < 50; i++) {
		const list = (await events(email)).filter((event) => event['type'] === 'request');
		if (list.length >= count) return list[count - 1]!;
		await sleep(200);
	}

	throw new Error(`No magic-link.request event for ${email}`);
}

function linkFrom(mail: Mail): URL {
	const match = /(https?:\/\/\S+token=[\w-]+\S*)/.exec(mail.Text);
	if (!match) throw new Error(`No link in email: ${mail.Text}`);
	return new URL(match[1]!);
}

async function tokenFor(email: string, count = 1): Promise<string> {
	const [newest] = await waitForMails(email, count);
	const token = linkFrom(newest!).searchParams.get('token');
	if (!token) throw new Error('Missing token');
	return token;
}

// `count`: how many emails this address should have received, including this one
async function newToken(email: string, count = 1): Promise<string> {
	expect((await requestLink(email)).status).toBe(204);
	return tokenFor(email, count);
}

const errorCode = (res: { json: Json | null }): string | undefined => res.json?.['errors']?.[0]?.extensions?.code;

function verify(token: string, extra: Json = {}) {
	return call('/magic-link/verify', { body: { token, ...extra } });
}

function jwtUserId(token: string | null): string {
	return JSON.parse(Buffer.from(token!.split('.')[1]!, 'base64url').toString()).id;
}

async function enableTfa(email: string): Promise<string> {
	const secret = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP';
	await call('/magic-link-test/tfa', { body: { email, secret } });
	return secret;
}

function totp(secret: string, offset = 0): string {
	const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
	let bits = '';
	for (const char of secret.replace(/=+$/, '').toUpperCase()) bits += alphabet.indexOf(char).toString(2).padStart(5, '0');
	const key = Buffer.from(bits.match(/.{8}/g)!.map((byte) => Number.parseInt(byte, 2)));

	const counter = Buffer.alloc(8);
	counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30_000) + offset));

	const hmac = createHmac('sha1', key).update(counter).digest();
	const start = hmac[hmac.length - 1]! & 0xf;
	return ((hmac.readUInt32BE(start) & 0x7fffffff) % 1_000_000).toString().padStart(6, '0');
}

beforeAll(async () => {
	const login = await call('/auth/login', { body: { email: 'admin@example.com', password: 'adminpass' } });
	adminToken = login.json!['data'].access_token;

	directusVersion = (await admin('/server/info')).version;

	// No app access: these users don't occupy a license seat on Directus 12
	const policy = await admin('/policies', 'POST', { name: `magic-link-e2e-${RUN}`, app_access: false, admin_access: false, icon: 'badge' });
	const role = await admin('/roles', 'POST', { name: `magic-link-e2e-${RUN}`, icon: 'badge' });
	roleId = role.id;
	await admin('/access', 'POST', { role: roleId, policy: policy.id });
});

describe.runIf(MODE === 'full' || MODE === 'upgrade')(SUITE, () => {
	it('reports the Directus version under test', () => {
		expect(directusVersion).toMatch(/^1[12]\./);
	});

	describe('request', () => {
		it('rejects malformed input like core does', async () => {
			const invalid = await requestLink('not-an-email');
			expect(invalid.status).toBe(400);
			expect(invalid.json!['errors'][0].extensions.code).toBe('INVALID_PAYLOAD');

			const redirect = await requestLink(address('redirect'), { redirect_url: 'https://evil.com/auth' });
			expect(redirect.status).toBe(400);
		});

		it('answers identically and in constant time whether or not the account exists', async () => {
			const email = address('timing');
			await createUser(email);

			const timings: Record<string, number[]> = { existing: [], unknown: [] };

			for (let i = 0; i < 3; i++) {
				for (const [kind, target] of [
					['existing', email],
					['unknown', address(`nobody${i}`)],
				] as const) {
					const start = performance.now();
					const res = await requestLink(target);
					timings[kind]!.push(performance.now() - start);
					expect(res.status).toBe(204);
					expect(res.text).toBe('');
				}
			}

			const avg = (values: number[]) => values.reduce((sum, value) => sum + value, 0) / values.length;
			expect(Math.min(...timings['existing']!, ...timings['unknown']!)).toBeGreaterThanOrEqual(290);
			expect(Math.abs(avg(timings['existing']!) - avg(timings['unknown']!))).toBeLessThan(100);
		});

		it.each(['suspended', 'invited', 'draft', 'archived'])('tells %s users by email that their account is not active', async (status) => {
			const email = address(status);
			await createUser(email, { status });

			const res = await requestLink(email);
			expect(res.status).toBe(204);

			const event = await waitForRequestEvent(email);
			expect(event).toMatchObject({ status: 'rejected', reason: `user_status_${status}`, notified: true });

			const [mail] = await waitForMails(email);
			expect(mail!.Subject).toBe('Your Directus account is not active');
			expect(mail!.Text).toContain('contact your administrator');
			expect(mail!.Text).not.toContain('token=');
		});

		it('rate-limits inactive-account emails too', async () => {
			const email = address('suspended-flood');
			await createUser(email, { status: 'suspended' });

			for (let i = 0; i < 4; i++) await requestLink(email);

			expect(await waitForRequestEvent(email, 4)).toMatchObject({ status: 'rejected', notified: false });
			expect(await mailsTo(email)).toHaveLength(3);
		});

		it('tells inactive users in their language', async () => {
			const email = address('suspended-fr');
			await createUser(email, { status: 'suspended', language: 'fr-FR' });
			await requestLink(email);

			expect((await waitForMails(email))[0]!.Subject).toBe("Votre compte Directus n'est pas actif");
		});

		it('never emails unknown addresses', async () => {
			const email = address('ghost');
			await requestLink(email);
			expect(await waitForRequestEvent(email)).toMatchObject({ status: 'rejected', reason: 'user_not_found', notified: false });
			expect(await mailsTo(email)).toHaveLength(0);
		});

		it('applies MAGIC_LINK_EMAIL_DENY_LIST', async () => {
			const email = `blocked-${RUN}@blocked.io`;
			await createUser(email);
			await requestLink(email);
			expect(await waitForRequestEvent(email)).toMatchObject({ status: 'rejected', reason: 'email_not_allowed' });
		});

		it('lets a magic-link.validate hook bypass the extension rules', async () => {
			const email = `vip-${RUN}@bypass.io`;
			await createUser(email);
			await requestLink(email);
			expect(await waitForRequestEvent(email)).toMatchObject({ status: 'sent' });
		});

		it('lets a magic-link.validate hook reject by throwing', async () => {
			const email = `qa+${RUN}@example.com`;
			await createUser(email);
			await requestLink(email);
			expect(await waitForRequestEvent(email)).toMatchObject({ status: 'rejected', reason: 'rejected_by_hook: QA addresses are refused' });
		});

		it('rate-limits per email address', async () => {
			const email = address('flood');
			await createUser(email);

			for (let i = 0; i < 4; i++) await requestLink(email);

			const fourth = await waitForRequestEvent(email, 4);
			expect(fourth).toMatchObject({ status: 'rejected', reason: 'rate_limited' });
			expect(await mailsTo(email)).toHaveLength(3);
		});

		it('rate-limits per IP address', async () => {
			const ip = randomIp();
			const email = address('ip-limit');
			await createUser(email);

			for (let i = 0; i < 5; i++) expect((await requestLink(address(`ip-noise${i}`), {}, { 'x-test-ip': ip })).status).toBe(204);
			await sleep(500);

			const res = await requestLink(email, {}, { 'x-test-ip': ip });
			expect(res.status).toBe(429);
			expect(errorCode(res)).toBe('REQUESTS_EXCEEDED');

			const retryAfter = Number(res.headers.get('retry-after'));
			expect(retryAfter).toBeGreaterThan(0);
			expect(retryAfter).toBeLessThanOrEqual(3600);

			// Refused before anything account-related ran
			await sleep(500);
			expect(await events(email)).toHaveLength(0);
		});

		it('holds the per-IP limit against simultaneous requests', async () => {
			const ip = randomIp();
			const burst = await Promise.all(Array.from({ length: 30 }, (_, i) => requestLink(address(`ip-burst${i}`), {}, { 'x-test-ip': ip })));
			const statuses = burst.map((res) => res.status);

			expect(statuses.filter((status) => status === 204).length).toBeLessThanOrEqual(5);
			expect(statuses.filter((status) => status === 429).length).toBeGreaterThanOrEqual(25);
		});

		it('holds the per-email limit against simultaneous requests', async () => {
			const email = address('email-burst');
			await createUser(email);

			await Promise.all(Array.from({ length: 20 }, () => requestLink(email)));
			await waitForRequestEvent(email, 20);

			// Every request is recorded before any is counted, so a burst may be refused entirely, never over-admitted
			expect((await events(email)).filter((event) => event['reason'] === 'rate_limited').length).toBeGreaterThanOrEqual(17);
			expect((await mailsTo(email)).length).toBeLessThanOrEqual(3);
		});
	});

	describe('email', () => {
		it('sends the built-in Liquid template with the configured sender and subject', async () => {
			const email = address('mail');
			await createUser(email, { first_name: 'Jane' });
			await requestLink(email);

			const [mail] = await waitForMails(email);
			const senderName = compareVersions(directusVersion, '11.10.0') >= 0 ? 'Acme Login' : 'Directus';

			expect(mail!.From).toMatchObject({ Name: senderName, Address: 'login@acme.test' });
			expect(mail!.Subject).toBe('Directus sign-in for Jane');
			expect(mail!.HTML).toContain('Hi Jane');
			expect(mail!.HTML).toContain(linkFrom(mail!).toString().replace(/&/g, '&amp;'));
			expect(mail!.Text).toContain('can be used once');
			expect(linkFrom(mail!).origin + linkFrom(mail!).pathname).toBe(`${DIRECTUS}/magic-link/verify`);
		});

		it('renders a custom template from EMAIL_TEMPLATES_PATH through Directus, with the base layout', async () => {
			const file = path.join(TEMPLATES, 'magic-link.liquid');

			await writeFile(
				file,
				'{% layout "base" %}{% block content %}<p>CUSTOM {{ user.first_name }} {{ fixtureGreeting }} {{ expiresInMinutes }}</p><a href="{{ url }}">go</a>{% endblock %}',
			);

			try {
				const email = address('custom-template');
				await createUser(email, { first_name: 'Kim' });
				await requestLink(email);

				const [mail] = await waitForMails(email);
				expect(mail!.HTML).toContain('CUSTOM Kim hello-from-filter 15');
				expect(mail!.HTML).toContain('Email Service');
			} finally {
				await rm(file, { force: true });
			}
		});

		it('links to an allow-listed frontend when redirect_url is given', async () => {
			const email = address('frontend');
			await createUser(email);
			await requestLink(email, { redirect_url: 'http://localhost:3000/auth/magic' });

			const link = linkFrom((await waitForMails(email))[0]!);
			expect(`${link.origin}${link.pathname}`).toBe('http://localhost:3000/auth/magic');
			expect(link.searchParams.get('token')).toMatch(/^[\w-]{43}$/);
		});
	});

	describe('localization', () => {
		it('emails a fr-FR user in French with the fr-FR subject', async () => {
			const email = address('fr');
			await createUser(email, { first_name: 'Élise', language: 'fr-FR' });
			await requestLink(email);

			const [mail] = await waitForMails(email);
			expect(mail!.Subject).toBe('Connexion Directus pour Élise');
			expect(mail!.HTML).toContain('<html lang="fr-FR">');
			expect(mail!.HTML).toContain('Bonjour Élise,');
			expect(mail!.HTML).toContain('Se connecter');
			expect(mail!.Text).toContain("ne peut être utilisé qu'une seule fois");
		});

		it('matches a regional variant to the shipped language (fr-CA -> fr-FR)', async () => {
			const email = address('fr-ca');
			await createUser(email, { language: 'fr-CA' });
			await requestLink(email);

			expect((await waitForMails(email))[0]!.HTML).toContain('Se connecter');
		});

		it('falls back to en-US for a language that is not set up', async () => {
			const email = address('de');
			await createUser(email, { first_name: 'Jonas', language: 'de-DE' });
			await requestLink(email);

			const [mail] = await waitForMails(email);
			expect(mail!.Subject).toBe('Directus sign-in for Jonas');
			expect(mail!.HTML).toContain('<html lang="en-US">');
			expect(mail!.HTML).toContain('Hi Jonas,');
		});

		it('uses the project default language when the user has none', async () => {
			const email = address('project-default');
			await createUser(email, { language: null });
			await admin('/settings', 'PATCH', { default_language: 'fr-FR' });

			try {
				await requestLink(email);
				expect((await waitForMails(email))[0]!.HTML).toContain('Se connecter');
			} finally {
				await admin('/settings', 'PATCH', { default_language: 'en-US' });
			}
		});

		it('prefers a localized custom template and falls back for other languages', async () => {
			const file = path.join(TEMPLATES, 'magic-link.fr.liquid');
			await writeFile(
				file,
				'{% layout "base" %}{% block content %}<p>MODELE-FR {{ locale }} {{ t.button }}</p><a href="{{ url }}">go</a>{% endblock %}',
			);

			try {
				const fr = address('custom-fr');
				const en = address('custom-en');
				await createUser(fr, { language: 'fr-FR' });
				await createUser(en, { language: 'en-US' });
				await requestLink(fr);
				await requestLink(en);

				expect((await waitForMails(fr))[0]!.HTML).toContain('MODELE-FR fr-FR Se connecter');

				const english = (await waitForMails(en))[0]!.HTML;
				expect(english).not.toContain('MODELE-FR');
				expect(english).toContain('Sign in');
			} finally {
				await rm(file, { force: true });
			}
		});

		it('shows the confirmation page in the user language', async () => {
			const email = address('fr-page');
			await createUser(email, { language: 'fr-FR' });
			const token = await newToken(email);

			const page = await call(`/magic-link/verify?token=${token}`, { headers: { 'accept-language': 'en-US' } });
			expect(page.text).toContain('<html lang="fr-FR">');
			expect(page.text).toContain('Se connecter');
			expect(page.text).toContain('name="locale" value="fr-FR"');
		});

		it('shows the request page in the browser language, else the project default', async () => {
			expect((await call('/magic-link', { headers: { 'accept-language': 'fr-CH,fr;q=0.9,en;q=0.5' } })).text).toContain(
				'Recevoir un lien de connexion',
			);
			expect((await call('/magic-link', { headers: { 'accept-language': 'de-DE' } })).text).toContain('Email me a sign-in link');
			expect((await call('/magic-link?lang=fr-FR')).text).toContain('Recevoir un lien de connexion');
		});

		it('keeps the page language across form posts', async () => {
			const res = await call('/magic-link/request', {
				form: { email: address('fr-post'), locale: 'fr-FR' },
				headers: { origin: DIRECTUS },
			});
			expect(res.text).toContain('Consultez vos e-mails');

			const invalid = await call('/magic-link/request', { form: { email: 'nope', locale: 'fr-FR' }, headers: { origin: DIRECTUS } });
			expect(invalid.text).toContain('Saisissez une adresse e-mail valide.');
		});
	});

	describe('verify (API)', () => {
		it('issues standard Directus tokens that work with core refresh and logout', async () => {
			const email = address('json');
			const id = await createUser(email);
			const token = await newToken(email);

			const res = await verify(token, { mode: 'json' });
			expect(res.status).toBe(200);

			const { access_token, refresh_token, expires } = res.json!['data'];
			expect(expires).toBeGreaterThan(0);

			expect(jwtUserId(access_token)).toBe(id);
			expect((await call('/server/info', { token: access_token })).status).toBe(200);

			const refreshed = await call('/auth/refresh', { body: { refresh_token, mode: 'json' } });
			expect(refreshed.status).toBe(200);

			const next = refreshed.json!['data'].refresh_token;
			expect((await call('/auth/logout', { body: { refresh_token: next, mode: 'json' } })).status).toBeLessThan(300);
			expect((await call('/auth/refresh', { body: { refresh_token: next, mode: 'json' } })).status).toBe(401);
		});

		it('records the login in the activity log', async () => {
			const email = address('activity');
			const id = await createUser(email);
			await verify(await newToken(email));

			const activity = await admin(`/activity?filter[action][_eq]=login&filter[user][_eq]=${id}`);
			expect(activity).toHaveLength(1);
		});

		it('is single-use', async () => {
			const email = address('reuse');
			await createUser(email);
			const token = await newToken(email);

			expect((await verify(token)).status).toBe(200);

			const again = await verify(token);
			expect(again.status).toBe(403);
			expect(errorCode(again)).toBe('INVALID_TOKEN');
		});

		it('lets only one of two simultaneous uses succeed', async () => {
			const email = address('race');
			await createUser(email);
			const token = await newToken(email);

			const statuses = (await Promise.all([verify(token), verify(token), verify(token)])).map((res) => res.status).sort();
			expect(statuses).toEqual([200, 403, 403]);
		});

		it('invalidates older links when a new one is requested', async () => {
			const email = address('supersede');
			await createUser(email);

			await requestLink(email);
			await waitForMails(email, 1);
			await requestLink(email);
			await waitForMails(email, 2);

			const mails = (await mailsTo(email)).map((mail) => linkFrom(mail).searchParams.get('token')!);
			const results = await Promise.all(mails.map((token) => verify(token).then((res) => res.status)));
			expect(results.sort()).toEqual([200, 403]);
		});

		it('rejects expired links', async () => {
			const email = address('expired');
			await createUser(email);
			const token = await newToken(email);

			await call('/magic-link-test/expire', { body: { email } });

			const res = await verify(token);
			expect(res.status).toBe(401);
			expect(errorCode(res)).toBe('TOKEN_EXPIRED');
		});

		it('says why a link stops working when the account changes, and works again once reactivated', async () => {
			const email = address('suspend-later');
			const id = await createUser(email);
			const token = await newToken(email);

			await admin(`/users/${id}`, 'PATCH', { status: 'suspended' });
			expect(errorCode(await verify(token))).toBe('USER_SUSPENDED');

			await admin(`/users/${id}`, 'PATCH', { status: 'archived' });
			expect(errorCode(await verify(token))).toBe('USER_INACTIVE');

			await admin(`/users/${id}`, 'PATCH', { status: 'active' });
			expect((await verify(token)).status).toBe(200);
		});

		it('refuses a link when the account email changed after it was sent', async () => {
			const email = address('email-change');
			const id = await createUser(email);
			const token = await newToken(email);

			await admin(`/users/${id}`, 'PATCH', { email: address('email-changed') });
			expect(errorCode(await verify(token))).toBe('INVALID_TOKEN');
		});

		it('lets a magic-link.login hook veto the login without burning the link', async () => {
			const email = `veto-${RUN}@example.com`;
			await createUser(email);
			const token = await newToken(email);

			const res = await verify(token);
			expect(res.status).toBe(403);
			expect(errorCode(res)).toBe('FORBIDDEN');
			expect((await events(email)).filter((event) => event['type'] === 'login')).toContainEqual(
				expect.objectContaining({ status: 'fail' }),
			);
		});

		it('requires the authenticator code for users with 2FA', async () => {
			const email = address('tfa');
			await createUser(email);

			const secret = await enableTfa(email);

			const token = await newToken(email);

			const missing = await verify(token);
			expect(missing.json!['errors'][0].extensions.code).toBe('INVALID_OTP');

			const wrong = await verify(token, { otp: totp(secret, 10) });
			expect(wrong.json!['errors'][0].extensions.code).toBe('INVALID_OTP');

			const ok = await verify(token, { otp: totp(secret) });
			expect(ok.status).toBe(200);
		});

		it('stops a link after 5 wrong 2FA codes', async () => {
			const email = address('otp-lock');
			await createUser(email);
			const secret = await enableTfa(email);
			const token = await newToken(email);

			for (let i = 0; i < 4; i++) expect(errorCode(await verify(token, { otp: totp(secret, 100 + i) }))).toBe('INVALID_OTP');

			const fifth = await verify(token, { otp: totp(secret, 104) });
			expect(fifth.status).toBe(403);
			expect(errorCode(fifth)).toBe('OTP_LIMIT_EXCEEDED');

			expect(errorCode(await verify(token, { otp: totp(secret) }))).toBe('OTP_LIMIT_EXCEEDED');
		});

		it('holds the 2FA limit against simultaneous guesses', async () => {
			const email = address('otp-burst');
			const id = await createUser(email);
			const secret = await enableTfa(email);
			const token = await newToken(email);

			const guesses = await Promise.all(Array.from({ length: 30 }, (_, i) => verify(token, { otp: totp(secret, 100 + i) })));
			const codes = guesses.map(errorCode);

			expect(codes.filter((code) => code === 'INVALID_OTP').length).toBeLessThan(5);
			expect(codes.filter((code) => code === 'OTP_LIMIT_EXCEEDED').length).toBeGreaterThan(25);
			expect(errorCode(await verify(token, { otp: totp(secret) }))).toBe('OTP_LIMIT_EXCEEDED');
			expect((await admin(`/users/${id}?fields=status`)).status).toBe('active');
		});

		it('suspends the account after auth_login_attempts wrong codes in a row, like /auth/login', async () => {
			const email = address('otp-suspend');
			const id = await createUser(email);
			const secret = await enableTfa(email);
			await admin('/settings', 'PATCH', { auth_login_attempts: 7 });

			try {
				const first = await newToken(email);
				for (let i = 0; i < 5; i++) await verify(first, { otp: totp(secret, 100 + i) });

				const second = await newToken(email, 2);
				expect(errorCode(await verify(second, { otp: totp(secret, 110) }))).toBe('INVALID_OTP');
				expect((await admin(`/users/${id}?fields=status`)).status).toBe('active');

				expect(errorCode(await verify(second, { otp: totp(secret, 111) }))).toBe('INVALID_OTP');
				expect((await admin(`/users/${id}?fields=status`)).status).toBe('suspended');
				expect(errorCode(await verify(second, { otp: totp(secret) }))).toBe('USER_SUSPENDED');
			} finally {
				await admin('/settings', 'PATCH', { auth_login_attempts: 25 });
			}
		});

		it('starts counting wrong codes again after a successful sign-in', async () => {
			const email = address('otp-reset');
			const id = await createUser(email);
			const secret = await enableTfa(email);
			await admin('/settings', 'PATCH', { auth_login_attempts: 7 });

			try {
				const first = await newToken(email);
				for (let i = 0; i < 4; i++) await verify(first, { otp: totp(secret, 100 + i) });
				expect((await verify(first, { otp: totp(secret) })).status).toBe(200);

				const second = await newToken(email, 2);
				for (let i = 0; i < 4; i++) await verify(second, { otp: totp(secret, 110 + i) });
				expect((await admin(`/users/${id}?fields=status`)).status).toBe('active');
			} finally {
				await admin('/settings', 'PATCH', { auth_login_attempts: 25 });
			}
		});

		it('supports cookie mode like /auth/login', async () => {
			const email = address('cookie');
			await createUser(email);

			const res = await verify(await newToken(email), { mode: 'cookie' });
			const refresh = cookie(res.headers, 'directus_refresh_token');

			expect(res.json!['data'].access_token).toBeTruthy();
			expect(res.json!['data'].refresh_token).toBeUndefined();
			expect(refresh).toBeTruthy();

			const refreshed = await call('/auth/refresh', { body: { mode: 'cookie' }, headers: { cookie: `directus_refresh_token=${refresh}` } });
			expect(refreshed.status).toBe(200);
		});

		it('supports session mode like /auth/login', async () => {
			const email = address('session');
			const id = await createUser(email);

			const res = await verify(await newToken(email), { mode: 'session' });
			const session = cookie(res.headers, 'directus_session_token');

			expect(res.json!['data'].access_token).toBeUndefined();
			expect(jwtUserId(session)).toBe(id);

			const refreshed = await call('/auth/refresh', {
				body: { mode: 'session' },
				headers: { cookie: `directus_session_token=${session}` },
			});
			expect(refreshed.status).toBe(200);
		});

		it('validates the payload', async () => {
			expect((await verify('')).status).toBe(400);
			expect((await verify('abc', { mode: 'weird' })).status).toBe(400);
			expect(errorCode(await verify('abc'))).toBe('INVALID_TOKEN');
		});
	});

	describe('pages', () => {
		it('serves the request form and the check-your-email page', async () => {
			expect((await call('/magic-link')).text).toContain('<form method="post"');

			const email = address('page-request');
			await createUser(email);

			const res = await call('/magic-link/request', { form: { email, redirect: '/admin/content' }, headers: { origin: DIRECTUS } });
			expect(res.text).toContain('Check your email');

			const link = linkFrom((await waitForMails(email))[0]!);
			expect(link.searchParams.get('redirect')).toBe('/admin/content');
		});

		it('decodes UTF-8 form posts intact', async () => {
			const email = address('page-utf8');
			await createUser(email);

			const redirect = `/admin/content?q=${'été-ß-日本'.repeat(400)}`;
			await call('/magic-link/request', { form: { email, redirect }, headers: { origin: DIRECTUS } });

			expect(linkFrom((await waitForMails(email))[0]!).searchParams.get('redirect')).toBe(redirect);
		});

		it('drops unsafe redirects from requested links', async () => {
			const email = address('page-open-redirect');
			await createUser(email);
			await call('/magic-link/request', { form: { email, redirect: '//evil.com' }, headers: { origin: DIRECTUS } });

			expect(linkFrom((await waitForMails(email))[0]!).searchParams.has('redirect')).toBe(false);
		});

		it('shows a confirmation page without consuming the link', async () => {
			const email = address('page-confirm');
			await createUser(email);
			const token = await newToken(email);

			for (let i = 0; i < 3; i++) {
				const page = await call(`/magic-link/verify?token=${token}`);
				expect(page.status).toBe(200);
				expect(page.text).toContain('<button type="submit">Sign in</button>');
				expect(page.headers.get('cache-control')).toBe('no-store');
			}

			expect((await verify(token)).status).toBe(200);

			const used = await call(`/magic-link/verify?token=${token}`);
			expect(used.status).toBe(403);
			expect(used.text).toContain('This link can&#39;t be used');
			expect(used.text).toContain('Request a new link');
		});

		it('explains expired links and inactive accounts on the page', async () => {
			const expired = address('page-expired');
			await createUser(expired);
			const expiredToken = await newToken(expired);
			await call('/magic-link-test/expire', { body: { email: expired } });

			const expiredPage = await call(`/magic-link/verify?token=${expiredToken}`);
			expect(expiredPage.status).toBe(401);
			expect(expiredPage.text).toContain('This link has expired');

			const suspended = address('page-suspended');
			const id = await createUser(suspended, { language: 'fr-FR' });
			const suspendedToken = await newToken(suspended);
			await admin(`/users/${id}`, 'PATCH', { status: 'suspended' });

			const suspendedPage = await call(`/magic-link/verify?token=${suspendedToken}`);
			expect(suspendedPage.status).toBe(401);
			expect(suspendedPage.text).toContain('Votre compte est suspendu');
			expect(suspendedPage.text).not.toContain('Demander un nouveau lien');

			const res = await call('/magic-link/verify', { form: { token: suspendedToken, locale: 'fr-FR' }, headers: { origin: DIRECTUS } });
			expect(res.text).toContain('Votre compte est suspendu');
		});

		it('shows the too-many-attempts message on the request page', async () => {
			const ip = randomIp();
			for (let i = 0; i < 5; i++) await requestLink(address(`page-ip${i}`), {}, { 'x-test-ip': ip });
			await sleep(500);

			const res = await call('/magic-link/request', {
				form: { email: address('page-ip') },
				headers: { origin: DIRECTUS, 'x-test-ip': ip },
			});
			expect(res.status).toBe(429);
			expect(res.text).toContain('Too many attempts. Try again later.');
		});

		it('signs a Data Studio admin in with a session cookie and redirects', async () => {
			await requestLink('admin@example.com');
			const token = await tokenFor('admin@example.com');

			const res = await call('/magic-link/verify', {
				form: { token, redirect: '/admin/content' },
				headers: { origin: DIRECTUS, 'sec-fetch-site': 'same-origin' },
			});
			expect(res.status).toBe(303);
			expect(res.headers.get('location')).toBe('/admin/content');

			const session = cookie(res.headers, 'directus_session_token');
			const me = await call('/users/me', { headers: { cookie: `directus_session_token=${session}` } });
			expect(me.json!['data'].email).toBe('admin@example.com');
		});

		it('falls back to the default redirect for unsafe targets', async () => {
			const email = address('page-default-redirect');
			await createUser(email);
			const token = await newToken(email);

			const res = await call('/magic-link/verify', { form: { token, redirect: 'https://evil.com' }, headers: { origin: DIRECTUS } });
			expect(res.headers.get('location')).toBe('/admin');
		});

		it('asks for the 2FA code on the confirmation page', async () => {
			const email = address('page-tfa');
			await createUser(email);

			const secret = await enableTfa(email);

			const token = await newToken(email);
			expect((await call(`/magic-link/verify?token=${token}`)).text).toContain('name="otp"');

			const wrong = await call('/magic-link/verify', { form: { token, otp: '000000' }, headers: { origin: DIRECTUS } });
			expect(wrong.status).toBe(401);
			expect(wrong.text).toContain('That code is not valid');

			const ok = await call('/magic-link/verify', { form: { token, otp: totp(secret) }, headers: { origin: DIRECTUS } });
			expect(ok.status).toBe(303);
		});

		it.each([
			['a foreign Origin', { origin: 'https://evil.com' }],
			['Origin: null', { origin: 'null' }],
			['a cross-site fetch', { 'sec-fetch-site': 'cross-site' }],
		])('refuses form posts from %s', async (_label, headers) => {
			const email = address(`csrf-${randomInt(1e6)}`);
			await createUser(email);
			const token = await newToken(email);

			expect((await call('/magic-link/verify', { form: { token }, headers })).status).toBe(400);
			expect((await verify(token)).status).toBe(200);
		});

		it('shows the invalid-link page for unknown or missing tokens', async () => {
			for (const path of ['/magic-link/verify?token=nope', '/magic-link/verify']) {
				const page = await call(path);
				expect(page.status).toBe(403);
				expect(page.text).toContain('This link can&#39;t be used');
			}
		});
	});
});

// A default Directus: built-in pages off and PUBLIC_URL left at "/"
describe.runIf(MODE === 'defaults')(`${SUITE} (defaults)`, () => {
	it('serves no pages', async () => {
		for (const path of ['/magic-link', '/magic-link/verify?token=x']) {
			expect((await call(path)).status).toBe(404);
		}

		const form = await call('/magic-link/request', { form: { email: address('form') }, headers: { origin: DIRECTUS } });
		expect(form.status).toBe(404);
	});

	it('requires redirect_url, so no email ever links to a missing page', async () => {
		const email = address('no-redirect');
		await createUser(email);

		const res = await requestLink(email);
		expect(res.status).toBe(400);
		expect(errorCode(res)).toBe('INVALID_PAYLOAD');
		expect(res.json!['errors'][0].message).toContain('redirect_url');

		await sleep(1000);
		expect(await mailsTo(email)).toHaveLength(0);
	});

	it('signs in through your website', async () => {
		const email = address('website');
		const id = await createUser(email);
		await requestLink(email, { redirect_url: 'http://localhost:3000/auth/magic' });

		const link = linkFrom((await waitForMails(email))[0]!);
		expect(`${link.origin}${link.pathname}`).toBe('http://localhost:3000/auth/magic');

		const res = await verify(link.searchParams.get('token')!, { mode: 'json' });
		expect(res.status).toBe(200);
		expect(jwtUserId(res.json!['data'].access_token)).toBe(id);
	});

	it('leaves the logo out of emails instead of linking a broken image', async () => {
		const email = address('logo');
		await createUser(email);
		await requestLink(email, { redirect_url: 'http://localhost:3000/auth/magic' });

		expect((await waitForMails(email))[0]!.HTML).not.toContain('<img');
	});
});

// Built-in pages on, but PUBLIC_URL left at "/"
describe.runIf(MODE === 'nourl')(`${SUITE} (pages on, no PUBLIC_URL)`, () => {
	it('explains why the pages are unavailable', async () => {
		for (const path of ['/magic-link', '/magic-link/verify?token=x']) {
			const res = await call(path);
			expect(res.status).toBe(503);
			expect(errorCode(res)).toBe('SERVICE_UNAVAILABLE');
			expect(res.json!['errors'][0].message).toContain('PUBLIC_URL');
		}
	});

	it('refuses requests that would link to the pages, without sending anything', async () => {
		const email = address('nourl-pages');
		await createUser(email);

		const res = await requestLink(email);
		expect(res.status).toBe(503);
		expect(res.json!['errors'][0].message).toContain('redirect_url');

		await sleep(1000);
		expect(await mailsTo(email)).toHaveLength(0);
	});

	it('still signs in through your website', async () => {
		const email = address('nourl-website');
		const id = await createUser(email);
		expect((await requestLink(email, { redirect_url: 'http://localhost:3000/auth/magic' })).status).toBe(204);

		const link = linkFrom((await waitForMails(email))[0]!);
		const res = await verify(link.searchParams.get('token')!, { mode: 'json' });
		expect(jwtUserId(res.json!['data'].access_token)).toBe(id);
	});
});
