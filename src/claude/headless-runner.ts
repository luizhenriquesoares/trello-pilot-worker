import { spawn } from 'child_process';
import { parseCostFromClaudeOutput } from './cost-parser';

const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes

export interface ClaudeRunResult {
  output: string;
  exitCode: number;
  durationMs: number;
  costUsd: number | null;
}

export interface HeadlessRunnerOptions {
  cwd: string;
  prompt: string;
  claudePath?: string;
  timeoutMs?: number;
  maxBudgetUsd?: number;
}

/**
 * Spawns the Claude CLI in headless mode and captures its output.
 *
 * Command: claude -p "prompt" --dangerously-skip-permissions --output-format json
 * Uses AbortController for timeout enforcement.
 */
export async function runClaude(options: HeadlessRunnerOptions): Promise<ClaudeRunResult> {
  const {
    cwd,
    prompt,
    claudePath = 'claude',
    timeoutMs = DEFAULT_TIMEOUT_MS,
    maxBudgetUsd,
  } = options;

  const args = [
    '-p',
    prompt,
    '--dangerously-skip-permissions',
    '--output-format',
    'json',
  ];

  if (maxBudgetUsd !== undefined) {
    args.push('--max-budget-usd', String(maxBudgetUsd));
  }

  const startTime = Date.now();
  const controller = new AbortController();
  const { signal } = controller;

  const timeoutHandle = setTimeout(() => {
    controller.abort();
  }, timeoutMs);

  return new Promise<ClaudeRunResult>((resolve, reject) => {
    const proc = spawn(claudePath, args, {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      signal,
    });

    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (data: Buffer) => {
      stdout += data.toString();
    });

    proc.stderr.on('data', (data: Buffer) => {
      stderr += data.toString();
    });

    proc.on('error', (err: NodeJS.ErrnoException) => {
      clearTimeout(timeoutHandle);
      const durationMs = Date.now() - startTime;

      if (err.name === 'AbortError' || signal.aborted) {
        resolve({
          output: stdout || `Timed out after ${timeoutMs}ms. Partial output:\n${stderr}`,
          exitCode: 124, // Standard timeout exit code
          durationMs,
          costUsd: parseCostFromClaudeOutput(stdout),
        });
        return;
      }

      reject(new Error(`Failed to spawn claude CLI: ${err.message}`));
    });

    proc.on('close', (code) => {
      clearTimeout(timeoutHandle);
      const durationMs = Date.now() - startTime;
      const exitCode = code ?? 1;

      resolve({
        output: stdout,
        exitCode,
        durationMs,
        costUsd: parseCostFromClaudeOutput(stdout),
      });
    });
  });
}
