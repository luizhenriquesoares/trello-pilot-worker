import { readFileSync } from 'node:fs';
import type { BoardConfig, ProjectList } from './types.js';

export function loadBoardConfig(): BoardConfig {
  // Try BOARD_CONFIG_JSON env var first, then config.json file
  const jsonStr = process.env.BOARD_CONFIG_JSON;
  if (jsonStr) {
    return JSON.parse(jsonStr) as BoardConfig;
  }

  const configPath = process.env.CONFIG_PATH || './config.json';
  try {
    const raw = readFileSync(configPath, 'utf-8');
    return JSON.parse(raw) as BoardConfig;
  } catch (err) {
    throw new Error(`Failed to load board config from ${configPath}: ${(err as Error).message}`);
  }
}

export function resolveProjectForList(config: BoardConfig, listId: string): ProjectList | undefined {
  return config.projectLists.find((p) => p.id === listId);
}

export function isProjectList(config: BoardConfig, listId: string): boolean {
  return config.projectLists.some((p) => p.id === listId);
}

/**
 * Pick the project for a card that landed in the triage list. The card's Trello
 * labels are matched (case-insensitive) against project `name` fields. Only
 * projects without a dedicated list are eligible — a label collision with a
 * mapped project is ignored, since mapped projects use `id` for routing.
 */
export function resolveProjectByLabel(
  config: BoardConfig,
  cardLabels: { name?: string }[],
): ProjectList | undefined {
  if (!cardLabels.length) return undefined;
  const labelNames = cardLabels
    .map((l) => l.name?.trim().toLowerCase())
    .filter((n): n is string => Boolean(n));
  if (!labelNames.length) return undefined;
  return config.projectLists.find(
    (p) => !p.id && labelNames.includes(p.name.trim().toLowerCase()),
  );
}
