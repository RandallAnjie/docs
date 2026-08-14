function configuredOrigins(value: string | undefined): string[] {
  return (value ?? '')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean)
    .flatMap((origin) => {
      try {
        return [new URL(origin).origin];
      } catch {
        return [];
      }
    });
}

export function isCollaborationOriginAllowed(
  requestUrl: string,
  originHeader: string | null,
  configuredOrigin: string | undefined,
): boolean {
  if (!originHeader) return false;

  const allowedOrigins = new Set([
    new URL(requestUrl).origin,
    ...configuredOrigins(configuredOrigin),
  ]);
  return allowedOrigins.has(originHeader);
}
