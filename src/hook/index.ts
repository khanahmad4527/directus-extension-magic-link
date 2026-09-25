import { defineHook } from '@directus/extensions-sdk';
import { readConfig } from '../shared/config.js';
import { ensureTable } from '../shared/table.js';

const DAY = 24 * 60 * 60 * 1000;

export default defineHook(({ init, schedule }, { env, database, logger }) => {
	const config = readConfig(env);

	init('app.after', async () => {
		try {
			await ensureTable(database, config.table);
		} catch (error) {
			logger.error(error, `[magic-link] could not create table "${config.table}"`);
		}
	});

	schedule('0 * * * *', async () => {
		try {
			await ensureTable(database, config.table);

			await database(config.table)
				.whereIn('status', ['pending', 'sent'])
				.where('expires_at', '<', new Date())
				.update({ status: 'expired' });

			if (config.retentionDays > 0) {
				await database(config.table)
					.where('created_at', '<', new Date(Date.now() - config.retentionDays * DAY))
					.delete();
			}
		} catch (error) {
			logger.warn(error, '[magic-link] cleanup failed');
		}
	});
});
