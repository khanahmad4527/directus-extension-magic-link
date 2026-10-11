import { performance } from 'node:perf_hooks';
import { InvalidPayloadError, InvalidTokenError, isDirectusError, ServiceUnavailableError } from '@directus/errors';
import { defineEndpoint } from '@directus/extensions-sdk';
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { Liquid } from 'liquidjs';
import { readConfig } from '../shared/config.js';
import { FALLBACK_LOCALE, negotiateLocale, parseAcceptLanguage, renderMessages } from '../shared/i18n.js';
import { readSettings } from '../shared/settings.js';
import { isSafeRedirect, isUrlAllowed, isValidEmail } from '../shared/rules.js';
import { confirmPage, type LinkProblem, type PageContext, problemPage, requestPage, sentPage } from './pages.js';
import { type Admission, type AuthMode, createMagicLinkService, type RequestInfo } from './service.js';

const MODES: AuthMode[] = ['json', 'cookie', 'session'];
const MAX_FORM_BYTES = 16 * 1024;

type Body = Record<string, unknown>;
type Tokens = { accessToken: string; refreshToken: string; expires: number };

const asyncHandler =
	(fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>): RequestHandler =>
	(req, res, next) => {
		fn(req, res, next).catch(next);
	};

const text = (value: unknown): string | null => (typeof value === 'string' && value !== '' ? value : null);

const PUBLIC_URL_MISSING = 'PUBLIC_URL must be the full public address of Directus, for example https://admin.example.com';

const PROBLEM_BY_CODE: Record<string, LinkProblem> = {
	TOKEN_EXPIRED: 'expired',
	OTP_LIMIT_EXCEEDED: 'locked',
	USER_SUSPENDED: 'suspended',
	USER_INACTIVE: 'inactive',
	FORBIDDEN: 'forbidden',
};

function toProblem(error: unknown): { problem: LinkProblem; status: number } {
	if (!isDirectusError(error)) return { problem: 'invalid', status: 500 };
	return { problem: PROBLEM_BY_CODE[error.code] ?? 'invalid', status: error.status };
}

