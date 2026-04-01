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
