export interface Env {
  DB: D1Database;
  ATTACHMENTS: R2Bucket;
  DocumentRoom: DurableObjectNamespace;
  COLLAB_TICKET_SECRET: string;
  PHASE0_ADMIN_SECRET: string;
  PASSKEY_ENROLLMENT_SECRET?: string;
  APP_ORIGIN?: string;
  AUTH_MODE?: string;
  PASSKEY_ORIGIN?: string;
  PASSKEY_RP_ID?: string;
  ENVIRONMENT?: string;
  RELEASE_SHA?: string;
}
