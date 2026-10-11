import type { Knex } from 'knex';

export type TokenStatus =
	'received' | 'pending' | 'sent' | 'failed' | 'cancelled' | 'used' | 'superseded' | 'expired' | 'locked' | 'rejected';

export type TokenRecord = {
	id: number;
	token_hash: string | null;
	email: string;
	user: string | null;
	status: TokenStatus;
	reason: string | null;
	redirect_url: string | null;
	ip: string | null;
	user_agent: string | null;
	otp_attempts: number;
	expires_at: Date | string | null;
	used_at: Date | string | null;
	created_at: Date | string;
};

const ensured = new Map<string, Promise<void>>();

export function ensureTable(database: Knex, table: string): Promise<void> {
	let pending = ensured.get(table);

	if (!pending) {
		pending = prepareTable(database, table);
		pending.catch(() => ensured.delete(table));
		ensured.set(table, pending);
	}

	return pending;
}

async function prepareTable(database: Knex, table: string): Promise<void> {
	await createTable(database, table);

	// Added in 1.0.1; tables created by 1.0.0 don't have it
	await addColumn(database, table, 'otp_attempts', (t) => t.integer('otp_attempts').notNullable().defaultTo(0));
}

async function createTable(database: Knex, table: string): Promise<void> {
	if (await database.schema.hasTable(table)) return;

	try {
		await database.schema.createTable(table, (t) => {
			t.increments('id').primary();
			t.string('token_hash', 64).nullable().unique();
			t.string('email', 255).notNullable().index();
			t.uuid('user').nullable().index();
			t.string('status', 32).notNullable();
			t.string('reason', 255).nullable();
			t.text('redirect_url').nullable();
			t.string('ip', 255).nullable().index();
			t.text('user_agent').nullable();
			t.integer('otp_attempts').notNullable().defaultTo(0);
			t.timestamp('expires_at', { useTz: true }).nullable();
			t.timestamp('used_at', { useTz: true }).nullable();
			t.timestamp('created_at', { useTz: true }).notNullable().index();
		});
	} catch (error) {
		// Another Directus instance may have created it concurrently
		if (!(await database.schema.hasTable(table))) throw error;
	}
}

async function addColumn(database: Knex, table: string, column: string, define: (t: Knex.AlterTableBuilder) => void): Promise<void> {
	if (await database.schema.hasColumn(table, column)) return;

	try {
		await database.schema.alterTable(table, define);
	} catch (error) {
		if (!(await database.schema.hasColumn(table, column))) throw error;
	}
}
