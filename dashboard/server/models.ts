/**
 * Which model the platform runs on.
 *
 * One setting, not nineteen. Every agent inherits the platform model unless its
 * own file names one, which keeps the fleet page about what the agents *do* -
 * a dropdown next to each of nineteen names is nineteen decisions nobody wants
 * to make, and in practice they were all set to the same thing anyway.
 *
 * Held here rather than in `config` because config is frozen at import: this
 * one is changed from the dashboard at runtime and persisted, so a restart does
 * not quietly put the fleet back on whatever the env file says.
 */
import { config } from './config.ts';
import { settings } from './db/index.ts';

export const MODEL_CHOICES = [
  {
    alias: 'haiku',
    id: 'claude-haiku-4-5',
    label: 'Haiku 4.5',
    hint: 'Fastest and cheapest. Enough for retrieval, log reading and drafting.',
  },
  {
    alias: 'sonnet',
    id: 'claude-sonnet-5',
    label: 'Sonnet 5',
    hint: 'Balanced. Better code changes and sharper review at moderate cost.',
  },
  {
    alias: 'opus',
    id: 'claude-opus-5',
    label: 'Opus 5',
    hint: 'Strongest reasoning. Reserve it for architecture and hard diagnosis.',
  },
] as const;

export type ModelAlias = (typeof MODEL_CHOICES)[number]['alias'];

const SETTING_KEY = 'platform_model';

/** Accepts an alias or a full model id; returns a full model id. */
export function resolveModelId(value: string): string {
  const v = value.trim();
  return MODEL_CHOICES.find((m) => m.alias === v)?.id ?? v;
}

/** The short alias for a model id, for display. Full ids pass through. */
export function modelAlias(id: string): string {
  return MODEL_CHOICES.find((m) => m.id === id)?.alias ?? id.replace(/^claude-/, '');
}

let current = resolveModelId(config.anthropic.orchestratorModel);

/** The model the orchestrator and every inheriting agent runs on. */
export const platformModel = (): string => current;

/** Read the persisted choice, if one was made. Called once, at boot. */
export async function hydratePlatformModel(): Promise<void> {
  try {
    const saved = await settings.get(SETTING_KEY);
    if (saved) current = resolveModelId(saved);
  } catch {
    // No settings table yet on a database from an older build - the env default
    // stands, and the first save from the dashboard creates the row.
  }
}

/** Change the platform model and remember it. Applies to the next mission. */
export async function setPlatformModel(alias: string): Promise<string> {
  const id = resolveModelId(alias);
  if (!MODEL_CHOICES.some((m) => m.id === id)) {
    throw new Error(`Unknown model "${alias}". Choose one of: ${MODEL_CHOICES.map((m) => m.alias).join(', ')}`);
  }
  current = id;
  await settings.set(SETTING_KEY, id);
  return id;
}
