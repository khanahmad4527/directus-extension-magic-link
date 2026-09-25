// Server-rendered and script-free, so they work under Directus' default CSP.
import type { RenderedMessages } from '../shared/i18n.js';

export function escapeHtml(value: string): string {
	return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

export type PageContext = { projectName: string; projectColor: string; t: RenderedMessages };

const hidden = (name: string, value: string | null | undefined) =>
	value ? `<input type="hidden" name="${name}" value="${escapeHtml(value)}" />` : '';

const alert = (message: string | undefined) => (message ? `<p class="error" role="alert">${escapeHtml(message)}</p>` : '');

function layout({ projectName, projectColor, t }: PageContext, title: string, body: string): string {
	const color = /^#[0-9a-f]{3,8}$/i.test(projectColor) ? projectColor : '#6644ff';

	return `<!DOCTYPE html>
<html lang="${escapeHtml(t.locale)}">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="robots" content="noindex" />
<meta name="referrer" content="no-referrer" />
<title>${escapeHtml(title)} · ${escapeHtml(projectName)}</title>
<style>
:root { color-scheme: light dark; --accent: ${color}; --bg: #f4f4f5; --card: #fff; --text: #171717; --muted: #52525b; --border: #e4e4e7; --danger: #dc2626; }
@media (prefers-color-scheme: dark) { :root { --bg: #09090b; --card: #18181b; --text: #fafafa; --muted: #a1a1aa; --border: #27272a; --danger: #f87171; } }
* { box-sizing: border-box; }
body { margin: 0; min-height: 100vh; display: grid; place-items: center; padding: 16px; background: var(--bg); color: var(--text); font: 16px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; }
main { width: 100%; max-width: 400px; background: var(--card); border: 1px solid var(--border); border-radius: 12px; padding: 32px; }
h1 { margin: 0 0 8px; font-size: 22px; line-height: 1.3; }
p { margin: 0 0 20px; color: var(--muted); }
label { display: block; font-size: 14px; font-weight: 600; margin-bottom: 6px; }
input { width: 100%; padding: 10px 12px; margin-bottom: 16px; border: 1px solid var(--border); border-radius: 8px; background: transparent; color: inherit; font: inherit; }
input:focus { outline: 2px solid var(--accent); outline-offset: 1px; }
button { width: 100%; padding: 11px 16px; border: 0; border-radius: 8px; background: var(--accent); color: #fff; font: inherit; font-weight: 600; cursor: pointer; }
.error { color: var(--danger); }
a { color: var(--accent); }
</style>
</head>
<body><main>${body}</main></body>
</html>`;
}

export function requestPage(page: PageContext, opts: { action: string; redirect: string | null; error?: string }): string {
	const { t } = page;

	return layout(
		page,
		t.pageRequestTitle,
		`<h1>${escapeHtml(t.pageRequestHeading)}</h1>
<p>${escapeHtml(t.pageRequestIntro)}</p>
${alert(opts.error)}
<form method="post" action="${escapeHtml(opts.action)}">
<label for="email">${escapeHtml(t.pageEmailLabel)}</label>
<input id="email" name="email" type="email" autocomplete="email" required autofocus />
${hidden('redirect', opts.redirect)}
${hidden('locale', t.locale)}
<button type="submit">${escapeHtml(t.pageRequestButton)}</button>
</form>`,
	);
}

export function sentPage(page: PageContext, opts: { restart: string }): string {
	const { t } = page;

	return layout(
		page,
		t.pageSentTitle,
		`<h1>${escapeHtml(t.pageSentTitle)}</h1>
<p>${escapeHtml(t.pageSentIntro)}</p>
<p><a href="${escapeHtml(opts.restart)}">${escapeHtml(t.pageSentRestart)}</a></p>`,
	);
}

export function confirmPage(
	page: PageContext,
	opts: { action: string; token: string; redirect: string | null; otpRequired: boolean; error?: string },
): string {
	const { t } = page;

	const otp = opts.otpRequired
		? `<label for="otp">${escapeHtml(t.pageOtpLabel)}</label>
<input id="otp" name="otp" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]*" required autofocus />`
		: '';

	return layout(
		page,
		t.pageConfirmTitle,
		`<h1>${escapeHtml(t.pageRequestHeading)}</h1>
<p>${escapeHtml(opts.otpRequired ? t.pageConfirmOtpIntro : t.pageConfirmIntro)}</p>
${alert(opts.error)}
<form method="post" action="${escapeHtml(opts.action)}">
${hidden('token', opts.token)}
${hidden('redirect', opts.redirect)}
${hidden('locale', t.locale)}
${otp}
<button type="submit">${escapeHtml(t.button)}</button>
</form>`,
	);
}

export type LinkProblem = 'invalid' | 'expired' | 'suspended' | 'inactive' | 'forbidden';

const PROBLEMS = {
	invalid: { heading: 'pageInvalidHeading', intro: 'pageInvalidIntro', restart: true },
	expired: { heading: 'pageExpiredHeading', intro: 'pageExpiredIntro', restart: true },
	suspended: { heading: 'pageSuspendedHeading', intro: 'pageSuspendedIntro', restart: false },
	inactive: { heading: 'pageInactiveHeading', intro: 'pageInactiveIntro', restart: false },
	forbidden: { heading: 'pageForbiddenHeading', intro: 'pageForbiddenIntro', restart: false },
} as const;

export function problemPage(page: PageContext, opts: { problem: LinkProblem; restart: string }): string {
	const { t } = page;
	const problem = PROBLEMS[opts.problem];
	const restart = problem.restart ? `<p><a href="${escapeHtml(opts.restart)}">${escapeHtml(t.pageInvalidRestart)}</a></p>` : '';

	return layout(
		page,
		t[problem.heading],
		`<h1>${escapeHtml(t[problem.heading])}</h1>
<p>${escapeHtml(t[problem.intro])}</p>
${restart}`,
	);
}
