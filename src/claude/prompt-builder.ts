import { TrelloCard } from '../trello/types';

export class PromptBuilder {
  private rules: string[] = [];
  private knowledgeContext: string = '';

  setRules(rules: string[]): void {
    this.rules = rules;
  }

  setKnowledge(knowledgeContext: string): void {
    this.knowledgeContext = knowledgeContext;
  }

  build(card: TrelloCard): string {
    const sections: string[] = [];

    sections.push(`# Task: ${card.name}`);
    sections.push('');

    // Inject project knowledge if available
    if (this.knowledgeContext) {
      sections.push(this.knowledgeContext);
    }

    if (card.desc) {
      sections.push('## Description');
      sections.push(card.desc);
      sections.push('');
    }

    if (card.labels?.length) {
      const labelStr = card.labels.map((l) => l.name || l.color).join(', ');
      sections.push(`**Labels:** ${labelStr}`);
      sections.push('');
    }

    if (card.due) {
      const dueDate = new Date(card.due).toLocaleDateString();
      sections.push(`**Due:** ${dueDate}`);
      sections.push('');
    }

    if (card.checklists?.length) {
      sections.push('## Checklist');
      for (const checklist of card.checklists) {
        sections.push(`### ${checklist.name}`);
        for (const item of checklist.checkItems) {
          const mark = item.state === 'complete' ? 'x' : ' ';
          sections.push(`- [${mark}] ${item.name}`);
        }
        sections.push('');
      }
    }

    if (card.attachments?.length) {
      sections.push('## References');
      for (const att of card.attachments) {
        sections.push(`- [${att.name}](${att.url})`);
      }
      sections.push('');
    }

    if (this.rules.length > 0) {
      sections.push('## Project Rules');
      sections.push('You MUST follow these rules strictly:');
      for (const rule of this.rules) {
        sections.push(`- ${rule}`);
      }
      sections.push('');
    }

    // Detect if this is a bug from title/description/labels
    const isBug = this.isBugTask(card);

    if (isBug) {
      sections.push('## Instructions (BUG FIX)');
      sections.push('');
      sections.push('You MUST follow this exact sequence. Do NOT skip steps.');
      sections.push('');
      sections.push('### Step 1 — Investigate (DO NOT write code yet)');
      sections.push('- Trace the FULL flow of the reported bug end-to-end');
      sections.push('- Read every file involved in the chain (controller → use case → service → repository)');
      sections.push('- Check environment variables, config files, and external service integrations');
      sections.push('- Check git log for recent changes that may have introduced the bug');
      sections.push('- Identify the ROOT CAUSE — not just the symptom');
      sections.push('');
      sections.push('### Step 2 — Confirm root cause');
      sections.push('- Write a brief explanation of WHY the bug happens (not just WHERE)');
      sections.push('- Verify your hypothesis by reading related code paths');
      sections.push('');
      sections.push('### Step 3 — Implement the fix');
      sections.push('- Fix the ROOT CAUSE, not the symptom');
      sections.push('- Adding a try/catch, logging, or swallowing errors is NOT a fix unless the root cause is genuinely missing error handling');
      sections.push('- If the bug is "X is not working", the fix must make X work — not just log that X failed');
      sections.push('- If config/env vars are missing, document what needs to be added');
      sections.push('');
      sections.push('### Step 4 — Validate');
      sections.push('- Run `npx tsc --noEmit` to ensure no type errors');
      sections.push('- Verify the fix addresses the exact scenario described in the bug report');
      sections.push('- Check that you haven\'t broken adjacent functionality');
      sections.push('');
      sections.push('### Step 5 — Commit');
      sections.push('- Commit with message: "fix: <what was fixed and why>"');
      sections.push('- The commit message should explain the root cause, not just the change');
      sections.push('');
      sections.push('CRITICAL RULES:');
      sections.push('- NEVER mark a bug as "fixed" if you only added logging');
      sections.push('- NEVER swallow errors with empty .catch(() => {}) — if an error needs catching, handle it properly');
      sections.push('- If you cannot determine the root cause, say so explicitly instead of making superficial changes');
      sections.push('- If the fix requires environment/config changes, create a clear comment explaining what to configure');
    } else {
      sections.push('## Instructions (FEATURE / IMPROVEMENT)');
      sections.push('');
      sections.push('### Step 1 — Understand the codebase');
      sections.push('- Read CLAUDE.md and relevant existing code before making changes');
      sections.push('- Understand current patterns, naming conventions, and architecture');
      sections.push('');
      sections.push('### Step 2 — Implement');
      sections.push('- Follow project rules and conventions strictly');
      sections.push('- Implement exactly what the task asks — no more, no less');
      sections.push('- Use existing patterns in the codebase as reference');
      sections.push('');
      sections.push('### Step 3 — Validate');
      sections.push('- Run `npx tsc --noEmit` to ensure no type errors');
      sections.push('- Verify all imports resolve correctly');
      sections.push('');
      sections.push('### Step 4 — Commit');
      sections.push('- Commit with a clear message describing what was implemented');
    }

    sections.push('');
    sections.push('IMPORTANT: This is a fully automated pipeline. Do NOT ask for confirmation. Do NOT wait for user input. Execute all changes immediately, commit, and finish.');
    sections.push('Do NOT commit unrelated files like .trello-pilot-origins.json, .trello-pilot.json, or any config/env files.');
    sections.push('');
    sections.push(`Trello card: ${card.url}`);

    return sections.join('\n');
  }

