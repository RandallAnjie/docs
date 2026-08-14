export const PRODUCT_NAME = 'Rdocs';
export const EDITOR_SCHEMA_VERSION = 1;

export type SpaceRole = 'space_admin' | 'editor' | 'commenter' | 'viewer';

export interface PageSummary {
  id: string;
  organizationId: string;
  spaceId: string;
  parentId: string | null;
  title: string;
  currentGeneration: number;
  editorSchemaVersion: number;
  updatedAt: number;
  collaborationEnabled: boolean;
  aclVersion: number;
}

export interface CollabTicketResponse {
  ticket: string;
  expiresAt: number;
  generation: number;
}

export interface CreatePageResponse {
  page: PageSummary;
}

export function isPageId(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

export * from './http-sync';
export * from './limits';
