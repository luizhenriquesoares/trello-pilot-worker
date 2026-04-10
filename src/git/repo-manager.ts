import { spawn } from 'child_process';
import { rm } from 'fs/promises';

const GH_TOKEN_ENV = 'GH_TOKEN';

interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface PrInfo {
  url: string;
  number: number;
}

export class RepoManager {
  private execGit(cwd: string, args: string[]): Promise<string> {
    return new Promise((resolve, reject) => {
      const proc = spawn('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '';
      let stderr = '';

      proc.stdout.on('data', (data: Buffer) => { stdout += data.toString(); });
      proc.stderr.on('data', (data: Buffer) => { stderr += data.toString(); });

      proc.on('error', (err) => {
        reject(new Error(`git ${args.join(' ')} spawn error: ${err.message}`));
      });

      proc.on('close', (code) => {
        if (code === 0) {
          resolve(stdout.trim());
        } else {
          reject(new Error(`git ${args.join(' ')} failed (exit ${code}): ${stderr.trim()}`));
        }
      });
    });
  }

  private execShell(cwd: string, command: string): Promise<ExecResult> {
    return new Promise((resolve, reject) => {
      const proc = spawn('sh', ['-c', command], { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '';
      let stderr = '';

      proc.stdout.on('data', (data: Buffer) => { stdout += data.toString(); });
      proc.stderr.on('data', (data: Buffer) => { stderr += data.toString(); });

      proc.on('close', (exitCode) => {
        resolve({ stdout: stdout.trim(), stderr: stderr.trim(), exitCode: exitCode ?? 1 });
      });

      proc.on('error', (err) => {
        reject(new Error(`Shell command failed: ${err.message}`));
      });
    });
  }

  private buildAuthUrl(repoUrl: string): string {
    const token = process.env[GH_TOKEN_ENV];
    if (!token) {
      throw new Error(`${GH_TOKEN_ENV} environment variable is not set`);
    }

    // Convert https://github.com/org/repo to https://x-access-token:TOKEN@github.com/org/repo
    const parsed = new URL(repoUrl);
    parsed.username = 'x-access-token';
    parsed.password = token;
    return parsed.toString();
  }

  async clone(repoUrl: string, targetDir: string, baseBranch: string): Promise<void> {
    const authUrl = this.buildAuthUrl(repoUrl);
    await this.execGit('/tmp', [
      'clone',
      '--depth', '1',
      '--single-branch',
      '--no-tags',
      '-c', 'pack.threads=1',
      '--branch', baseBranch,
      authUrl,
      targetDir,
    ]);
    // Unshallow enough for diff/log against main
    await this.execGit(targetDir, ['fetch', '--depth', '50', 'origin', baseBranch]).catch(() => {});
  }

  async createBranch(cwd: string, branchName: string): Promise<void> {
    // Delete remote branch if it exists (leftover from previous attempt)
    try {
      await this.execGit(cwd, ['push', 'origin', '--delete', branchName]);
      console.log(`[Git] Deleted stale remote branch: ${branchName}`);
    } catch {
      // Branch doesn't exist remotely — that's fine
    }
    // Delete local branch if it exists
    try {
      await this.execGit(cwd, ['branch', '-D', branchName]);
    } catch {
      // Branch doesn't exist locally
    }
    await this.execGit(cwd, ['checkout', '-b', branchName]);
  }

  async checkoutBranch(cwd: string, branchName: string): Promise<void> {
    try {
      await this.execGit(cwd, ['checkout', branchName]);
    } catch {
      // Branch might only exist on remote — fetch and retry
      await this.execGit(cwd, ['fetch', 'origin', branchName]);
      await this.execGit(cwd, ['checkout', branchName]);
    }
  }

  async push(cwd: string, branchName: string): Promise<void> {
    try {
      await this.execGit(cwd, ['push', '-u', 'origin', branchName]);
    } catch (err) {
      const msg = (err as Error).message || '';
      // Only force push on divergence/rejection, not on other errors
      if (msg.includes('rejected') || msg.includes('non-fast-forward') || msg.includes('does not match any')) {
        console.log(`[Git] Push rejected (${msg.substring(0, 100)}), force pushing: ${branchName}`);
        await this.execGit(cwd, ['push', '-u', '--force', 'origin', branchName]);
      } else {
        throw err;
      }
    }
  }

  async createPr(
    cwd: string,
    title: string,
    body: string,
    baseBranch: string,
  ): Promise<PrInfo> {
    const escapedTitle = title.replace(/"/g, '\\"');
    const escapedBody = body.replace(/"/g, '\\"');

    const result = await this.execShell(cwd, [
      'gh pr create',
      `--title "${escapedTitle}"`,
      `--body "${escapedBody}"`,
      `--base ${baseBranch}`,
    ].join(' '));

    if (result.exitCode !== 0) {
      throw new Error(`gh pr create failed: ${result.stderr || result.stdout}`);
    }

    const url = result.stdout.trim();
    const numberMatch = url.match(/\/pull\/(\d+)/);
    const prNumber = numberMatch ? parseInt(numberMatch[1], 10) : 0;

    return { url, number: prNumber };
  }

  async mergePr(cwd: string, branchName: string): Promise<void> {
    const result = await this.execShell(cwd,
      `gh pr merge ${branchName} --squash --delete-branch`,
    );

    if (result.exitCode !== 0) {
      throw new Error(`gh pr merge failed: ${result.stderr || result.stdout}`);
    }
  }

  async getPrUrl(cwd: string, branchName: string): Promise<string | null> {
    const result = await this.execShell(cwd,
      `gh pr view ${branchName} --json url -q .url 2>/dev/null`,
    );

    if (result.exitCode !== 0 || !result.stdout) {
      return null;
    }

    return result.stdout.trim();
  }

  async getCommitLog(cwd: string): Promise<string> {
    return this.execGit(cwd, ['log', '--oneline', 'main..HEAD']);
  }

  async cleanup(dir: string): Promise<void> {
    await rm(dir, { recursive: true, force: true });
  }
}
