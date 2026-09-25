import ms from 'ms';

// Directus casts env values ("true" -> true, "a,b" -> ["a", "b"]) but config files may not, so accept both.

/**
 * Strings, numbers and booleans as text; objects and null give the fallback. Directus splits any env value
 * containing a comma into an array ("Hello, {{ name }}" -> ["Hello", " {{ name }}"]), so arrays are joined back.
 */
export function toText(value: unknown, fallback = ''): string {
	if (Array.isArray(value)) return toText(value.map((item) => toText(item)).join(','), fallback);
	if (typeof value === 'string') return value.trim() === '' ? fallback : value;
	if (typeof value === 'number' || typeof value === 'boolean') return String(value);
	return fallback;
}

export function toList(value: unknown): string[] {
	const items = Array.isArray(value) ? value.map((item) => toText(item)) : toText(value).split(',');
	return items.map((item) => item.trim()).filter(Boolean);
}

export function toBool(value: unknown, fallback: boolean): boolean {
	if (typeof value === 'boolean') return value;
	const text = toText(value).toLowerCase();
	return text === '' ? fallback : ['true', '1', 'yes', 'on'].includes(text);
}

export function toInt(value: unknown, fallback: number): number {
	const parsed = Number.parseInt(toText(value), 10);
	return Number.isFinite(parsed) ? parsed : fallback;
}

export function toMilliseconds(value: unknown, fallback: number): number {
	if (typeof value === 'number' && Number.isFinite(value)) return value;

	if (typeof value === 'string' && value.trim() !== '') {
		const parsed = ms(value.trim() as ms.StringValue);
		if (typeof parsed === 'number' && Number.isFinite(parsed)) return parsed;
	}

	return fallback;
}

/** A single Liquid string for every language, or a map of locale -> Liquid string (JSON in env). */
export function toLocalizedText(value: unknown): string | Record<string, string> | null {
	if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
		const entries = Object.entries(value).map(([locale, text]) => [locale, toText(text)] as const);
		return Object.fromEntries(entries.filter(([, text]) => text !== ''));
	}

	const raw = toText(value);
	if (raw === '') return null;

	if (raw.trim().startsWith('{')) {
		try {
			return toLocalizedText(JSON.parse(raw));
		} catch {
			return raw;
		}
	}

	return raw;
}

const SAME_SITE = ['lax', 'strict', 'none'] as const;
type SameSite = (typeof SAME_SITE)[number];

function toSameSite(value: unknown): SameSite {
	const text = toText(value).toLowerCase();
	return SAME_SITE.find((option) => option === text) ?? 'strict';
}

function cookie(
	name: unknown,
	fallbackName: string,
	domain: unknown,
	ttl: unknown,
	fallbackTtl: number,
	secure: unknown,
	sameSite: unknown,
) {
	return {
		name: toText(name, fallbackName),
		options: {
			httpOnly: true,
			domain: toText(domain) || undefined,
			maxAge: toMilliseconds(ttl, fallbackTtl),
			secure: toBool(secure, false),
			sameSite: toSameSite(sameSite),
		},
	};
}

export type MagicLinkConfig = ReturnType<typeof readConfig>;

const MINUTE = 60 * 1000;
const DAY = 24 * 60 * MINUTE;

export function readConfig(env: Record<string, unknown>) {
	return {
		publicUrl: toText(env['PUBLIC_URL'], 'http://localhost:8055').replace(/\/+$/, ''),
		table: toText(env['MAGIC_LINK_TABLE'], 'extension_magic_link'),
		retentionDays: toInt(env['MAGIC_LINK_RETENTION_DAYS'], 30),

		ttl: toMilliseconds(env['MAGIC_LINK_TTL'], 15 * MINUTE),
		stallTime: toInt(env['MAGIC_LINK_STALL_TIME'] ?? env['LOGIN_STALL_TIME'], 500),

		emailFrom: toText(env['MAGIC_LINK_EMAIL_FROM']),
		emailFromName: toText(env['MAGIC_LINK_EMAIL_FROM_NAME']),
		defaultEmailFrom: toText(env['EMAIL_FROM']),
		emailSubject: toLocalizedText(env['MAGIC_LINK_EMAIL_SUBJECT']),
		emailTemplate: toText(env['MAGIC_LINK_EMAIL_TEMPLATE'], 'magic-link'),
		notifyInactive: toBool(env['MAGIC_LINK_NOTIFY_INACTIVE'], true),
		inactiveEmailSubject: toLocalizedText(env['MAGIC_LINK_INACTIVE_EMAIL_SUBJECT']),
		emailTemplatesPath: toText(env['EMAIL_TEMPLATES_PATH'], './templates'),

		urlAllowList: toList(env['MAGIC_LINK_URL_ALLOW_LIST']),
		defaultRedirect: toText(env['MAGIC_LINK_DEFAULT_REDIRECT'], '/admin'),
		enablePages: toBool(env['MAGIC_LINK_ENABLE_PAGES'], true),

		allowedProviders: toList(env['MAGIC_LINK_ALLOWED_PROVIDERS'] ?? 'default'),
		allowedRoles: toList(env['MAGIC_LINK_ALLOWED_ROLES']),
		disallowedRoles: toList(env['MAGIC_LINK_DISALLOWED_ROLES']),
		emailAllowList: toList(env['MAGIC_LINK_EMAIL_ALLOW_LIST']),
		emailDenyList: toList(env['MAGIC_LINK_EMAIL_DENY_LIST']),
		requireTfa: toBool(env['MAGIC_LINK_REQUIRE_TFA'], true),

		maxRequestsPerEmail: toInt(env['MAGIC_LINK_MAX_REQUESTS_PER_HOUR'], 5),
		maxRequestsPerIp: toInt(env['MAGIC_LINK_MAX_REQUESTS_PER_IP_PER_HOUR'], 20),

		// Same defaults as Directus' REFRESH_COOKIE_OPTIONS / SESSION_COOKIE_OPTIONS
		refreshTokenTtl: toMilliseconds(env['REFRESH_TOKEN_TTL'], 7 * DAY),
		refreshCookie: cookie(
			env['REFRESH_TOKEN_COOKIE_NAME'],
			'directus_refresh_token',
			env['REFRESH_TOKEN_COOKIE_DOMAIN'],
			env['REFRESH_TOKEN_TTL'],
			7 * DAY,
			env['REFRESH_TOKEN_COOKIE_SECURE'],
			env['REFRESH_TOKEN_COOKIE_SAME_SITE'],
		),
		sessionCookie: cookie(
			env['SESSION_COOKIE_NAME'],
			'directus_session_token',
			env['SESSION_COOKIE_DOMAIN'],
			env['SESSION_COOKIE_TTL'],
			DAY,
			env['SESSION_COOKIE_SECURE'],
			env['SESSION_COOKIE_SAME_SITE'],
		),
	};
}
