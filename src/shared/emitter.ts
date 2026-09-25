import type { EventContext } from '@directus/types';

// Directus types the extension-scoped emitter as `any`; this is the part of its API the extension uses.
export type ExtensionEmitter = {
	emitFilter<T>(event: string, payload: T, meta: Record<string, unknown>, context?: EventContext | null): Promise<T>;
	emitAction(event: string, meta: Record<string, unknown>, context?: EventContext | null): void;
};
