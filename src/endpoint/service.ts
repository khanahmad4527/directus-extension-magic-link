import { createHash, randomBytes } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import {
	createError,
	ForbiddenError,
	HitRateLimitError,
	InvalidOtpError,
	InvalidTokenError,
	TokenExpiredError,
	UserSuspendedError,
} from '@directus/errors';
import type { Accountability, EndpointExtensionContext } from '@directus/types';
import type { MagicLinkConfig } from '../shared/config.js';
import type { ExtensionEmitter } from '../shared/emitter.js';
import { matchesAnyEmailPattern } from '../shared/rules.js';
import { readSettings } from '../shared/settings.js';
import { ensureTable, type TokenRecord, type TokenStatus } from '../shared/table.js';
import { createMailer } from './mailer.js';

export type Stage = 'request' | 'verify';
export type AuthMode = 'json' | 'cookie' | 'session';

export type RequestInfo = {
	ip: string | null;
	userAgent: string | null;
	origin: string | null;
};

type UserRow = {
	id: string;
	email: string;
	first_name: string | null;
	last_name: string | null;
	status: string;
	role: string | null;
	provider: string;
	language: string | null;
	tfa_secret: string | null;
};

type PublicUser = Omit<UserRow, 'tfa_secret'> & { tfa_enabled: boolean };

export type ValidationDecision = {
	allowed: boolean;
	reason: string | null;
};

export type ValidationMeta = RequestInfo & {
	stage: Stage;
	email: string;
	user: PublicUser;
	checks: { email: boolean; role: boolean; rateLimit: boolean };
	redirectUrl: string | null;
};

// Directus has UserSuspendedError but nothing for invited/draft/archived accounts
export const UserInactiveError = createError('USER_INACTIVE', 'User account is not active.', 401);

export const OtpLimitExceededError = createError('OTP_LIMIT_EXCEEDED', 'Too many wrong one-time passwords for this link.', 403);

export type Admission = { token: string; tokenHash: string };

const USABLE: TokenStatus[] = ['pending', 'sent'];
const USER_FIELDS = ['id', 'email', 'first_name', 'last_name', 'status', 'role', 'provider', 'language', 'tfa_secret'];
const HOUR = 60 * 60 * 1000;

export function hashToken(token: string): string {
	return createHash('sha256').update(token).digest('hex');
}

