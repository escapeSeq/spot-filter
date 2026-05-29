/**
 * Normalize LLM output into parseable JSON (markdown fences, comments, ellipsis, trailing commas).
 */

export function extractLlmJsonText(text: string): string {
  let cleaned = text.trim();
  const fenceMatch = cleaned.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenceMatch) cleaned = fenceMatch[1].trim();
  return cleaned;
}

/** Strip common LLM shortcuts that are not valid JSON. */
export function sanitizeJsonLike(text: string): string {
  let cleaned = extractLlmJsonText(text);
  // Line comments (// ...)
  cleaned = cleaned.replace(/^\s*\/\/.*$/gm, "");
  cleaned = cleaned.replace(/\/\*[\s\S]*?\*\//g, "");
  // Ellipsis-only lines: "..." or "...," (means "unchanged fields")
  cleaned = cleaned.replace(/^\s*\.\.\.(?:\s*,)?\s*$/gm, "");
  // Ellipsis between properties: , ... , or , ... } or , ... ]
  cleaned = cleaned.replace(/,\s*\.\.\.\s*(?=,|\}|\])/g, "");
  cleaned = cleaned.replace(/\[\s*\.\.\.\s*\]/g, "[]");
  cleaned = cleaned.replace(/\{\s*\.\.\.\s*\}/g, "{}");
  // Trailing commas before } or ]
  cleaned = cleaned.replace(/,\s*([}\]])/g, "$1");
  return cleaned.trim();
}

export type LlmParseOutcome =
  | { ok: true; value: unknown; normalized: string }
  | { ok: true; removed: true }
  | { ok: false; sanitized: string; error: string };

/** Pull LLM text from the final NDJSON line in a streamed /api/llm response. */
export function extractLlmContentFromNdjsonStream(streamRaw: string): string | undefined {
  const lines = streamRaw.trim().split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line) continue;
    try {
      const evt = JSON.parse(line) as Record<string, unknown>;
      if (typeof evt.raw === "string" && evt.raw.trim()) return evt.raw;
      if (typeof evt.result === "string" && evt.result.trim()) return evt.result;
    } catch {
      /* skip */
    }
  }
  return undefined;
}

function readJsonValueAt(input: string): { value: unknown; consumed: number } | null {
  const s = input.trimStart();
  const offset = input.length - s.length;
  if (!s) return null;

  if (s.startsWith('"')) {
    let i = 1;
    while (i < s.length) {
      if (s[i] === "\\") {
        i += 2;
        continue;
      }
      if (s[i] === '"') {
        try {
          const value = JSON.parse(s.slice(0, i + 1));
          return { value, consumed: offset + i + 1 };
        } catch {
          return null;
        }
      }
      i++;
    }
    return null;
  }

  if (s.startsWith("{") || s.startsWith("[")) {
    const open = s[0];
    const close = open === "{" ? "}" : "]";
    let depth = 0;
    let inString = false;
    let escape = false;
    for (let i = 0; i < s.length; i++) {
      const ch = s[i];
      if (inString) {
        if (escape) {
          escape = false;
          continue;
        }
        if (ch === "\\") {
          escape = true;
          continue;
        }
        if (ch === '"') inString = false;
        continue;
      }
      if (ch === '"') {
        inString = true;
        continue;
      }
      if (ch === open) depth++;
      else if (ch === close) {
        depth--;
        if (depth === 0) {
          try {
            const slice = s.slice(0, i + 1);
            const value = JSON.parse(slice);
            return { value, consumed: offset + i + 1 };
          } catch {
            return null;
          }
        }
      }
    }
    return null;
  }

  const prim = s.match(/^(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null)\b/);
  if (prim) {
    try {
      const value = JSON.parse(prim[0]);
      return { value, consumed: offset + prim[0].length };
    } catch {
      return null;
    }
  }

  return null;
}

/** Extract top-level key/value pairs from broken JSON (e.g. with ellipsis). */
export function extractTopLevelFields(text: string): Record<string, unknown> {
  const fields: Record<string, unknown> = {};
  const keyRe = /"([a-zA-Z0-9_]+)"\s*:\s*/g;
  let m: RegExpExecArray | null;
  while ((m = keyRe.exec(text)) !== null) {
    const key = m[1];
    const rest = text.slice(m.index + m[0].length);
    const read = readJsonValueAt(rest);
    if (read) fields[key] = read.value;
  }
  return fields;
}

/** Merge extracted fields onto the original track when LLM used "..." placeholders. */
export function mergePartialTrackJson(
  llmText: string,
  baseTrack: Record<string, unknown>
): { value: Record<string, unknown>; normalized: string } | null {
  const sanitized = sanitizeJsonLike(llmText);
  const patches = extractTopLevelFields(sanitized);
  if (Object.keys(patches).length === 0) return null;
  const merged = { ...baseTrack, ...patches };
  return { value: merged, normalized: JSON.stringify(merged, null, 2) };
}

export function parseLlmJsonOutput(
  text: string,
  allowNull = false,
  baseTrack?: Record<string, unknown>
): LlmParseOutcome {
  const sanitized = sanitizeJsonLike(text);
  if (allowNull && sanitized === "null") {
    return { ok: true, removed: true };
  }
  try {
    const value = JSON.parse(sanitized);
    return { ok: true, value, normalized: sanitized };
  } catch (firstErr) {
    if (baseTrack) {
      const merged = mergePartialTrackJson(text, baseTrack);
      if (merged) {
        return { ok: true, value: merged.value, normalized: merged.normalized };
      }
    }
    return {
      ok: false,
      sanitized,
      error: firstErr instanceof Error ? firstErr.message : String(firstErr),
    };
  }
}
