// How contributions combine into the one pending prompt. Pure; no DOM, no storage.

export const SEPARATOR = "\n\n";

/**
 * One contribution from the composer: line endings normalized, leading blank lines and trailing
 * whitespace dropped, everything inside (newlines, indentation, code blocks) untouched.
 * Returns "" for empty or whitespace-only input, which callers ignore.
 */
export function normalizeContribution(text) {
  const unified = String(text ?? "").replace(/\r\n?/g, "\n");
  if (unified.trim() === "") return "";
  return unified.replace(/^(?:[ \t]*\n)+/, "").replace(/\s+$/, "");
}

/** Joins contributions with exactly one blank line between them, skipping empty ones. */
export function joinContributions(...parts) {
  return parts.filter((part) => part !== "" && part != null).join(SEPARATOR);
}
