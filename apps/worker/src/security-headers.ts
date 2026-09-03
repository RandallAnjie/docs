export function documentContentSecurityPolicy(
  options: {
    embeddable?: boolean;
    analytics?: boolean;
  } = {},
): string {
  const scriptSources = ["'self'", "'unsafe-inline'"];
  const connectSources = ["'self'", 'ws:', 'wss:'];
  if (options.analytics) {
    scriptSources.push('https://www.googletagmanager.com');
    connectSources.push('https://www.google-analytics.com', 'https://region1.google-analytics.com');
  }
  return [
    "default-src 'self'",
    `script-src ${scriptSources.join(' ')}`,
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' data: https://fonts.gstatic.com",
    "img-src 'self' data: blob: https:",
    "media-src 'self' data: blob: https:",
    `connect-src ${connectSources.join(' ')}`,
    "frame-src 'self' https://www.youtube-nocookie.com https://www.figma.com https://www.loom.com https://codepen.io https://codesandbox.io",
    "object-src 'none'",
    "base-uri 'self'",
    `frame-ancestors ${options.embeddable ? '*' : "'none'"}`,
  ].join('; ');
}