export default defineEndpoint({
	id: 'magic-link',
	handler: (router, context) => {
		const { env, logger, database } = context;
		const config = readConfig(env);
		const service = createMagicLinkService(config, context);
		const base = config.publicUrl ? `${config.publicUrl}/magic-link` : null;
		const publicOrigin = config.publicUrl ? new URL(config.publicUrl).origin : null;
		const liquid = new Liquid();

		if (config.enablePages && !base) {
			logger.warn(`[magic-link] The built-in pages can't be used: ${PUBLIC_URL_MISSING}`);
		}

		function requestInfo(req: Request): RequestInfo {
			// Resolved by Directus, honouring IP_TRUST_PROXY and IP_CUSTOM_HEADER
			const ip = (req as Request & { accountability?: { ip?: string | null } }).accountability?.ip;

			return {
				ip: ip ?? req.ip ?? null,
				userAgent: req.get('user-agent')?.substring(0, 1024) ?? null,
				origin: req.get('origin') ?? null,
			};
		}

		/**
		 * Page language: `preferred` first (the user's language, or the language the previous page used),
		 * then the browser's Accept-Language, then the project default, then en-US. For a known user the
		 * browser is skipped: a null user language means "project default" in Directus.
		 */
		async function pageContext(req: Request, preferred: (string | null | undefined)[] = [], { browser = true } = {}): Promise<PageContext> {
			const { projectName, projectColor, defaultLanguage } = await readSettings(database);
			const accepted = browser ? parseAcceptLanguage(req.get('accept-language')) : [];
			const locale = negotiateLocale([...preferred, ...accepted, defaultLanguage]) ?? FALLBACK_LOCALE;

			return { projectName, projectColor: projectColor ?? '#6644ff', t: renderMessages(liquid, locale, { projectName }) };
		}

		const isForm = (req: Request) => Boolean(req.is('application/x-www-form-urlencoded'));

		// Directus only parses JSON bodies
		async function readBody(req: Request): Promise<Body> {
			if (!isForm(req)) return (req.body as Body | undefined) ?? {};

			const chunks: Buffer[] = [];
			let size = 0;

			for await (const chunk of req as AsyncIterable<Buffer>) {
				size += chunk.length;
				if (size > MAX_FORM_BYTES) throw new InvalidPayloadError({ reason: 'Payload too large' });
				chunks.push(chunk);
			}

			return Object.fromEntries(new URLSearchParams(Buffer.concat(chunks).toString('utf8')));
		}

		function assertSameOrigin(req: Request) {
			const origin = req.get('origin');
			const fetchSite = req.get('sec-fetch-site');

			if ((origin && origin !== publicOrigin) || (fetchSite && fetchSite !== 'same-origin' && fetchSite !== 'none')) {
				throw new InvalidPayloadError({ reason: 'Cross-origin form submissions are not allowed' });
			}
		}

		function safeRedirect(value: unknown): string | null {
			const target = text(value);
			return target && isSafeRedirect(target, config.urlAllowList) ? target : null;
		}

		// The built-in pages' base URL, or null after answering 404 when they're off
		function pagesBase(res: Response): string | null {
			if (!config.enablePages) {
				res.status(404).json({ errors: [{ message: 'Route not found', extensions: { code: 'ROUTE_NOT_FOUND' } }] });
				return null;
			}

			if (!base) throw new ServiceUnavailableError({ service: 'magic-link', reason: PUBLIC_URL_MISSING });

			return base;
		}

		// Input errors and the per-IP limit are reported; everything account-related runs in the background.
		async function acceptRequest(req: Request, res: Response, email: unknown, redirectUrl: string | null, pageRedirect: string | null) {
			const start = performance.now();
			const address = typeof email === 'string' ? email.trim() : email;

			if (!isValidEmail(address)) {
				throw new InvalidPayloadError({ reason: '"email" must be a valid email address' });
			}

			if (redirectUrl && !isUrlAllowed(redirectUrl, config.urlAllowList)) {
				throw new InvalidPayloadError({ reason: `URL "${redirectUrl}" can't be used for magic links` });
			}

			// Without redirect_url the email links to the built-in pages, which need to be on and reachable
			if (!redirectUrl && !config.enablePages) {
				throw new InvalidPayloadError({ reason: '"redirect_url" is required because the built-in pages are disabled' });
			}

			if (!redirectUrl && !base) {
				throw new ServiceUnavailableError({
					service: 'magic-link',
					reason: `"redirect_url" is required while the built-in pages can't be used. ${PUBLIC_URL_MISSING}`,
				});
			}

			const info = requestInfo(req);
			let admission: Admission;

			try {
				admission = await service.admit(address, info);
			} catch (error) {
				if (isDirectusError<{ reset: Date }>(error, 'REQUESTS_EXCEEDED')) {
					res.set('Retry-After', String(Math.max(1, Math.ceil((error.extensions.reset.getTime() - Date.now()) / 1000))));
				}

				throw error;
			}

			service.processRequest({ ...info, ...admission, email: address, redirectUrl, pageRedirect }).catch((error: unknown) => {
				logger.error(error, '[magic-link] request processing failed');
			});

			const remaining = config.stallTime - (performance.now() - start);
			if (remaining > 0) await new Promise((resolve) => setTimeout(resolve, remaining));
		}

		// Same payload and cookies as POST /auth/login
		function sendTokens(res: Response, mode: AuthMode, tokens: Tokens) {
			const payload: { expires: number; access_token?: string; refresh_token?: string } = { expires: tokens.expires };

			if (mode === 'json') {
				payload.access_token = tokens.accessToken;
				payload.refresh_token = tokens.refreshToken;
			}

			if (mode === 'cookie') {
				res.cookie(config.refreshCookie.name, tokens.refreshToken, config.refreshCookie.options);
				payload.access_token = tokens.accessToken;
			}

			if (mode === 'session') {
				res.cookie(config.sessionCookie.name, tokens.accessToken, config.sessionCookie.options);
			}

			res.json({ data: payload });
		}

		router.get(
			'/',
			asyncHandler(async (req, res) => {
				const pages = pagesBase(res);
				if (!pages) return;

				const page = await pageContext(req, [text(req.query['lang'])]);
				res.type('html').send(requestPage(page, { action: `${pages}/request`, redirect: safeRedirect(req.query['redirect']) }));
			}),
		);

		// Only displays the confirmation form; the token is consumed by the POST, so link scanners can't burn it
		router.get(
			'/verify',
			asyncHandler(async (req, res) => {
				const pages = pagesBase(res);
				if (!pages) return;

				const token = text(req.query['token']);
				const state = token ? await service.inspect(token) : { error: new InvalidTokenError(), otpRequired: false, language: null };
				const page = await pageContext(req, [state.language], { browser: state.language === null });

				res.set('Cache-Control', 'no-store');

				if (!token || state.error) {
					const { problem, status } = toProblem(state.error);
					res
						.status(status)
						.type('html')
						.send(problemPage(page, { problem, restart: `${pages}/` }));
					return;
				}

				res.type('html').send(
					confirmPage(page, {
						action: `${pages}/verify`,
						token,
						redirect: safeRedirect(req.query['redirect']),
						otpRequired: state.otpRequired,
					}),
				);
			}),
		);

		router.post(
			'/request',
			asyncHandler(async (req, res) => {
				if (!isForm(req)) {
					const body = await readBody(req);
					await acceptRequest(req, res, body['email'], text(body['redirect_url']), null);
					res.status(204).end();
					return;
				}

				const pages = pagesBase(res);
				if (!pages) return;
				assertSameOrigin(req);

				const body = await readBody(req);
				const redirect = safeRedirect(body['redirect']);
				const page = await pageContext(req, [text(body['locale'])]);

				try {
					await acceptRequest(req, res, body['email'], null, redirect);
				} catch (error) {
					if (!isDirectusError(error)) throw error;

					const tooMany = isDirectusError(error, 'REQUESTS_EXCEEDED');
					const message = tooMany ? page.t.pageTooMany : page.t.pageInvalidEmail;
					res
						.status(error.status)
						.type('html')
						.send(requestPage(page, { action: `${pages}/request`, redirect, error: message }));
					return;
				}

				res.type('html').send(sentPage(page, { restart: `${pages}/?lang=${encodeURIComponent(page.t.locale)}` }));
			}),
		);

		router.post(
			'/verify',
			asyncHandler(async (req, res) => {
				const form = isForm(req);
				const pages = form ? pagesBase(res) : null;

				if (form) {
					if (!pages) return;
					assertSameOrigin(req);
				}

				const body = await readBody(req);
				const token = text(body['token']);
				const otp = text(body['otp']) ?? undefined;
				const mode = form ? 'session' : ((body['mode'] as AuthMode | undefined) ?? 'json');

				if (!token) throw new InvalidPayloadError({ reason: '"token" is required' });
				if (!MODES.includes(mode)) throw new InvalidPayloadError({ reason: `"mode" must be one of ${MODES.join(', ')}` });

				if (!form) {
					sendTokens(res, mode, await service.login({ ...requestInfo(req), token, otp, mode }));
					return;
				}

				const redirect = safeRedirect(body['redirect']);

				try {
					const tokens = await service.login({ ...requestInfo(req), token, otp, mode });
					res.cookie(config.sessionCookie.name, tokens.accessToken, config.sessionCookie.options);
					res.redirect(303, redirect ?? config.defaultRedirect);
				} catch (error) {
					const page = await pageContext(req, [text(body['locale'])]);

					if (isDirectusError(error, 'INVALID_OTP')) {
						const message = otp ? page.t.pageOtpInvalid : undefined;
						res
							.status(401)
							.type('html')
							.send(confirmPage(page, { action: `${pages}/verify`, token, redirect, otpRequired: true, error: message }));
						return;
					}

					if (!isDirectusError(error)) logger.error(error, '[magic-link] login failed');

					const { problem, status } = toProblem(error);
					res
						.status(status)
						.type('html')
						.send(problemPage(page, { problem, restart: `${pages}/` }));
				}
			}),
		);
	},
});
