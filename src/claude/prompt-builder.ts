import { TrelloCard } from '../trello/types.js';

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
      sections.push('- VALIDATE YOUR ASSUMPTIONS: for each hypothesis, verify by reading actual code:');
      sections.push('  - "This component renders here" → trace from router/App.tsx to confirm');
      sections.push('  - "The user reaches state X" → check if state X is reachable in the reported flow');
      sections.push('  - "This event fires when..." → check the listener is attached where you think');
      sections.push('- Watch for LAYERED BUGS: the obvious fix may reveal a deeper issue');
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
      sections.push('- Before committing, run formatting if tools exist:');
      sections.push('  - `npx eslint --fix . 2>/dev/null || true` (fix lint issues)');
      sections.push('  - `npx prettier --write "**/*.{ts,tsx,js,jsx}" 2>/dev/null || true` (format code)');
      sections.push('  - Only run these if the tools are installed (the || true prevents failure if not installed)');
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
      sections.push('### Step 1 — Map the architecture (DO NOT code yet)');
      sections.push('- Read CLAUDE.md and relevant code');
      sections.push('- CRITICAL: Before touching ANY component, answer these questions:');
      sections.push('  1. WHERE is this feature supposed to work? (which page/route/scenario)');
      sections.push('  2. WHICH components render on that page? (trace the full component tree)');
      sections.push('  3. Are there MULTIPLE components doing similar things? (e.g., separate chat on homepage vs inner pages)');
      sections.push('  4. Are there conditional returns (if x return null) that could prevent your code from running?');
      sections.push('  5. What is the REAL user state when they reach the trigger point?');
      sections.push('');
      sections.push('### Step 2 — Validate your premises BEFORE coding');
      sections.push('This is the most important step. Most bugs come from wrong assumptions.');
      sections.push('');
      sections.push('For each assumption you make, verify it by reading the actual code:');
      sections.push('- "The user will be in state X" → grep for state transitions, check if state X is reachable in the target flow');
      sections.push('- "Component Y renders on page Z" → trace from App.tsx/router down to verify Y is mounted on Z');
      sections.push('- "Event E will fire when..." → check the event source and verify it fires in the target scenario');
      sections.push('- "This hook runs on the homepage" → check if the parent component returns null before the hook');
      sections.push('');
      sections.push('COMMON TRAPS to check for:');
      sections.push('- Component does `if (condition) return null` BEFORE your hook/effect → your code never runs');
      sections.push('- Using document.addEventListener("mouseleave") → unreliable, use document.documentElement instead');
      sections.push('- Waiting for a state the user never reaches (e.g., user abandons BEFORE the state you check)');
      sections.push('- Multiple instances of similar components (global ChatWidget vs page-specific chat)');
      sections.push('');
      sections.push('### Step 3 — Implement');
      sections.push('- Follow project rules and conventions strictly');
      sections.push('- Implement exactly what the task asks — no more, no less');
      sections.push('- Put your code in the component that ACTUALLY RENDERS in the target scenario');
      sections.push('- Use browser-standard APIs (documentElement not document for mouse events)');
      sections.push('');
      sections.push('### Step 4 — Instrument and verify');
      sections.push('- Add temporary console.log at key points to confirm your code path executes:');
      sections.push('  - Log when the trigger condition is met (e.g., "exit intent: user leaving")');
      sections.push('  - Log the state value you depend on (e.g., "chatState:", chatState)');
      sections.push('  - Log inside conditional blocks to confirm they run');
      sections.push('- Run `npx tsc --noEmit` to ensure no type errors');
      sections.push('- MENTALLY SIMULATE the user journey step by step:');
      sections.push('  1. User opens page → which components mount?');
      sections.push('  2. User interacts → what state changes?');
      sections.push('  3. User triggers the feature → does your code actually execute?');
      sections.push('  4. If any step fails → your implementation is wrong');
      sections.push('- Remove the console.logs after verification');
      sections.push('');
      sections.push('### Step 5 — Commit');
      sections.push('- Before committing, run formatting if tools exist:');
      sections.push('  - `npx eslint --fix . 2>/dev/null || true` (fix lint issues)');
      sections.push('  - `npx prettier --write "**/*.{ts,tsx,js,jsx}" 2>/dev/null || true` (format code)');
      sections.push('  - Only run these if the tools are installed (the || true prevents failure if not installed)');
      sections.push('- Commit with a clear message describing what was implemented and WHERE');
    }

    sections.push('');
    sections.push('IMPORTANT: This is a fully automated pipeline. Do NOT ask for confirmation. Do NOT wait for user input. Execute all changes immediately, commit, and finish.');
    sections.push('Do NOT commit unrelated files like .trello-pilot-origins.json, .trello-pilot.json, or any config/env files.');
    sections.push('Do NOT add Co-Authored-By lines in commit messages. Do NOT use --author flag. Commit as the default git user.');
    sections.push('');
    sections.push(`Trello card: ${card.url}`);

    return sections.join('\n');
  }

  buildRetry(card: TrelloCard, retryFeedback: string): string {
    const sections: string[] = [];

    sections.push('# RETRY: Task was previously implemented but did not work');
    sections.push('');
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

    sections.push('## Previous Implementation Feedback');
    sections.push('The stakeholder reported these issues with the previous implementation:');
    sections.push('');
    sections.push(retryFeedback);
    sections.push('');

    if (this.rules.length > 0) {
      sections.push('## Project Rules');
      sections.push('You MUST follow these rules strictly:');
      for (const rule of this.rules) {
        sections.push(`- ${rule}`);
      }
      sections.push('');
    }

    sections.push('## Instructions (RETRY)');
    sections.push('');
    sections.push('This task was previously implemented but the stakeholder moved it back because it did not work correctly.');
    sections.push('You MUST follow this exact sequence. Do NOT skip steps.');
    sections.push('');
    sections.push('### Step 1 — Understand the previous attempt');
    sections.push('- Run `git log --oneline -20` to see recent commits related to this task');
    sections.push('- Run `git diff main~5...main` or similar to review what was previously changed');
    sections.push('- Read the feedback above carefully — this is what went wrong');
    sections.push('');
    sections.push('### Step 2 — Diagnose the root cause');
    sections.push('- Identify WHY the previous implementation did not work based on the feedback');
    sections.push('- Do NOT assume the previous approach was correct — it failed');
    sections.push('- Trace the full execution path to find the gap between what was done and what was needed');
    sections.push('');
    sections.push('### Step 3 — Implement the fix');
    sections.push('- Fix the root cause identified in Step 2');
    sections.push('- If the previous approach was fundamentally wrong, use a different approach');
    sections.push('- Do NOT just add logging or error handling — actually fix the behavior');
    sections.push('- Do NOT repeat the same approach if it already failed');
    sections.push('');
    sections.push('### Step 4 — Validate thoroughly');
    sections.push('- Run `npx tsc --noEmit` to ensure no type errors');
    sections.push('- Mentally simulate the exact scenario described in the feedback');
    sections.push('- Verify your fix addresses every point in the stakeholder feedback');
    sections.push('- Check that you have not broken adjacent functionality');
    sections.push('');
    sections.push('### Step 5 — Commit');
    sections.push('- Before committing, run formatting if tools exist:');
    sections.push('  - `npx eslint --fix . 2>/dev/null || true` (fix lint issues)');
    sections.push('  - `npx prettier --write "**/*.{ts,tsx,js,jsx}" 2>/dev/null || true` (format code)');
    sections.push('  - Only run these if the tools are installed (the || true prevents failure if not installed)');
    sections.push('- Commit with message: "fix: retry — <what was fixed based on feedback>"');
    sections.push('- The commit message should reference the feedback and explain the fix');
    sections.push('');
    sections.push('CRITICAL RULES:');
    sections.push('- The previous implementation FAILED. Do not assume it was close to correct.');
    sections.push('- Read the feedback CAREFULLY. The stakeholder is telling you exactly what is wrong.');
    sections.push('- If the feedback mentions something does not work, verify it works AFTER your fix.');
    sections.push('- NEVER mark as fixed if you only added logging or error handling.');
    sections.push('');
    sections.push('IMPORTANT: This is a fully automated pipeline. Do NOT ask for confirmation. Do NOT wait for user input. Execute all changes immediately, commit, and finish.');
    sections.push('Do NOT commit unrelated files like .trello-pilot-origins.json, .trello-pilot.json, or any config/env files.');
    sections.push('Do NOT add Co-Authored-By lines in commit messages. Do NOT use --author flag. Commit as the default git user.');
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
    sections.push('### Execution Path Verification (CRITICAL — check FIRST)');
    sections.push('- For EVERY new function/component/hook added, trace the rendering chain:');
    sections.push('  - Is the parent component conditionally rendered? (e.g., `if (x) return null`)');
    sections.push('  - Are there early returns BEFORE the new code that prevent execution?');
    sections.push('  - On which pages/routes does this code actually run?');
    sections.push('  - If the task targets a specific page, does the code run ON THAT PAGE?');
    sections.push('- If new code is placed inside a component that returns null for the target scenario → mark as CRITICAL');
    sections.push('- Example: adding exit-intent to ChatWidget that does `if (isHomePage) return null` → code never runs on homepage');
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
    sections.push('If issues are found, fix them directly in the code.');
    sections.push('- Before committing, run formatting if tools exist:');
    sections.push('  - `npx eslint --fix . 2>/dev/null || true` (fix lint issues)');
    sections.push('  - `npx prettier --write "**/*.{ts,tsx,js,jsx}" 2>/dev/null || true` (format code)');
    sections.push('  - Only run these if the tools are installed (the || true prevents failure if not installed)');
    sections.push('Commit with message: "fix: code review fixes for <task-name>"');
    sections.push('If no issues, report "Review passed — no issues found."');
    sections.push('');
    sections.push('IMPORTANT: This is a fully automated pipeline. Do NOT ask for confirmation. Do NOT wait for user input. Execute all changes immediately, commit, and finish.');
    sections.push('Do NOT commit unrelated files like .trello-pilot-origins.json, .trello-pilot.json, or any config/env files.');
    sections.push('Do NOT add Co-Authored-By lines in commit messages. Do NOT use --author flag. Commit as the default git user.');
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

    // Step 1 — Understand Changes
    sections.push('### Step 1 — Understand Changes');
    sections.push('Run `git diff main...HEAD` to see all changes in this branch.');
    sections.push('Identify which files were added/modified and categorize them:');
    sections.push('- New endpoints / routes');
    sections.push('- New components / pages');
    sections.push('- New use cases / services');
    sections.push('- Modified existing code');
    sections.push('Keep this list — you will need it in Step 5 to verify test coverage.');
    sections.push('');

    // Step 2 — Type Check
    sections.push('### Step 2 — Type Check');
    sections.push('Run `npx tsc --noEmit` in each project directory (backend, frontend, or root).');
    sections.push('- If the project has a `tsconfig.json`, run the type check');
    sections.push('- Fix any type errors before proceeding');
    sections.push('- If no TypeScript config exists, skip this step');
    sections.push('');

    // Step 3 — Detect Test Framework
    sections.push('### Step 3 — Detect Test Framework');
    sections.push('Check if the project has a test framework configured:');
    sections.push('1. Read `package.json` (root, backend/, frontend/) and look for:');
    sections.push('   - `scripts.test` — does it exist and is it NOT `echo "Error: no test specified" && exit 1`?');
    sections.push('   - `devDependencies` or `dependencies` containing: `jest`, `vitest`, `mocha`, `@testing-library/*`');
    sections.push('2. Check for config files: `jest.config.*`, `vitest.config.*`, `.mocharc.*`');
    sections.push('3. Check for existing test directories: `__tests__/`, `test/`, `tests/`, `*.spec.*`, `*.test.*`');
    sections.push('');
    sections.push('Record what you find:');
    sections.push('- `HAS_TEST_FRAMEWORK`: true/false');
    sections.push('- `TEST_COMMAND`: the command to run tests (e.g., `npm test`, `npx jest`, `npx vitest run`)');
    sections.push('- `HAS_EXISTING_TESTS`: true/false (are there any test files?)');
    sections.push('');

    // Step 4 — Run Existing Tests
    sections.push('### Step 4 — Run Existing Tests');
    sections.push('If `HAS_TEST_FRAMEWORK` is true AND `HAS_EXISTING_TESTS` is true:');
    sections.push('1. Run the test suite: `TEST_COMMAND` (e.g., `npm test`, `npx jest --passWithNoTests`, `npx vitest run`)');
    sections.push('2. If tests fail:');
    sections.push('   - Check if the failures are caused by the changes in this branch');
    sections.push('   - If yes → fix the code and commit: "fix: QA test fixes for <task-name>"');
    sections.push('   - If tests were already broken on main → note it but do not block');
    sections.push('3. ALL tests must pass before proceeding');
    sections.push('');

    // Step 5 — Test Coverage for New Code
    sections.push('### Step 5 — Verify Test Coverage for New Code (CRITICAL)');
    sections.push('Using the list from Step 1, check if the new/changed code has corresponding tests:');
    sections.push('');
    sections.push('For each new file added in the branch, check:');
    sections.push('- New endpoint/controller → should have a `*.spec.ts` or `*.test.ts` testing the route');
    sections.push('- New use case/service → should have a `*.spec.ts` or `*.test.ts` testing the business logic');
    sections.push('- New React component → should have a `*.test.tsx` testing rendering and interactions');
    sections.push('- New utility function → should have a `*.test.ts` testing inputs/outputs');
    sections.push('');
    sections.push('If `HAS_TEST_FRAMEWORK` is true but tests are MISSING for new code:');
    sections.push('- Mark as **WARNING: missing test coverage**');
    sections.push('- Proceed to Step 6 to write the missing tests');
    sections.push('');
    sections.push('If `HAS_TEST_FRAMEWORK` is false:');
    sections.push('- Skip test creation — do NOT install a test framework');
    sections.push('- Log: "No test framework configured — skipping automated test enforcement"');
    sections.push('');

    // Step 6 — Write Missing Tests
    sections.push('### Step 6 — Write Missing Tests');
    sections.push('If `HAS_TEST_FRAMEWORK` is true AND tests are missing for new code:');
    sections.push('');
    sections.push('1. Create test files following the project\'s existing test conventions:');
    sections.push('   - Same directory as source with `.spec.ts` / `.test.ts` suffix, OR');
    sections.push('   - Mirror path under `__tests__/` directory, OR');
    sections.push('   - Follow whatever pattern existing tests in the project use');
    sections.push('');
    sections.push('2. Write basic tests covering:');
    sections.push('   - **Happy path**: the main expected behavior works');
    sections.push('   - **Input validation**: invalid inputs return proper errors');
    sections.push('   - **Edge cases**: null/undefined, empty arrays, boundary values');
    sections.push('');
    sections.push('3. For backend endpoints, test:');
    sections.push('   - Correct status codes (200, 201, 400, 404, etc.)');
    sections.push('   - Response shape matches expected interface');
    sections.push('   - Auth/permission checks if applicable');
    sections.push('');
    sections.push('4. For use cases/services, test:');
    sections.push('   - Mock dependencies (repositories, external services)');
    sections.push('   - Verify the business logic produces correct output');
    sections.push('   - Verify error cases throw appropriate exceptions');
    sections.push('');
    sections.push('5. For React components, test:');
    sections.push('   - Component renders without crashing');
    sections.push('   - Key elements are present in the output');
    sections.push('   - User interactions trigger expected behavior');
    sections.push('');
    sections.push('6. Run the new tests: `TEST_COMMAND`');
    sections.push('7. If tests fail, fix them until they pass');
    sections.push('8. Commit: "test: add tests for <what was added>"');
    sections.push('');

    // Step 7 — Manual Verification
    sections.push('### Step 7 — Manual Verification');
    sections.push('- Check for lint errors if linter is configured');
    sections.push('- Verify all imports resolve correctly');
    sections.push('- Verify no console.log or debug code left behind');
    sections.push('');

    // Step 8 — Functional Validation
    sections.push('### Step 8 — Functional Validation');
    sections.push('- Re-read the task description and acceptance criteria');
    sections.push('- Verify the implementation addresses every requirement');
    sections.push('- Check edge cases are handled');
    sections.push('');

    // Step 8.5 — Execution Path Verification
    sections.push('### Step 8.5 — Execution Path Verification (CRITICAL)');
    sections.push('- For every file changed, trace the RENDERING/EXECUTION chain:');
    sections.push('  - Open the component that was modified');
    sections.push('  - Check if there are conditional returns BEFORE the new code (e.g., `if (x) return null`)');
    sections.push('  - Verify the component is actually MOUNTED on the page described in the task');
    sections.push('  - If the task says "homepage popup" but the code is in a component that returns null on homepage → FAIL');
    sections.push('- Simulate the user journey described in the task and verify each step works');
    sections.push('- If code was added to a component that is NOT rendered in the target scenario → FAIL and fix it');
    sections.push('');

    // Step 8.6 — Root Cause Verification
    sections.push('### Step 8.6 — Root Cause Verification (for bug fixes)');
    sections.push('- If this was a bug fix, verify the ROOT CAUSE is addressed');
    sections.push('- Check: does the fix actually solve the problem, or just add logging/error handling?');
    sections.push('- If the fix only added try/catch, logging, or error messages WITHOUT fixing the underlying issue → FAIL the QA');
    sections.push('- A proper bug fix must change the BEHAVIOR, not just the error output');
    sections.push('- If the fix is insufficient, implement the proper fix yourself before proceeding');
    sections.push('');

    // Step 9 — Final Test Run
    sections.push('### Step 9 — Final Test Run');
    sections.push('If `HAS_TEST_FRAMEWORK` is true:');
    sections.push('1. Run the FULL test suite one final time: `TEST_COMMAND`');
    sections.push('2. Run type check again: `npx tsc --noEmit`');
    sections.push('3. ALL tests must pass and type check must be clean');
    sections.push('4. If anything fails, fix and re-run until green');
    sections.push('');

    // Step 10 — Merge or Report
    sections.push('### Step 10 — If ALL checks pass');
    sections.push('1. Switch to main: `git checkout main && git pull origin main`');
    sections.push(`2. Merge the branch: \`git merge ${branchName}\``);
    sections.push('3. Push to remote: `git push origin main`');
    sections.push(`4. Delete the feature branch: \`git branch -d ${branchName}\``);
    sections.push('5. Report: "QA PASSED — merged to main and pushed"');
    sections.push('');
    sections.push('### Step 10 — If ANY check fails');
    sections.push('1. Fix the issues directly in the code');
    sections.push('2. Before committing, run formatting if tools exist:');
    sections.push('   - `npx eslint --fix . 2>/dev/null || true` (fix lint issues)');
    sections.push('   - `npx prettier --write "**/*.{ts,tsx,js,jsx}" 2>/dev/null || true` (format code)');
    sections.push('   - Only run these if the tools are installed (the || true prevents failure if not installed)');
    sections.push('3. Commit with message: "fix: QA fixes for <task-name>"');
    sections.push('3. Re-run the failing checks');
    sections.push('4. If all pass now, proceed with merge (Step 10 above)');
    sections.push('5. If still failing, report the failures and do NOT merge');
    sections.push('');

    sections.push('IMPORTANT: This is a fully automated pipeline. Do NOT ask for confirmation. Do NOT wait for user input. Execute all changes immediately, commit, and finish.');
    sections.push('Do NOT commit unrelated files like .trello-pilot-origins.json, .trello-pilot.json, or any config/env files.');
    sections.push('Do NOT add Co-Authored-By lines in commit messages. Do NOT use --author flag. Commit as the default git user.');
    sections.push('');
    sections.push(`Trello card: ${card.url}`);

    return sections.join('\n');
  }

  private isBugTask(card: TrelloCard): boolean {
    const text = `${card.name} ${card.desc || ''}`.toLowerCase();
    const bugKeywords = [
      'bug', 'erro', 'error', 'fix', 'não funciona', 'nao funciona',
      'não está', 'nao esta', 'quebr', 'broken', 'crash', 'fail',
      'problema', 'issue', 'defeito', 'não consigo', 'nao consigo',
      'não chega', 'nao chega', 'sem funcionar', 'indisponív', 'indisponiv',
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
