// Subscribe with `emitter.onFilter` from the second argument: magic-link events are sent on Directus'
// extension-scoped emitter, which the `filter()` helper from the first argument doesn't listen to.

const BYPASS = ['@acme.com', 'ops@partner.io'];
const DISPOSABLE_DOMAINS = ['mailinator.com', 'guerrillamail.com', '10minutemail.com'];

const matches = (email, rule) => (rule.startsWith('@') ? email.endsWith(rule) : email === rule);

export default (_register, { emitter }) => {
	emitter.onFilter('magic-link.validate', (decision, meta) => {
		const email = meta.email.toLowerCase();

		// Skips the extension's lists, role rules and rate limit; the user must still exist and be active
		if (BYPASS.some((rule) => matches(email, rule))) return { allowed: true, reason: null };

		if (DISPOSABLE_DOMAINS.includes(email.split('@')[1])) return { allowed: false, reason: 'disposable_email' };

		return decision;
	});

	emitter.onFilter('magic-link.email', (email, { user }) => {
		email.templateData.greeting = user.first_name ? `Hi ${user.first_name}` : 'Hi there';
		return email;
	});

	emitter.onFilter('magic-link.login', (payload, meta) => {
		if (meta.user.role === null) throw new Error('Users without a role cannot use magic links');
		return payload;
	});
};
