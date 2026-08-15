declare module '/_edge/email.js' {
  export function handleEmailRequest(
    request: Request,
    env: unknown,
    handler: (message: import('./email').EdgeEmailMessage, env: unknown) => Promise<void> | void,
  ): Promise<Response | null>;
}
