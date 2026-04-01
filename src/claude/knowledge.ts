import * as fs from 'fs';
import * as path from 'path';
import { spawn } from 'child_process';

const KNOWLEDGE_FILE = '.trello-pilot-knowledge.json';

export interface ProjectKnowledge {
  projectName: string;
  architecture: string;
  techStack: string[];
  fileMap: Record<string, string>;
  patterns: Record<string, string>;
  entities: string[];
  keyFiles: string[];
  lastUpdated: string;
}

export class KnowledgeManager {
  private getKnowledgePath(workspaceRoot: string): string {
    return path.join(workspaceRoot, KNOWLEDGE_FILE);
  }

  /** Load existing knowledge for a project */
  load(workspaceRoot: string): ProjectKnowledge | null {
    const filePath = this.getKnowledgePath(workspaceRoot);
    if (!fs.existsSync(filePath)) return null;

    try {
      const raw = fs.readFileSync(filePath, 'utf-8');
      const knowledge = JSON.parse(raw) as ProjectKnowledge;

      // Check if knowledge is stale (older than 7 days)
      const age = Date.now() - new Date(knowledge.lastUpdated).getTime();
      const sevenDays = 7 * 24 * 60 * 60 * 1000;
      if (age > sevenDays) return null; // Force regeneration

      return knowledge;
    } catch {
      return null;
    }
  }

  /** Save knowledge to file */
  save(workspaceRoot: string, knowledge: ProjectKnowledge): void {
    const filePath = this.getKnowledgePath(workspaceRoot);
    fs.writeFileSync(filePath, JSON.stringify(knowledge, null, 2) + '\n', 'utf-8');
  }

  /** Generate knowledge by scanning the project */
  async generate(workspaceRoot: string, claudePath: string): Promise<ProjectKnowledge | null> {
    const prompt = `Analyze this project's codebase structure and output ONLY valid JSON (no markdown, no explanation):
{
  "projectName": "name of the project",
  "architecture": "brief architecture description (1-2 sentences)",
  "techStack": ["list", "of", "technologies"],
  "fileMap": {
    "path/to/important/dir/": "what this directory contains",
    "path/to/key/file.ts": "what this file does"
  },
  "patterns": {
    "patternName": "path pattern where this type of code lives"
  },
  "entities": ["list of main domain entities/models"],
  "keyFiles": ["paths to the most important files a developer should know about"]
}

RULES:
- fileMap: include only the top 15-20 most important directories and files
- patterns: common code locations (controllers, services, components, utils, etc.)
- entities: main business objects (from database schemas, types, interfaces)
- keyFiles: files that any developer needs to understand (main configs, entry points, shared utils)
- Be concise. This is a reference for AI agents implementing tasks.`;

    try {
      const result = await this.execShell(workspaceRoot,
        `${claudePath} -p '${prompt.replace(/'/g, "'\\''")}' --permission-mode bypassPermissions --max-budget-usd 0.15 2>/dev/null`
      );

      // Extract JSON from response
      const jsonMatch = result.match(/\{[\s\S]*\}/);
      if (!jsonMatch) return null;

      const knowledge = JSON.parse(jsonMatch[0]) as ProjectKnowledge;
      knowledge.lastUpdated = new Date().toISOString();

      this.save(workspaceRoot, knowledge);
      return knowledge;
    } catch {
      return null;
    }
  }

  /** Format knowledge as prompt context */
  formatForPrompt(knowledge: ProjectKnowledge): string {
    const sections: string[] = [];

    sections.push('## Project Knowledge (cached — skip exploratory scanning)');
    sections.push('');
    sections.push(`**Architecture:** ${knowledge.architecture}`);
    sections.push(`**Tech Stack:** ${knowledge.techStack.join(', ')}`);
    sections.push('');

    sections.push('### Key Files');
    for (const file of knowledge.keyFiles) {
      sections.push(`- \`${file}\``);
    }
    sections.push('');

    sections.push('### File Map');
    for (const [filePath, desc] of Object.entries(knowledge.fileMap)) {
      sections.push(`- \`${filePath}\` — ${desc}`);
    }
    sections.push('');

    sections.push('### Code Patterns');
    for (const [pattern, location] of Object.entries(knowledge.patterns)) {
      sections.push(`- **${pattern}:** \`${location}\``);
    }
    sections.push('');

    sections.push('### Entities');
    sections.push(knowledge.entities.join(', '));
    sections.push('');

    sections.push('> Use this knowledge to navigate the codebase directly. Only read files you need to modify — do NOT do a full project scan.');
    sections.push('');

    return sections.join('\n');
  }

  private execShell(cwd: string, command: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const proc = spawn('sh', ['-c', command], { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '';
      proc.stdout.on('data', (data: Buffer) => { stdout += data.toString(); });
      proc.on('close', (code) => {
        if (code === 0) resolve(stdout.trim());
        else reject(new Error(`Knowledge generation failed (exit ${code})`));
      });
    });
  }
}