async function stall(ms: number, start: number) {
	const remaining = ms - (performance.now() - start);
	if (remaining > 0) await new Promise((resolve) => setTimeout(resolve, remaining));
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function isDecision(value: unknown): value is ValidationDecision {
	return typeof value === 'object' && value !== null && 'allowed' in value && typeof value.allowed === 'boolean';
}

function isPast(value: Date | string | number | null): boolean {
	return value === null || new Date(value).getTime() <= Date.now();
}

function toPublicUser({ tfa_secret, ...user }: UserRow): PublicUser {
	return { ...user, tfa_enabled: Boolean(tfa_secret) };
}

export function createMagicLinkService(config: MagicLinkConfig, context: EndpointExtensionContext) {
	const { database, services, logger, getSchema } = context;
	const emitter = context.emitter as ExtensionEmitter;
	const { AuthenticationService, ActivityService, TFAService } = services;
	const mailer = createMailer(config, context);
	const table = () => database<TokenRecord>(config.table);

	function findUserByEmail(email: string): Promise<UserRow | undefined> {
		return database.select(USER_FIELDS).from('directus_users').whereRaw('LOWER(??) = ?', ['email', email.toLowerCase()]).first();
	}

	function templateUser(user: UserRow) {
		return { id: user.id, email: user.email, first_name: user.first_name, last_name: user.last_name, language: user.language };
	}

	function findUserById(id: string): Promise<UserRow | undefined> {
		return database.select(USER_FIELDS).from('directus_users').where({ id }).first();
	}

	// Same gate as /auth/login and password reset. Hooks can't override it.
	function coreRejection(user: UserRow | undefined): string | null {
		if (!user) return 'user_not_found';
		if (user.status !== 'active') return `user_status_${user.status}`;

		if (config.allowedProviders.length > 0 && !config.allowedProviders.includes(user.provider)) {
			return `provider_${user.provider}_not_allowed`;
		}

		return null;
	}

	async function countSince(column: 'email' | 'ip', value: string): Promise<number> {
		const query = table().where('created_at', '>', new Date(Date.now() - HOUR));

		if (column === 'email') query.whereRaw('LOWER(??) = ?', ['email', value.toLowerCase()]);
		else query.where({ ip: value });

		const [row] = await query.count({ count: '*' });
		return Number(row?.count ?? 0);
	}

	// Every request's row is written before counting (see admit), so the count includes this request
	async function emailLimitReached(email: string): Promise<boolean> {
		return config.maxRequestsPerEmail > 0 && (await countSince('email', email)) > config.maxRequestsPerEmail;
	}

	/**
	 * Records the request before anything is counted, so simultaneous requests see each other: of a burst,
	 * at most the limit get through. The per-IP limit is about the client rather than the account, so it's
	 * safe to answer with 429.
	 */
	async function admit(email: string, info: RequestInfo): Promise<Admission> {
		await ensureTable(database, config.table);

		const token = randomBytes(32).toString('base64url');
		const tokenHash = hashToken(token);

		await table().insert({
			token_hash: tokenHash,
			email,
			status: 'received',
			ip: info.ip,
			user_agent: info.userAgent,
			created_at: new Date(),
		});

		if (config.maxRequestsPerIp <= 0 || !info.ip) return { token, tokenHash };

		const [row] = await table()
			.where({ ip: info.ip })
			.where('created_at', '>', new Date(Date.now() - HOUR))
			.count({ count: '*' })
			.min({ oldest: 'created_at' });

		if (Number(row?.count ?? 0) <= config.maxRequestsPerIp) return { token, tokenHash };

		// Not kept, so a client that keeps hammering doesn't grow the table
		await table().where({ token_hash: tokenHash }).delete();

		const oldest = row?.oldest ? new Date(row.oldest as string | number | Date).getTime() : Date.now();
		throw new HitRateLimitError({ limit: config.maxRequestsPerIp, reset: new Date(oldest + HOUR) });
	}

	async function evaluatePolicy(stage: Stage, user: UserRow, info: RequestInfo, redirectUrl: string | null): Promise<ValidationDecision> {
		const emailAllowed =
			!matchesAnyEmailPattern(user.email, config.emailDenyList) &&
			(config.emailAllowList.length === 0 || matchesAnyEmailPattern(user.email, config.emailAllowList));

		const roleAllowed =
			!(user.role && config.disallowedRoles.includes(user.role)) &&
			(config.allowedRoles.length === 0 || (user.role !== null && config.allowedRoles.includes(user.role)));

		const rateLimitOk = stage === 'verify' || !(await emailLimitReached(user.email));

		let decision: ValidationDecision = { allowed: true, reason: null };
		if (!emailAllowed) decision = { allowed: false, reason: 'email_not_allowed' };
		else if (!roleAllowed) decision = { allowed: false, reason: 'role_not_allowed' };
		else if (!rateLimitOk) decision = { allowed: false, reason: 'rate_limited' };

		const meta: ValidationMeta = {
			...info,
			stage,
			email: user.email,
			user: toPublicUser(user),
			checks: { email: emailAllowed, role: roleAllowed, rateLimit: rateLimitOk },
			redirectUrl,
		};

		try {
			const context = { database, schema: await getSchema(), accountability: null };
			const result = await emitter.emitFilter<unknown>('magic-link.validate', decision, meta, context);

			// Hooks are plain JavaScript, so anything that isn't a decision keeps the built-in one
			if (!isDecision(result)) return decision;

			return { allowed: result.allowed, reason: result.allowed ? null : (result.reason ?? 'rejected_by_hook') };
		} catch (error) {
			return { allowed: false, reason: `rejected_by_hook: ${errorMessage(error)}`.slice(0, 255) };
		}
	}

	async function reject(tokenHash: string, email: string, user: UserRow | undefined, reason: string, notified = false) {
		logger.debug(`[magic-link] request for ${email} refused: ${reason}${notified ? ' (user notified)' : ''}`);

		await table()
			.where({ token_hash: tokenHash })
			.update({ user: user?.id ?? null, status: 'rejected', reason: reason.slice(0, 255) });

		emitter.emitAction('magic-link.request', { email, user: user?.id ?? null, status: 'rejected', reason, notified });
	}

	// Only the mailbox owner learns the account isn't active; the HTTP response stays the same for everyone
	async function notifyInactive(user: UserRow, info: RequestInfo): Promise<boolean> {
		if (!config.notifyInactive || (await emailLimitReached(user.email))) return false;

		try {
			const status = await mailer.send('inactive', { to: user.email, user: templateUser(user), ip: info.ip, userAgent: info.userAgent });
			return status === 'sent';
		} catch (error) {
			logger.error(error, `[magic-link] could not send the inactive-account email to ${user.email}`);
			return false;
		}
	}

	function buildLink(token: string, redirectUrl: string | null, pageRedirect: string | null): string {
		// The router only accepts a request without redirect_url when the built-in pages and PUBLIC_URL are set
		const url = new URL(redirectUrl ?? `${config.publicUrl ?? ''}/magic-link/verify`);
		url.searchParams.set('token', token);
		if (!redirectUrl && pageRedirect) url.searchParams.set('redirect', pageRedirect);
		return url.toString();
	}

	// Runs after the response is sent, so the outcome is never visible to the caller.
	async function processRequest(
		input: RequestInfo & Admission & { email: string; redirectUrl: string | null; pageRedirect: string | null },
	) {
		const { token, tokenHash } = input;
		const info: RequestInfo = { ip: input.ip, userAgent: input.userAgent, origin: input.origin };
		const user = await findUserByEmail(input.email);
		const rejection = coreRejection(user);

		if (rejection || !user) {
			const notified = user && user.status !== 'active' ? await notifyInactive(user, info) : false;
			return reject(tokenHash, input.email, user, rejection ?? 'user_not_found', notified);
		}

		const decision = await evaluatePolicy('request', user, info, input.redirectUrl);
		if (!decision.allowed) return reject(tokenHash, user.email, user, decision.reason ?? 'rejected');

		await table().where({ user: user.id }).whereIn('status', USABLE).update({ status: 'superseded', reason: 'Superseded by a newer link' });

		const expiresAt = new Date(Date.now() + config.ttl);

		await table()
			.where({ token_hash: tokenHash })
			.update({ email: user.email, user: user.id, status: 'pending', redirect_url: input.redirectUrl, expires_at: expiresAt });

		try {
			const status = await mailer.send('link', {
				to: user.email,
				user: templateUser(user),
				url: buildLink(token, input.redirectUrl, input.pageRedirect),
				expiresAt,
				ip: info.ip,
				userAgent: info.userAgent,
			});

			await table()
				.where({ token_hash: tokenHash, status: 'pending' })
				.update({ status, reason: status === 'cancelled' ? 'Cancelled by an email.send filter' : null });

			emitter.emitAction('magic-link.request', { email: user.email, user: user.id, status });
		} catch (error) {
			logger.error(error, `[magic-link] could not send email to ${user.email}`);
			await table()
				.where({ token_hash: tokenHash })
				.update({ status: 'failed', reason: errorMessage(error).slice(0, 255) });
			emitter.emitAction('magic-link.request', { email: user.email, user: user.id, status: 'failed', reason: errorMessage(error) });
		}
	}

	/**
	 * The link's state, then the account's, each with its own Directus error. Only the person holding the
	 * link sees these, and they've already proven they own the mailbox, so being specific reveals nothing.
	 */
	async function resolveLink(token: string): Promise<{ record: TokenRecord; user: UserRow }> {
		await ensureTable(database, config.table);

		const record = await table()
			.where({ token_hash: hashToken(token) })
			.first();

		if (!record?.user) throw new InvalidTokenError();
		if (record.status === 'locked') throw new OtpLimitExceededError();
		if (record.status === 'expired' || (USABLE.includes(record.status) && isPast(record.expires_at))) throw new TokenExpiredError();
		if (!USABLE.includes(record.status)) throw new InvalidTokenError();

		const user = await findUserById(record.user);

		if (user?.email.toLowerCase() !== record.email.toLowerCase()) throw new InvalidTokenError();
		if (user.status === 'suspended') throw new UserSuspendedError();
		if (user.status !== 'active') throw new UserInactiveError();
		if (coreRejection(user)) throw new ForbiddenError();

		return { record, user };
	}

	async function inspect(token: string): Promise<{ error: unknown; otpRequired: boolean; language: string | null }> {
		try {
			const { user } = await resolveLink(token);
			return { error: null, otpRequired: config.requireTfa && Boolean(user.tfa_secret), language: user.language };
		} catch (error) {
			return { error, otpRequired: false, language: await languageForToken(token) };
		}
	}

	// So the "suspended" or "expired" page is still shown in the user's language
	async function languageForToken(token: string): Promise<string | null> {
		const record = await table()
			.where({ token_hash: hashToken(token) })
			.first();
		const user = record?.user ? await findUserById(record.user) : undefined;
		return user?.language ?? null;
	}

	// Atomic, so simultaneous guesses can't get past MAGIC_LINK_MAX_OTP_ATTEMPTS
	async function reserveOtpAttempt(id: number): Promise<boolean> {
		const query = table().where({ id }).whereIn('status', USABLE);
		if (config.maxOtpAttempts > 0) query.where('otp_attempts', '<', config.maxOtpAttempts);
		return (await query.increment('otp_attempts', 1)) > 0;
	}

	// Returns whether this failure used up the link's last attempt
	async function recordOtpFailure(id: number, user: UserRow): Promise<boolean> {
		const locked =
			config.maxOtpAttempts > 0 &&
			(await table()
				.where({ id })
				.whereIn('status', USABLE)
				.where('otp_attempts', '>=', config.maxOtpAttempts)
				.update({ status: 'locked', reason: 'Too many wrong 2FA codes' })) > 0;

		await suspendAfterRepeatedFailures(user);

		return locked;
	}

	/**
	 * Wrong codes since the user's last magic-link sign-in count toward auth_login_attempts, and the account is
	 * suspended at the limit, as /auth/login does. Directus doesn't expose its own counter, so password and
	 * magic-link failures are counted separately.
	 */
	async function suspendAfterRepeatedFailures(user: UserRow): Promise<void> {
		const { authLoginAttempts } = await readSettings(database);
		if (authLoginAttempts === null) return;

		const lastLogin = await table().where({ user: user.id, status: 'used' }).max({ at: 'used_at' }).first();
		const failures = table().where({ user: user.id }).whereNot({ status: 'used' });
		if (lastLogin?.at) failures.where('created_at', '>', lastLogin.at as Date);

		const [row] = await failures.sum({ total: 'otp_attempts' });
		if (Number(row?.total ?? 0) < authLoginAttempts) return;

		const suspended = await database('directus_users').where({ id: user.id, status: 'active' }).update({ status: 'suspended' });
		if (suspended) logger.warn(`[magic-link] suspended ${user.email} after ${authLoginAttempts} wrong 2FA codes`);
	}

	// Every rule runs again here, so suspending a user or changing their role revokes links already sent.
	async function login(input: RequestInfo & { token: string; otp?: string; mode: AuthMode }) {
		const start = performance.now();
		const info: RequestInfo = { ip: input.ip, userAgent: input.userAgent, origin: input.origin };
		const schema = await getSchema();
		const eventContext = { database, schema, accountability: null };

		const fail = async (error: Error, user?: UserRow) => {
			emitter.emitAction('magic-link.login', { email: user?.email ?? null, user: user?.id ?? null, status: 'fail', error }, eventContext);
			await stall(config.stallTime, start);
			return error;
		};

		let link: { record: TokenRecord; user: UserRow };

		try {
			link = await resolveLink(input.token);
		} catch (error) {
			throw await fail(error instanceof Error ? error : new Error(String(error)));
		}

		const { record, user } = link;
		const decision = await evaluatePolicy('verify', user, info, record.redirect_url);

		if (!decision.allowed) {
			logger.debug(`[magic-link] login for ${user.email} refused: ${decision.reason}`);
			throw await fail(new ForbiddenError(), user);
		}

		if (config.requireTfa && user.tfa_secret) {
			if (!input.otp) throw await fail(new InvalidOtpError(), user);
			if (!(await reserveOtpAttempt(record.id))) throw await fail(new OtpLimitExceededError(), user);

			const tfaService = new TFAService({ knex: database, schema });

			if (!(await tfaService.verifyOTP(user.id, input.otp))) {
				const locked = await recordOtpFailure(record.id, user);
				throw await fail(locked ? new OtpLimitExceededError() : new InvalidOtpError(), user);
			}
		}

		try {
			await emitter.emitFilter(
				'magic-link.login',
				{ email: user.email },
				{ ...info, status: 'pending', user: toPublicUser(user) },
				eventContext,
			);
		} catch (error) {
			logger.debug(`[magic-link] login for ${user.email} blocked by hook: ${errorMessage(error)}`);
			throw await fail(new ForbiddenError(), user);
		}

		// Atomic: of two concurrent requests only one flips the row
		const consumed = await table().where({ id: record.id }).whereIn('status', USABLE).update({ status: 'used', used_at: new Date() });
		if (!consumed) throw await fail(new InvalidTokenError(), user);

		// Directus mints the tokens from a bootstrap session: refresh() applies the status check, provider
		// refresh, policy-based app/admin access, license lock, `auth.jwt` filter and session rotation.
		const bootstrapToken = randomBytes(48).toString('base64url');

		await database('directus_sessions').insert({
			token: bootstrapToken,
			user: user.id,
			expires: new Date(Date.now() + config.refreshTokenTtl),
			ip: info.ip,
			user_agent: info.userAgent,
			origin: info.origin,
		});

		const accountability = {
			user: null,
			role: null,
			roles: [],
			admin: false,
			app: false,
			ip: info.ip,
			userAgent: info.userAgent ?? undefined,
			origin: info.origin ?? undefined,
		} as unknown as Accountability;

		let result: { accessToken: string; refreshToken: string; expires: number };

		try {
			const authenticationService = new AuthenticationService({ accountability, schema, knex: database });
			result = await authenticationService.refresh(bootstrapToken, { session: input.mode === 'session' });
		} catch (error) {
			await database('directus_sessions').where({ token: bootstrapToken }).delete();
			await table().where({ id: record.id }).update({ status: record.status, used_at: null });
			throw await fail(error instanceof Error ? error : new Error(String(error)), user);
		}

		await new ActivityService({ knex: database, schema }).createOne({
			action: 'login',
			user: user.id,
			ip: info.ip,
			user_agent: info.userAgent,
			origin: info.origin,
			collection: 'directus_users',
			item: user.id,
		});

		emitter.emitAction('magic-link.login', { email: user.email, user: user.id, status: 'success', mode: input.mode }, eventContext);

		await stall(config.stallTime, start);

		return result;
	}

	return { admit, processRequest, inspect, login };
}
