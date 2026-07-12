export function resolveLayoutThreadId(
  pathnameThreadId: string,
  browserThreadId: string | null,
): string {
  if (browserThreadId !== null) return browserThreadId;
  return pathnameThreadId;
}
