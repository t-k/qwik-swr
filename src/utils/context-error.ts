/**
 * Detect Qwik's "context not found" error (error code 13).
 *
 * In dev builds: "Code(13): Actual value for useContext(...) can not be found..."
 * In prod builds: "Q-13" (minified)
 *
 * Returns true only for code 13; other Qwik errors are not caught.
 */
export function isContextNotFoundError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const msg = error.message;
  // Dev: "Code(13): ..."
  // Prod: "Q-13"
  return /\bCode\(13\)/.test(msg) || /\bQ-13\b/.test(msg);
}
