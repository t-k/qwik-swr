/**
 * Qwik optimizer compatibility tests for build output.
 *
 * Background: In 0.3.0, nested function declarations inside useSWRInfinite
 * were captured by $() closures. The Qwik optimizer cannot serialize non-QRL
 * functions across QRL boundaries, causing "Cannot read properties of null
 * (reading '0')" during production builds. Dev mode is unaffected because
 * QRL extraction only runs in production.
 *
 * These tests verify the build output doesn't contain patterns that would
 * crash the optimizer in consumer projects.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { resolve, join } from "node:path";

const LIB_DIR = resolve(__dirname, "../../lib");

/**
 * Detect function declarations nested directly inside hook function bodies.
 *
 * In the Vite-built output (non-minified, 2-space indent):
 * - Module-level functions: indent 0
 * - Hook body code: indent 2
 * - Code inside $() callbacks: indent 4+
 *
 * A function declaration at indent 2 inside a hook body means it's a
 * nested function that could be captured by a $() closure — the exact
 * pattern that crashes the Qwik optimizer.
 *
 * Legitimate patterns:
 * - Module-level function declarations (indent 0) — always OK
 * - Functions inside $() / useVisibleTask$() callbacks (indent 4+) — OK,
 *   they live within the same QRL boundary
 */
function findNestedFunctionsInHooks(code: string): Array<{
  hookName: string;
  nestedFn: string;
  line: number;
}> {
  const lines = code.split("\n");
  const violations: Array<{ hookName: string; nestedFn: string; line: number }> = [];

  // Track which hook we're inside (indent-0 function whose name starts with "use")
  let currentHook: string | null = null;
  let hookBraceDepth = 0;

  // Track $() callback depth to exclude legitimate nested functions
  let dollarCallbackDepth = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Detect hook function start (module-level function starting with "use")
    const hookMatch = line.match(/^function (use\w+)\s*\(/);
    if (hookMatch) {
      currentHook = hookMatch[1];
      hookBraceDepth = 0;
    }

    if (currentHook === null) continue;

    // Track brace depth
    for (const ch of line) {
      if (ch === "{") {
        hookBraceDepth++;
      } else if (ch === "}") {
        hookBraceDepth--;
        if (hookBraceDepth === 0) {
          currentHook = null;
          dollarCallbackDepth = 0;
          break;
        }
      }
    }

    if (currentHook === null) continue;

    // Track $() callback boundaries (useVisibleTask$, useTask$, $(...))
    // These start a new QRL boundary where nested functions are OK
    if (/\$\(/.test(line)) {
      dollarCallbackDepth++;
    }

    // Detect function declarations at hook body level (indent 2, not inside $())
    // Only flag if we're NOT inside a $() callback
    if (dollarCallbackDepth === 0) {
      const fnMatch = line.match(/^  (async )?function (\w+)\s*\(/);
      if (fnMatch) {
        violations.push({
          hookName: currentHook,
          nestedFn: fnMatch[2],
          line: i + 1,
        });
      }
    }

    // Track $() callback close (simplified: count closing parens after $()
    // This is approximate but catches the main patterns)
    if (dollarCallbackDepth > 0 && /^\s{2}\}\)/.test(line)) {
      dollarCallbackDepth--;
    }
  }

  return violations;
}

describe("Qwik optimizer compatibility", () => {
  let entryFiles: string[];

  beforeAll(() => {
    entryFiles = readdirSync(LIB_DIR)
      .filter((f) => f.endsWith(".qwik.mjs"));
    expect(entryFiles.length).toBeGreaterThanOrEqual(1);
  });

  it("no function declarations nested directly inside hook bodies", () => {
    const allViolations: Array<{ file: string; hookName: string; nestedFn: string; line: number }> = [];

    for (const file of entryFiles) {
      const code = readFileSync(join(LIB_DIR, file), "utf-8");
      const violations = findNestedFunctionsInHooks(code);
      for (const v of violations) {
        allViolations.push({ file, ...v });
      }
    }

    if (allViolations.length > 0) {
      const summary = allViolations
        .map((v) => `  ${v.file}:${v.line} — function ${v.nestedFn}() inside ${v.hookName}()`)
        .join("\n");
      expect.fail(
        `Found function declarations nested inside hook bodies:\n${summary}\n\n` +
          "These will crash the Qwik optimizer when captured by $() closures.\n" +
          "Fix: extract to module-level functions with a context parameter.\n" +
          "See: src/hooks/create-mutations.ts (performMutate pattern)",
      );
    }
  });
});
