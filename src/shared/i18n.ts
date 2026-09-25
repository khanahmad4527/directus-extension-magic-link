import type { Liquid } from 'liquidjs';

export const FALLBACK_LOCALE = 'en-US';

// Values are Liquid templates rendered with the email/page data.
const MESSAGES = {
	'en-US': {
		subject: 'Sign in to {{ projectName }}',
		heading: 'Sign in to {{ projectName }}',
		greeting: 'Hi{% if user.first_name %} {{ user.first_name }}{% endif %},',
		intro: 'Click the button below to sign in as {{ email }}.',
		button: 'Sign in',
		expiry:
			'This link expires in {{ expiresInMinutes }} {% if expiresInMinutes == 1 %}minute{% else %}minutes{% endif %} and can be used once.',
		ignore: "If you didn't ask to sign in, you can ignore this email.",
		fallbackLink: "If the button doesn't work, paste this address into your browser:",
		textIntro: 'Open this link to sign in as {{ email }}:',

		inactiveSubject: 'Your {{ projectName }} account is not active',
		inactiveHeading: "We couldn't sign you in",
		inactiveIntro:
			"Someone asked for a sign-in link for {{ email }}, but this {{ projectName }} account isn't active, so no link was sent.",
		inactiveAction: 'If you need access, contact your administrator.',

		pageRequestTitle: 'Sign in',
		pageRequestHeading: 'Sign in to {{ projectName }}',
		pageRequestIntro: "Enter your email address and we'll send you a link to sign in.",
		pageEmailLabel: 'Email',
		pageRequestButton: 'Email me a sign-in link',
		pageInvalidEmail: 'Enter a valid email address.',
		pageSentTitle: 'Check your email',
		pageSentIntro: 'If that address belongs to an account, a sign-in link is on its way. The link can be used once.',
		pageSentRestart: 'Use a different email',
		pageConfirmTitle: 'Confirm sign in',
		pageConfirmIntro: 'Select the button below to finish signing in.',
		pageConfirmOtpIntro: 'Enter the code from your authenticator app to finish signing in.',
		pageOtpLabel: 'Authentication code',
		pageOtpInvalid: 'That code is not valid. Try again.',
		pageInvalidHeading: "This link can't be used",
		pageInvalidIntro: 'It was already used, or a newer link was requested. Use the latest email, or request a new link.',
		pageExpiredHeading: 'This link has expired',
		pageExpiredIntro: 'Sign-in links are valid for a limited time. Request a new one.',
		pageSuspendedHeading: 'Your account is suspended',
		pageSuspendedIntro: 'Contact your administrator to restore access.',
		pageInactiveHeading: "Your account isn't active",
		pageInactiveIntro: 'Contact your administrator if you need access.',
		pageForbiddenHeading: "You can't sign in with an email link",
		pageForbiddenIntro: 'Your account is not allowed to use email sign-in. Contact your administrator.',
		pageInvalidRestart: 'Request a new link',
		pageTooMany: 'Too many attempts. Try again later.',
	},
	'fr-FR': {
		subject: 'Connexion à {{ projectName }}',
		heading: 'Connexion à {{ projectName }}',
		greeting: 'Bonjour{% if user.first_name %} {{ user.first_name }}{% endif %},',
		intro: 'Cliquez sur le bouton ci-dessous pour vous connecter en tant que {{ email }}.',
		button: 'Se connecter',
		expiry:
			"Ce lien expire dans {{ expiresInMinutes }} {% if expiresInMinutes == 1 %}minute{% else %}minutes{% endif %} et ne peut être utilisé qu'une seule fois.",
		ignore: "Si vous n'avez pas demandé à vous connecter, vous pouvez ignorer cet e-mail.",
		fallbackLink: 'Si le bouton ne fonctionne pas, copiez cette adresse dans votre navigateur :',
		textIntro: 'Ouvrez ce lien pour vous connecter en tant que {{ email }} :',

		inactiveSubject: "Votre compte {{ projectName }} n'est pas actif",
		inactiveHeading: "Nous n'avons pas pu vous connecter",
		inactiveIntro:
			"Un lien de connexion a été demandé pour {{ email }}, mais ce compte {{ projectName }} n'est pas actif. Aucun lien n'a donc été envoyé.",
		inactiveAction: "Si vous avez besoin d'un accès, contactez votre administrateur.",

		pageRequestTitle: 'Connexion',
		pageRequestHeading: 'Connexion à {{ projectName }}',
		pageRequestIntro: 'Saisissez votre adresse e-mail et nous vous enverrons un lien de connexion.',
		pageEmailLabel: 'E-mail',
		pageRequestButton: 'Recevoir un lien de connexion',
		pageInvalidEmail: 'Saisissez une adresse e-mail valide.',
		pageSentTitle: 'Consultez vos e-mails',
		pageSentIntro:
			"Si cette adresse correspond à un compte, un lien de connexion vous a été envoyé. Il ne peut être utilisé qu'une seule fois.",
		pageSentRestart: 'Utiliser une autre adresse',
		pageConfirmTitle: 'Confirmer la connexion',
		pageConfirmIntro: 'Cliquez sur le bouton ci-dessous pour terminer la connexion.',
		pageConfirmOtpIntro: "Saisissez le code de votre application d'authentification pour terminer la connexion.",
		pageOtpLabel: "Code d'authentification",
		pageOtpInvalid: "Ce code n'est pas valide. Réessayez.",
		pageInvalidHeading: 'Ce lien ne peut pas être utilisé',
		pageInvalidIntro:
			'Il a déjà été utilisé, ou un lien plus récent a été demandé. Utilisez le dernier e-mail reçu ou demandez un nouveau lien.',
		pageExpiredHeading: 'Ce lien a expiré',
		pageExpiredIntro: 'Les liens de connexion sont valables pour une durée limitée. Demandez-en un nouveau.',
		pageSuspendedHeading: 'Votre compte est suspendu',
		pageSuspendedIntro: "Contactez votre administrateur pour rétablir l'accès.",
		pageInactiveHeading: "Votre compte n'est pas actif",
		pageInactiveIntro: "Contactez votre administrateur si vous avez besoin d'un accès.",
		pageForbiddenHeading: 'Connexion par e-mail impossible',
		pageForbiddenIntro: 'Votre compte ne peut pas utiliser la connexion par e-mail. Contactez votre administrateur.',
		pageInvalidRestart: 'Demander un nouveau lien',
		pageTooMany: 'Trop de tentatives. Réessayez plus tard.',
	},
} as const;

