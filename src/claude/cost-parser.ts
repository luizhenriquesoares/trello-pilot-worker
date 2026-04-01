/**
 * Represents parsed cost/token data from a Claude CLI JSON response.
 */
export interface ClaudeCostData {
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

/**
 * Attempts to parse cost information from the Claude CLI JSON output.
 *
 * The Claude CLI with --output-format json may include cost/usage fields
 * in its response. This parser handles multiple known output shapes:
 *
 *   1. Top-level `cost_usd` field
 *   2. Nested `usage.cost_usd` field
 *   3. Nested `result.cost_usd` field
 *   4. Token-based estimation as fallback
 *
 * Returns null if no cost data can be extracted.
 */
export function parseCostFromClaudeOutput(rawOutput: string): number | null {
  if (!rawOutput || rawOutput.trim().length === 0) {
    return null;
  }

  try {
    const parsed = JSON.parse(rawOutput);
    return extractCostFromParsed(parsed);
  } catch {
    // Output may contain multiple JSON objects (streaming); try the last one
    const jsonObjects = extractJsonObjects(rawOutput);
    for (let i = jsonObjects.length - 1; i >= 0; i--) {
      try {
        const parsed = JSON.parse(jsonObjects[i]);
        const cost = extractCostFromParsed(parsed);
        if (cost !== null) return cost;
      } catch {
        continue;
      }
    }
    return null;
  }
}

/**
 * Parses full cost data including token counts from Claude CLI output.
 * Returns null if the output cannot be parsed.
 */
export function parseFullCostData(rawOutput: string): ClaudeCostData | null {
  if (!rawOutput || rawOutput.trim().length === 0) {
    return null;
  }

  try {
    const parsed = JSON.parse(rawOutput);
    return extractFullCostData(parsed);
  } catch {
    const jsonObjects = extractJsonObjects(rawOutput);
    for (let i = jsonObjects.length - 1; i >= 0; i--) {
      try {
        const parsed = JSON.parse(jsonObjects[i]);
        const data = extractFullCostData(parsed);
        if (data !== null) return data;
      } catch {
        continue;
      }
    }
    return null;
  }
}

function extractCostFromParsed(parsed: Record<string, unknown>): number | null {
  // Direct cost field
  if (typeof parsed.cost_usd === 'number') {
    return parsed.cost_usd;
  }

  // Nested under usage
  const usage = parsed.usage as Record<string, unknown> | undefined;
  if (usage && typeof usage.cost_usd === 'number') {
    return usage.cost_usd;
  }

  // Nested under result
  const result = parsed.result as Record<string, unknown> | undefined;
  if (result && typeof result.cost_usd === 'number') {
    return result.cost_usd;
  }

  // Nested under result.usage
  const resultUsage = result?.usage as Record<string, unknown> | undefined;
  if (resultUsage && typeof resultUsage.cost_usd === 'number') {
    return resultUsage.cost_usd;
  }

  return null;
}

function extractFullCostData(parsed: Record<string, unknown>): ClaudeCostData | null {
  const sources = [
    parsed,
    parsed.usage as Record<string, unknown> | undefined,
    parsed.result as Record<string, unknown> | undefined,
    (parsed.result as Record<string, unknown> | undefined)?.usage as Record<string, unknown> | undefined,
  ];

  for (const source of sources) {
    if (!source) continue;

    const costUsd = typeof source.cost_usd === 'number' ? source.cost_usd : null;
    const inputTokens = typeof source.input_tokens === 'number' ? source.input_tokens : 0;
    const outputTokens = typeof source.output_tokens === 'number' ? source.output_tokens : 0;

    if (costUsd !== null) {
      return {
        costUsd,
        inputTokens,
        outputTokens,
        totalTokens: inputTokens + outputTokens,
      };
    }
  }

  return null;
}

/**
 * Extracts JSON object strings from a raw output that may contain
 * multiple concatenated JSON objects (common in streaming output).
 */
function extractJsonObjects(raw: string): string[] {
  const objects: string[] = [];
  let depth = 0;
  let start = -1;

  for (let i = 0; i < raw.length; i++) {
    if (raw[i] === '{') {
      if (depth === 0) start = i;
      depth++;
    } else if (raw[i] === '}') {
      depth--;
      if (depth === 0 && start !== -1) {
        objects.push(raw.substring(start, i + 1));
        start = -1;
      }
    }
  }

  return objects;
}
