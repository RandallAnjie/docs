export interface Env {
  DB: D1Database;
  ATTACHMENTS: R2Bucket;
  DOCUMENTROOM?: DurableObjectNamespace;
  DocumentRoom?: DurableObjectNamespace;
  COLLAB_TICKET_SECRET: string;
  PHASE0_ADMIN_SECRET: string;
  APP_ORIGIN?: string;
  /** `members` (default): only the app owner and its RandallFlare member list; `accounts`: any RandallFlare account. */
  RF_ACCESS_POLICY?: string;
  ENVIRONMENT?: string;
  RELEASE_SHA?: string;
  XAI_API_KEY?: string;
  AI_API_KEY?: string;
  AI_API_BASE?: string;
  MAIL_FROM?: string;
  EMAIL?: {
    send(message: {
      bcc?: string[];
      cc?: string[];
      from?: string;
      fromName?: string;
      html?: string;
      subject: string;
      text?: string;
      to: string;
    }): Promise<{ ok: boolean; queued: number }>;
  };
}
