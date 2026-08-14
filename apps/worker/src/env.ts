export interface Env {
  DB: D1Database;
  ATTACHMENTS: R2Bucket;
  DocumentRoom: DurableObjectNamespace;
  COLLAB_TICKET_SECRET: string;
  PHASE0_ADMIN_SECRET: string;
  APP_ORIGIN?: string;
  ENVIRONMENT?: string;
  RELEASE_SHA?: string;
}
