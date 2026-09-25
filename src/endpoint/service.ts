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

	async function emailLimitReached(email: string): Promise<boolean> {
		return config.maxRequestsPerEmail > 0 && (await countSince('email', email)) >= config.maxRequestsPerEmail;
	}

	// About the client rather than the account, so it's safe to answer with 429 before anything else runs
	async function assertIpAllowed(ip: string | null): Promise<void> {
		if (config.maxRequestsPerIp <= 0 || !ip) return;

		await ensureTable(database, config.table);

		const [row] = await table()
			.where({ ip })
			.where('created_at', '>', new Date(Date.now() - HOUR))
			.count({ count: '*' })
			.min({ oldest: 'created_at' });

		if (Number(row?.count ?? 0) < config.maxRequestsPerIp) return;

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

	async function reject(email: string, user: UserRow | undefined, reason: string, info: RequestInfo, notified = false) {
		logger.debug(`[magic-link] request for ${email} refused: ${reason}${notified ? ' (user notified)' : ''}`);

		await table().insert({
			email,
			user: user?.id ?? null,
			status: 'rejected',
			reason: reason.slice(0, 255),
			ip: info.ip,
			user_agent: info.userAgent,
			created_at: new Date(),
		});

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
		const url = new URL(redirectUrl ?? `${config.publicUrl}/magic-link/verify`);
		url.searchParams.set('token', token);
		if (!redirectUrl && pageRedirect) url.searchParams.set('redirect', pageRedirect);
		return url.toString();
	}

	// Runs after the response is sent, so the outcome is never visible to the caller.
	async function processRequest(input: RequestInfo & { email: string; redirectUrl: string | null; pageRedirect: string | null }) {
		await ensureTable(database, config.table);

		const info: RequestInfo = { ip: input.ip, userAgent: input.userAgent, origin: input.origin };
		const user = await findUserByEmail(input.email);
		const rejection = coreRejection(user);

		if (rejection || !user) {
			const notified = user && user.status !== 'active' ? await notifyInactive(user, info) : false;
			return reject(input.email, user, rejection ?? 'user_not_found', info, notified);
		}

		const decision = await evaluatePolicy('request', user, info, input.redirectUrl);
		if (!decision.allowed) return reject(user.email, user, decision.reason ?? 'rejected', info);

		await table().where({ user: user.id }).whereIn('status', USABLE).update({ status: 'superseded', reason: 'Superseded by a newer link' });

		const token = randomBytes(32).toString('base64url');
		const tokenHash = hashToken(token);
		const expiresAt = new Date(Date.now() + config.ttl);

		await table().insert({
			token_hash: tokenHash,
			email: user.email,
			user: user.id,
			status: 'pending',
			redirect_url: input.redirectUrl,
			ip: info.ip,
			user_agent: info.userAgent,
			expires_at: expiresAt,
			created_at: new Date(),
		});

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

			const tfaService = new TFAService({ knex: database, schema });
			if (!(await tfaService.verifyOTP(user.id, input.otp))) throw await fail(new InvalidOtpError(), user);
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

	return { assertIpAllowed, processRequest, inspect, login };
}
