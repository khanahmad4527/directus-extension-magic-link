import type { Knex } from 'knex';

type SettingsRow = {
	project_name: string | null;
	project_color: string | null;
	project_logo: string | null;
	project_url: string | null;
	default_language: string | null;
};

export type ProjectSettings = {
	projectName: string;
	projectColor: string | null;
	projectLogo: string | null;
	projectUrl: string;
	defaultLanguage: string | null;
};

export async function readSettings(database: Knex): Promise<ProjectSettings> {
	const row = await database<SettingsRow>('directus_settings')
		.select('project_name', 'project_color', 'project_logo', 'project_url', 'default_language')
		.first();

	return {
		projectName: row?.project_name || 'Directus',
		projectColor: row?.project_color || null,
		projectLogo: row?.project_logo || null,
		projectUrl: row?.project_url || '',
		defaultLanguage: row?.default_language || null,
	};
}
