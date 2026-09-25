// Test-only: custom rules, an event log readable over HTTP, and shortcuts to expire links and enable 2FA.
const events = [];

export default {
	id: 'magic-link-test',
	handler: (router, { emitter, database, env }) => {
		emitter.onFilter('magic-link.validate', (decision, meta) => {
			if (meta.email.endsWith('@bypass.io')) return { allowed: true, reason: null };
			if (meta.email.startsWith('qa+')) throw new Error('QA addresses are refused');
			return decision;
		});

		emitter.onFilter('magic-link.login', (payload) => {
			if (payload.email.startsWith('veto')) throw new Error('vetoed');
			return payload;
		});

		emitter.onFilter('magic-link.email', (email) => {
			email.templateData.fixtureGreeting = 'hello-from-filter';
			return email;
		});

		emitter.onAction('magic-link.request', (event) => events.push({ type: 'request', ...event }));
		emitter.onAction('magic-link.login', ({ error, ...event }) => events.push({ type: 'login', ...event }));

		router.get('/events', (req, res) => {
			const email = String(req.query.email ?? '').toLowerCase();
			res.json(events.filter((event) => !email || String(event.email ?? '').toLowerCase() === email));
		});

		router.post('/tfa', async (req, res) => {
			await database('directus_users').where({ email: req.body.email }).update({ tfa_secret: req.body.secret });
			res.status(204).end();
		});

		router.post('/expire', async (req, res) => {
			await database(env.MAGIC_LINK_TABLE || 'extension_magic_link')
				.whereRaw('LOWER(??) = ?', ['email', String(req.body.email).toLowerCase()])
				.update({ expires_at: new Date(Date.now() - 1000) });
			res.status(204).end();
		});
	},
};