  buildReview(card: TrelloCard, branchName: string, prUrl?: string): string {
    const sections: string[] = [];

    sections.push('# Code Review');
    sections.push('');
    sections.push(`## Task: ${card.name}`);
    if (prUrl) {
      sections.push(`## Pull Request: ${prUrl}`);
    }
    sections.push('');

    if (card.desc) {
      sections.push('## Original Description');
      sections.push(card.desc);
      sections.push('');
    }

    if (card.checklists?.length) {
      sections.push('## Acceptance Criteria');
      for (const checklist of card.checklists) {
        sections.push(`### ${checklist.name}`);
        for (const item of checklist.checkItems) {
          const mark = item.state === 'complete' ? 'x' : ' ';
          sections.push(`- [${mark}] ${item.name}`);
        }
        sections.push('');
      }
    }

    if (this.rules.length > 0) {
      sections.push('## Project Rules to Validate');
      for (const rule of this.rules) {
        sections.push(`- ${rule}`);
      }
      sections.push('');
    }

    sections.push('## Review Instructions');
    sections.push(`You are reviewing the code changes on branch \`${branchName}\`.`);
    sections.push('');
    sections.push('1. Run `git diff main...HEAD` to see ALL changes made in this branch');
    sections.push('2. Read every changed file carefully');
    sections.push('3. Analyze the changes against the criteria below:');
    sections.push('');
    sections.push('### Bugs & Logic Errors');
    sections.push('- Race conditions, null/undefined access, off-by-one errors');
    sections.push('- Missing error handling, uncaught promises');
    sections.push('- Wrong conditional logic, missing edge cases');
    sections.push('');
    sections.push('### Security');
    sections.push('- SQL/NoSQL injection, XSS, command injection');
    sections.push('- Hardcoded secrets, exposed credentials');
    sections.push('- Missing input validation at system boundaries');
    sections.push('- Insecure direct object references');
    sections.push('');
    sections.push('### Project Rules Compliance');
    sections.push('- Verify every project rule listed above is followed');
    sections.push('- Check architecture boundaries (Clean Architecture layers)');
    sections.push('- Verify typing (no `any`, proper interfaces)');
    sections.push('');
    sections.push('### Code Quality');
    sections.push('- Dead code, unused imports, duplicated logic');
    sections.push('- Naming clarity (Clean Code)');
    sections.push('- SOLID principle violations');
    sections.push('- Performance issues (N+1 queries, unnecessary re-renders, missing memoization)');
    sections.push('');
    sections.push('### Completeness');
    sections.push('- Does the implementation fully address the task description?');
    sections.push('- Are all checklist items satisfied?');
    sections.push('');
    sections.push('## Output Format');
    sections.push('For each issue found, output:');
    sections.push('- **File**: path');
    sections.push('- **Line**: number');
    sections.push('- **Severity**: CRITICAL / WARNING / SUGGESTION');
    sections.push('- **Issue**: description');
    sections.push('- **Fix**: suggested change');
    sections.push('');
    sections.push('### Superficial Fix Detection (CRITICAL)');
    sections.push('Reject and fix if the implementation ONLY does:');
    sections.push('- Added try/catch or .catch() without addressing the root cause');
    sections.push('- Added logging/console.log without fixing the actual problem');
    sections.push('- Changed error messages without fixing the error');
    sections.push('- Swallowed errors that should be handled properly');
    sections.push('- Added "defensive" null checks that mask the real issue');
    sections.push('If the task is a bug fix, verify the ROOT CAUSE is addressed, not just the symptom.');
    sections.push('');
    sections.push('## Output Format');
    sections.push('For each issue found, output:');
    sections.push('- **File**: path');
    sections.push('- **Line**: number');
    sections.push('- **Severity**: CRITICAL / WARNING / SUGGESTION');
    sections.push('- **Issue**: description');
    sections.push('- **Fix**: suggested change');
    sections.push('');
    sections.push('If issues are found, fix them directly in the code. Commit with message: "fix: code review fixes for <task-name>"');
    sections.push('If no issues, report "Review passed — no issues found."');
    sections.push('');
    sections.push('IMPORTANT: This is a fully automated pipeline. Do NOT ask for confirmation. Do NOT wait for user input. Execute all changes immediately, commit, and finish.');
    sections.push('Do NOT commit unrelated files like .trello-pilot-origins.json, .trello-pilot.json, or any config/env files.');
    sections.push('');
    sections.push(`Trello card: ${card.url}`);

    return sections.join('\n');
  }

