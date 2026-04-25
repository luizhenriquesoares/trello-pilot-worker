import { describe, it, expect } from 'vitest';
import { resolveProjectForList, resolveProjectByLabel, isProjectList } from './board-config.js';
import type { BoardConfig } from './types.js';

const config: BoardConfig = {
  boardId: 'b1',
  lists: { doing: 'l-doing', review: 'l-review', qa: 'l-qa', done: 'l-done' },
  triageListId: 'l-triage',
  projectLists: [
    { id: 'l-portal', name: 'Portal Bb2', repoUrl: 'r1', baseBranch: 'main', branchPrefix: 'feat/' },
    { id: 'l-mais', name: 'Mais Milhas V2', repoUrl: 'r2', baseBranch: 'main', branchPrefix: 'feat/' },
    // Label-routed (no `id`):
    { name: 'Admin API', repoUrl: 'r3', baseBranch: 'main', branchPrefix: 'feat/' },
    { name: 'Quotation Lambda', repoUrl: 'r4', baseBranch: 'main', branchPrefix: 'feat/' },
  ],
  rules: [],
};

describe('resolveProjectForList', () => {
  it('returns the matching project by list id', () => {
    expect(resolveProjectForList(config, 'l-portal')?.name).toBe('Portal Bb2');
  });

  it('returns undefined for unknown list ids (e.g. workflow lists)', () => {
    expect(resolveProjectForList(config, 'l-doing')).toBeUndefined();
    expect(resolveProjectForList(config, 'l-triage')).toBeUndefined();
  });

  it('does not match label-routed projects (no id) by accident', () => {
    expect(resolveProjectForList(config, '')).toBeUndefined();
  });
});

describe('resolveProjectByLabel', () => {
  it('matches a label-routed project by exact name', () => {
    const result = resolveProjectByLabel(config, [{ name: 'Admin API' }]);
    expect(result?.name).toBe('Admin API');
  });

  it('is case-insensitive and trims whitespace', () => {
    expect(resolveProjectByLabel(config, [{ name: '  admin api ' }])?.name).toBe('Admin API');
    expect(resolveProjectByLabel(config, [{ name: 'QUOTATION LAMBDA' }])?.name).toBe('Quotation Lambda');
  });

  it('refuses to route to projects that already have a dedicated list', () => {
    // A card with the "Portal Bb2" label landing in triage shouldn't override
    // the dedicated-list routing — it would mask a misconfigured card.
    const result = resolveProjectByLabel(config, [{ name: 'Portal Bb2' }]);
    expect(result).toBeUndefined();
  });

  it('returns undefined when no labels match any project', () => {
    expect(resolveProjectByLabel(config, [{ name: 'random-label' }])).toBeUndefined();
    expect(resolveProjectByLabel(config, [])).toBeUndefined();
  });

  it('ignores empty / whitespace-only / undefined label names', () => {
    expect(resolveProjectByLabel(config, [{ name: '' }, { name: '   ' }, {}])).toBeUndefined();
  });

  it('picks the first matching label when the card has multiple', () => {
    // First matching project name in the list wins — deterministic.
    const result = resolveProjectByLabel(config, [
      { name: 'unrelated' },
      { name: 'Admin API' },
      { name: 'Quotation Lambda' },
    ]);
    expect(result?.name).toBe('Admin API');
  });
});

describe('isProjectList', () => {
  it('returns true for ids that match a project entry', () => {
    expect(isProjectList(config, 'l-portal')).toBe(true);
    expect(isProjectList(config, 'l-mais')).toBe(true);
  });

  it('returns false for the triage list (it is not a project list itself)', () => {
    expect(isProjectList(config, 'l-triage')).toBe(false);
  });

  it('returns false for workflow lists and unknown ids', () => {
    expect(isProjectList(config, 'l-doing')).toBe(false);
    expect(isProjectList(config, 'unknown')).toBe(false);
  });
});
