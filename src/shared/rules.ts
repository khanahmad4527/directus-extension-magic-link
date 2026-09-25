const REGEX_PATTERN = /^\/(.+)\/([a-z]*)$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Patterns: `jane@acme.com`, `@acme.com` (domain), `*.acme.com` (subdomains),
 * `qa+*@acme.com` (glob), `/^ops-.*@acme\.com$/i` (regular expression).
 */
export function matchesEmailPattern(email: string, pattern: string): boolean {
	const rule = pattern.trim();
	if (!rule) return false;

	const regex = REGEX_PATTERN.exec(rule);

	if (regex) {
		const [, source = '', flags] = regex;

		try {
			return new RegExp(source, flags).test(email);
		} catch {
			return false;
		}
	}

	const value = email.toLowerCase();
	const lowered = rule.toLowerCase();
	const domain = value.slice(value.lastIndexOf('@') + 1);

	if (lowered.startsWith('@')) return domain === lowered.slice(1);
	if (lowered.startsWith('*.') && !lowered.includes('@')) return domain.endsWith(lowered.slice(1));

	if (lowered.includes('*')) {
		const source = lowered
			.split('*')
			.map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
			.join('.*');

		return new RegExp(`^${source}$`).test(value);
	}

	return value === lowered;
}

export function matchesAnyEmailPattern(email: string, patterns: string[]): boolean {
	return patterns.some((pattern) => matchesEmailPattern(email, pattern));
}

/** Port of Directus' isUrlAllowed(): exact match, or same origin + pathname. */
export function isUrlAllowed(url: string, allowList: string[]): boolean {
	if (allowList.includes(url)) return true;

	const target = originAndPath(url);
	if (!target) return false;

	return allowList.some((allowed) => originAndPath(allowed) === target);
}

function originAndPath(url: string): string | null {
	try {
		const { origin, pathname } = new URL(url);
		return origin + pathname;
	} catch {
		return null;
	}
}

export function isSafeRedirect(target: string, allowList: string[]): boolean {
	if (/^\/(?![/\\])/.test(target)) return true;
	return isUrlAllowed(target, allowList);
}

export function isValidEmail(email: unknown): email is string {
	return typeof email === 'string' && email.length <= 254 && EMAIL.test(email);
}

export function compareVersions(a: string, b: string): number {
	const parse = (version: string) => {
		const [core = ''] = version.split('-');
		return core.split('.').map((part) => Number.parseInt(part, 10) || 0);
	};
	const left = parse(a);
	const right = parse(b);

	for (let i = 0; i < Math.max(left.length, right.length); i++) {
		const diff = (left[i] ?? 0) - (right[i] ?? 0);
		if (diff !== 0) return Math.sign(diff);
	}

	return 0;
}