  buildQA(card: TrelloCard, branchName: string): string {
    const sections: string[] = [];

    sections.push('# QA — Quality Assurance');
    sections.push('');
    sections.push(`## Task: ${card.name}`);
    sections.push('');

    if (card.desc) {
      sections.push('## Original Description');
      sections.push(card.desc);
      sections.push('');
    }

    if (card.checklists?.length) {
      sections.push('## Acceptance Criteria');
      for (const checklist of card.checklists) {
        sections.push(`### ${checklist.name}`);
        for (const item of checklist.checkItems) {
          const mark = item.state === 'complete' ? 'x' : ' ';
          sections.push(`- [${mark}] ${item.name}`);
        }
        sections.push('');
      }
    }

    sections.push('## QA Instructions');
    sections.push(`You are running QA on branch \`${branchName}\`.`);
    sections.push('');
    sections.push('### Step 1 — Understand Changes');
    sections.push('Run `git diff main...HEAD` to see all changes in this branch.');
    sections.push('');
    sections.push('### Step 2 — Run Existing Tests');
    sections.push('Check if the project has tests and run them:');
    sections.push('- Backend: `cd backend && npm test` (if exists)');
    sections.push('- Frontend: `cd frontend && npm test` (if exists)');
    sections.push('- If no test suite exists, skip to Step 3');
    sections.push('');
    sections.push('### Step 3 — Manual Verification');
    sections.push('- Verify the code compiles: `cd backend && npx tsc --noEmit` and `cd frontend && npx tsc --noEmit`');
    sections.push('- Check for lint errors if linter is configured');
    sections.push('- Verify all imports resolve correctly');
    sections.push('- Verify no console.log or debug code left behind');
    sections.push('');
    sections.push('### Step 4 — Functional Validation');
    sections.push('- Re-read the task description and acceptance criteria');
    sections.push('- Verify the implementation addresses every requirement');
    sections.push('- Check edge cases are handled');
    sections.push('');
    sections.push('### Step 4.5 — Root Cause Verification (for bug fixes)');
    sections.push('- If this was a bug fix, verify the ROOT CAUSE is addressed');
    sections.push('- Check: does the fix actually solve the problem, or just add logging/error handling?');
    sections.push('- If the fix only added try/catch, logging, or error messages WITHOUT fixing the underlying issue → FAIL the QA');
    sections.push('- A proper bug fix must change the BEHAVIOR, not just the error output');
    sections.push('- If the fix is insufficient, implement the proper fix yourself before proceeding');
    sections.push('');
    sections.push('### Step 5 — If ALL checks pass');
    sections.push('1. Switch to main: `git checkout main && git pull origin main`');
    sections.push(`2. Merge the branch: \`git merge ${branchName}\``);
    sections.push('3. Push to remote: `git push origin main`');
    sections.push(`4. Delete the feature branch: \`git branch -d ${branchName}\``);
    sections.push('5. Report: "QA PASSED — merged to main and pushed"');
    sections.push('');
    sections.push('### Step 5 — If ANY check fails');
    sections.push('1. Fix the issues directly in the code');
    sections.push('2. Commit with message: "fix: QA fixes for <task-name>"');
    sections.push('3. Re-run the failing checks');
    sections.push('4. If all pass now, proceed with merge (Step 5 above)');
    sections.push('5. If still failing, report the failures and do NOT merge');
    sections.push('');
    sections.push('IMPORTANT: This is a fully automated pipeline. Do NOT ask for confirmation. Do NOT wait for user input. Execute all changes immediately, commit, and finish.');
    sections.push('Do NOT commit unrelated files like .trello-pilot-origins.json, .trello-pilot.json, or any config/env files.');
    sections.push('');
    sections.push(`Trello card: ${card.url}`);

    return sections.join('\n');
  }

  isBugTask(card: TrelloCard): boolean {
    const text = `${card.name} ${card.desc || ''}`.toLowerCase();
    const bugKeywords = [
      'bug', 'erro', 'error', 'fix', 'nao funciona', 'nao funciona',
      'nao esta', 'nao esta', 'quebr', 'broken', 'crash', 'fail',
      'problema', 'issue', 'defeito', 'nao consigo', 'nao consigo',
      'nao chega', 'nao chega', 'sem funcionar', 'indisponiv', 'indisponiv',
      'urgente', 'urgent',
    ];
    const hasBugLabel = card.labels?.some((l) =>
      l.color === 'red' || l.name?.toLowerCase().includes('bug'),
    );
    return hasBugLabel || bugKeywords.some((kw) => text.includes(kw));
  }

  buildBranchName(card: TrelloCard, prefix: string): string {
    // Use card number + short slug: feat/233-criar-cotacao
    const num = card.idShort || '';
    const slug = card.name
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9\s-]/g, '')
      .replace(/\s+/g, '-')
      .substring(0, 25)
      .replace(/-$/, '');

    return `${prefix}${num}-${slug}`;
  }
}