export type MessageKey = keyof (typeof MESSAGES)['en-US'];
export type Messages = Record<MessageKey, string>;

export const SUPPORTED_LOCALES = Object.keys(MESSAGES);

export function messagesFor(locale: string): Messages {
	return (MESSAGES as Record<string, Messages>)[locale] ?? MESSAGES[FALLBACK_LOCALE];
}

export type RenderedMessages = Messages & { locale: string };

export function renderMessages(liquid: Liquid, locale: string, data: object): RenderedMessages {
	const resolved = locale in MESSAGES ? locale : FALLBACK_LOCALE;
	const source = messagesFor(resolved);
	const rendered = { locale: resolved } as RenderedMessages;

	for (const key of Object.keys(source) as MessageKey[]) {
		rendered[key] = String(liquid.parseAndRenderSync(source[key], data));
	}

	return rendered;
}

/**
 * First candidate that matches an available locale, exactly or by language ("fr-CA" -> "fr-FR").
 * Candidates are tried in order before moving to the next, so the user's language beats the project default.
 */
export function negotiateLocale(candidates: (string | null | undefined)[], available: string[] = SUPPORTED_LOCALES): string | null {
	for (const candidate of candidates) {
		if (!candidate) continue;

		const wanted = candidate.trim().replace('_', '-').toLowerCase();
		const language = languageOf(wanted);

		const match =
			available.find((locale) => locale.toLowerCase() === wanted) ??
			available.find((locale) => languageOf(locale.toLowerCase()) === language);

		if (match) return match;
	}

	return null;
}

function languageOf(locale: string): string {
	const [language = locale] = locale.split('-');
	return language;
}

/** Locale tags from an Accept-Language header, highest quality first. */
export function parseAcceptLanguage(header: string | undefined): string[] {
	if (!header) return [];

	return header
		.split(',')
		.map((part) => {
			const [tag = '', ...params] = part.trim().split(';');
			const [, quality = '1'] = params.find((param) => param.trim().startsWith('q='))?.split('=') ?? [];
			return { tag: tag.trim(), q: Number.parseFloat(quality) };
		})
		.filter(({ tag, q }) => tag && tag !== '*' && q > 0)
		.sort((a, b) => b.q - a.q)
		.map(({ tag }) => tag);
}

/** Candidate file suffixes for a locale-specific template: "fr-FR" -> ["fr-FR", "fr"]. */
export function localeVariants(locale: string): string[] {
	const language = languageOf(locale);
	return language === locale ? [locale] : [locale, language];
}
