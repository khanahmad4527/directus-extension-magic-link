import { existsSync } from 'node:fs';
import path from 'node:path';
import type { Accountability, EndpointExtensionContext } from '@directus/types';
import { Liquid } from 'liquidjs';
import type { MagicLinkConfig } from '../shared/config.js';
import type { ExtensionEmitter } from '../shared/emitter.js';
import { FALLBACK_LOCALE, localeVariants, negotiateLocale, renderMessages } from '../shared/i18n.js';
import { compareVersions } from '../shared/rules.js';
import { readSettings } from '../shared/settings.js';
import { INACTIVE_HTML_TEMPLATE, INACTIVE_TEXT_TEMPLATE, LINK_HTML_TEMPLATE, LINK_TEXT_TEMPLATE } from './templates.js';

type Sender = string | { name: string; address: string } | undefined;

/** `link` carries the sign-in link; `inactive` tells the owner of an inactive account why no link came. */
export type EmailKind = 'link' | 'inactive';

export type MagicLinkEmail = {
	kind: EmailKind;
	to: string;
	locale: string;
	subject: string | Record<string, string> | null;
	from: Sender;
	templateData: Record<string, unknown>;
};

type TemplateUser = { id: string; email: string; first_name: string | null; last_name: string | null; language: string | null };

export function createMailer(config: MagicLinkConfig, context: EndpointExtensionContext) {
	const { services, database, getSchema, logger } = context;
	const emitter = context.emitter as ExtensionEmitter;
	const { MailService, ServerService } = services;
	const templatesDir = path.resolve(config.emailTemplatesPath);
	const liquid = new Liquid({ root: [templatesDir], extname: '.liquid' });

	let senderObjectSupport: Promise<boolean> | undefined;

	const render = async (template: string, data: object): Promise<string> => String(await liquid.parseAndRender(template, data));

	function templateExists(name: string): boolean {
		const file = path.resolve(templatesDir, `${name}.liquid`);
		return file.startsWith(templatesDir + path.sep) && existsSync(file);
	}

	const KINDS = {
		link: { template: config.emailTemplate, subject: config.emailSubject, html: LINK_HTML_TEMPLATE, text: LINK_TEXT_TEMPLATE },
		inactive: {
			template: `${config.emailTemplate}-inactive`,
			subject: config.inactiveEmailSubject,
			html: INACTIVE_HTML_TEMPLATE,
			text: INACTIVE_TEXT_TEMPLATE,
		},
	} as const;

	// magic-link.fr-FR.liquid, magic-link.fr.liquid, then the same for en-US, then magic-link.liquid
	function findCustomTemplate(name: string, locale: string): string | null {
		const suffixes = [...new Set([...localeVariants(locale), ...localeVariants(FALLBACK_LOCALE)])];
		const candidates = [...suffixes.map((suffix) => `${name}.${suffix}`), name];
		return candidates.find(templateExists) ?? null;
	}

	function pickSubject(subject: MagicLinkEmail['subject'], locale: string): string | null {
		if (typeof subject === 'string') return subject;
		if (!subject) return null;

		const match = negotiateLocale([locale, FALLBACK_LOCALE], Object.keys(subject));
		return match ? (subject[match] ?? null) : null;
	}

	// MailService accepts `from: { name, address }` since Directus 11.10; older versions only take an address.
	// Looked up once per process; a failed lookup isn't cached, so the next email retries it.
	function supportsSenderObject(): Promise<boolean> {
		senderObjectSupport ??= (async () => {
			const accountability = { user: 'magic-link', role: null, roles: [], admin: true, app: true, ip: null } as unknown as Accountability;
			const server = new ServerService({ schema: await getSchema(), knex: database, accountability });
			const info = await server.serverInfo();
			const supported = typeof info['version'] === 'string' && compareVersions(info['version'], '11.10.0') >= 0;

			if (!supported) logger.warn('[magic-link] A custom sender name needs Directus 11.10 or newer; emails use the project name');

			return supported;
		})().catch((error: unknown) => {
			senderObjectSupport = undefined;
			logger.warn(error, '[magic-link] Could not read the Directus version; sending with the project name');
			return false;
		});

		return senderObjectSupport;
	}

	async function resolveSender(projectName: string): Promise<Sender> {
		if (!config.emailFrom && !config.emailFromName) return undefined;

		const [, parsedName = '', parsedAddress = config.emailFrom] = /^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/.exec(config.emailFrom) ?? [];
		const address = parsedAddress.trim();
		const name = config.emailFromName || parsedName.trim();

		if (!name || name === projectName) return address || undefined;

		if (!(await supportsSenderObject())) return address || undefined;

		return { name, address: address || config.defaultEmailFrom };
	}

	// Same variables and fallbacks as MailService.getDefaultTemplateData() in core
	async function getSettings() {
		const settings = await readSettings(database);
		const logoPath = settings.projectLogo ? `assets/${settings.projectLogo}` : 'admin/img/directus-white.png';

		return {
			defaultLanguage: settings.defaultLanguage,
			templateDefaults: {
				projectName: settings.projectName,
				projectColor: settings.projectColor ?? '#171717',
				// Relative without a full PUBLIC_URL, exactly like Directus' own emails
				projectLogo: `${config.publicUrl ?? ''}/${logoPath}`,
				projectUrl: settings.projectUrl,
			},
		};
	}

	async function send(
		kind: EmailKind,
		input: { to: string; user: TemplateUser; url?: string; expiresAt?: Date; ip: string | null; userAgent: string | null },
	) {
		const { defaultLanguage, templateDefaults } = await getSettings();
		const definition = KINDS[kind];

		let email: MagicLinkEmail = {
			kind,
			to: input.to,
			// A null user language means "project default", as in the Data Studio
			locale: input.user.language || defaultLanguage || FALLBACK_LOCALE,
			subject: definition.subject,
			from: await resolveSender(templateDefaults.projectName),
			templateData: {
				...templateDefaults,
				email: input.to,
				user: input.user,
				ip: input.ip,
				userAgent: input.userAgent,
				...(input.url && input.expiresAt
					? {
							url: input.url,
							expiresAt: input.expiresAt.toISOString(),
							expiresInMinutes: Math.max(1, Math.round((input.expiresAt.getTime() - Date.now()) / 60_000)),
						}
					: {}),
			},
		};

		email = await emitter.emitFilter('magic-link.email', email, { user: input.user });

		const t = renderMessages(liquid, negotiateLocale([email.locale]) ?? FALLBACK_LOCALE, email.templateData);
		const data = { ...email.templateData, locale: email.locale, t };
		const fallbackSubject = kind === 'link' ? t.subject : t.inactiveSubject;
		const subject = (await render(pickSubject(email.subject, email.locale) ?? fallbackSubject, data)).trim();
		const template = findCustomTemplate(definition.template, email.locale);
		const mailService = new MailService({ schema: await getSchema(), knex: database });

		// A template in EMAIL_TEMPLATES_PATH is rendered by Directus itself, so `{% layout "base" %}` works
		const message = template
			? { template: { name: template, data } }
			: { html: await render(definition.html, data), text: await render(definition.text, data) };

		const info: unknown = await mailService.send({ to: email.to, from: email.from as string | undefined, subject, ...message });

		// null means an `email.send` filter cancelled it
		return info === null ? 'cancelled' : 'sent';
	}

	return { send };
}
