import type { EndpointExtensionContext } from '@directus/types';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readConfig } from '../../src/shared/config.js';
import { createMailer } from '../../src/endpoint/mailer.js';

const sent: Record<string, any>[] = [];
const serverInfo = vi.fn();

class MailService {
	send(options: Record<string, any>) {
		sent.push(options);
		return Promise.resolve({ messageId: 'x' });
	}
}

class ServerService {
	serverInfo() {
		return serverInfo();
	}
}

const settings = { project_name: 'Acme', project_logo: null, project_color: '#123456', project_url: null, default_language: 'en-US' };
const database = () => ({ select: () => ({ first: () => Promise.resolve(settings) }) });

function mailer(env: Record<string, unknown>) {
	const context = {
		services: { MailService, ServerService },
		database,
		emitter: { emitFilter: (_event: string, payload: unknown) => Promise.resolve(payload) },
		getSchema: () => Promise.resolve({}),
		logger: { warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
		env,
	} as unknown as EndpointExtensionContext;

	return createMailer(readConfig({ EMAIL_TEMPLATES_PATH: '/nonexistent', ...env }), context);
}

const input = (language: string | null = null) => ({
	to: 'jane@acme.com',
	user: { id: '1', email: 'jane@acme.com', first_name: 'Jane', last_name: null, language },
	url: 'https://cms.acme.com/magic-link/verify?token=abc',
	expiresAt: new Date(Date.now() + 15 * 60_000),
	ip: null,
	userAgent: null,
});

beforeEach(() => {
	sent.length = 0;
	serverInfo.mockReset();
});

describe('mailer', () => {
	it("hands the message to Directus' MailService", async () => {
		await mailer({}).send('link', input());

		expect(sent).toHaveLength(1);
		expect(sent[0]).toMatchObject({ to: 'jane@acme.com', from: undefined, subject: 'Sign in to Acme' });
		expect(sent[0]!['html']).toContain('https://cms.acme.com/magic-link/verify?token=abc');
		expect(sent[0]!['text']).toContain('Hi Jane,');
	});

	it('does not look up the Directus version without a custom sender name', async () => {
		await mailer({ MAGIC_LINK_EMAIL_FROM: 'login@acme.com' }).send('link', input());

		expect(serverInfo).not.toHaveBeenCalled();
		expect(sent[0]!['from']).toBe('login@acme.com');
	});

	it('looks the version up once and reuses it', async () => {
		serverInfo.mockResolvedValue({ version: '12.4.0' });
		const instance = mailer({ MAGIC_LINK_EMAIL_FROM: 'Acme Login <login@acme.com>' });

		await instance.send('link', input());
		await instance.send('link', input());
		await instance.send('link', input());

		expect(serverInfo).toHaveBeenCalledTimes(1);
		expect(sent.map((mail) => mail['from'])).toEqual(Array(3).fill({ name: 'Acme Login', address: 'login@acme.com' }));
	});

	it('sends a bare address on Directus before 11.10', async () => {
		serverInfo.mockResolvedValue({ version: '11.9.3' });
		await mailer({ MAGIC_LINK_EMAIL_FROM: 'Acme Login <login@acme.com>' }).send('link', input());

		expect(sent[0]!['from']).toBe('login@acme.com');
	});

	it('retries the lookup after a failure instead of caching it', async () => {
		serverInfo.mockRejectedValueOnce(new Error('db down')).mockResolvedValue({ version: '12.4.0' });
		const instance = mailer({ MAGIC_LINK_EMAIL_FROM: 'Acme Login <login@acme.com>' });

		await instance.send('link', input());
		await instance.send('link', input());
		await instance.send('link', input());

		expect(serverInfo).toHaveBeenCalledTimes(2);
		expect(sent.map((mail) => mail['from'])).toEqual([
			'login@acme.com',
			{ name: 'Acme Login', address: 'login@acme.com' },
			{ name: 'Acme Login', address: 'login@acme.com' },
		]);
	});

	it('localizes the built-in email', async () => {
		await mailer({}).send('link', input('fr-FR'));

		expect(sent[0]!['subject']).toBe('Connexion à Acme');
		expect(sent[0]!['text']).toContain('Bonjour Jane,');
	});

	it('tells the owner of an inactive account, in their language, without a link', async () => {
		await mailer({}).send('inactive', { to: 'jane@acme.com', user: input('fr-FR').user, ip: null, userAgent: null });

		expect(sent[0]!['subject']).toBe("Votre compte Acme n'est pas actif");
		expect(sent[0]!['text']).toContain("ce compte Acme n'est pas actif");
		expect(sent[0]!['html']).not.toContain('token=');
	});

	it('leaves out the logo when PUBLIC_URL is not a full address, instead of linking a broken image', async () => {
		await mailer({ PUBLIC_URL: '/' }).send('link', input());
		expect(sent[0]!['html']).not.toContain('<img');

		await mailer({ PUBLIC_URL: 'https://cms.acme.com' }).send('link', input());
		expect(sent[1]!['html']).toContain('<img src="https://cms.acme.com/admin/img/directus-white.png"');
	});
});
