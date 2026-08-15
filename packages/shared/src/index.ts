export const PRODUCT_NAME = 'Rdocs';
export const EDITOR_SCHEMA_VERSION = 4;

export type SpaceRole = 'space_admin' | 'editor' | 'commenter' | 'viewer';
export type ResourceGrantRole = 'none' | SpaceRole;
export type SpaceGrantRole = ResourceGrantRole;
export type PageGrantRole = ResourceGrantRole;
export type OrganizationRole = 'owner' | 'admin' | 'member' | 'guest';
export type OrganizationAssignableRole = 'admin' | 'member';
export type MembershipStatus = 'invited' | 'active' | 'suspended';
export type SpaceVisibility = 'organization' | 'restricted';
export type PageAccessMode = 'inherit' | 'restricted';

export interface OrganizationSummary {
  id: string;
  name: string;
  slug: string;
  role: OrganizationRole;
  createdAt: number;
  updatedAt: number;
}

export interface OrganizationMemberSummary {
  userId: string;
  email: string;
  displayName: string;
  avatarUrl: string | null;
  role: OrganizationRole;
  status: MembershipStatus;
  joinedAt: number | null;
  updatedAt: number;
}

export interface InvitationSummary {
  id: string;
  organizationId: string;
  email: string;
  organizationRole: Exclude<OrganizationRole, 'owner'>;
  expiresAt: number;
  acceptedAt: number | null;
  revokedAt: number | null;
  createdAt: number;
}

export interface GroupSummary {
  id: string;
  organizationId: string;
  name: string;
  description: string | null;
  memberCount: number;
  createdAt: number;
}

export interface SpaceSummary {
  id: string;
  organizationId: string;
  name: string;
  slug: string;
  icon: string | null;
  visibility: SpaceVisibility;
  role: SpaceRole;
  createdAt: number;
  updatedAt: number;
  archivedAt: number | null;
}

export type SpaceGrantPrincipalType = 'user' | 'group' | 'organization';

export interface SpaceGrantSummary {
  id: string;
  organizationId: string;
  spaceId: string;
  principalType: SpaceGrantPrincipalType;
  principalId: string;
  role: SpaceGrantRole;
  createdAt: number;
}

export interface PageGrantSummary {
  id: string;
  organizationId: string;
  pageId: string;
  principalType: SpaceGrantPrincipalType;
  principalId: string;
  role: PageGrantRole;
  createdAt: number;
}

export interface PageSummary {
  id: string;
  organizationId: string;
  spaceId: string;
  parentId: string | null;
  title: string;
  icon: string | null;
  coverAttachmentId: string | null;
  fontStyle: 'sans' | 'serif' | 'mono';
  isFullWidth: boolean;
  isSmallText: boolean;
  isLocked: boolean;
  currentGeneration: number;
  editorSchemaVersion: number;
  updatedAt: number;
  collaborationEnabled: boolean;
  aclVersion: number;
  role?: SpaceRole;
}

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export type DatabasePropertyType =
  | 'title'
  | 'text'
  | 'number'
  | 'select'
  | 'status'
  | 'multi_select'
  | 'date'
  | 'formula'
  | 'relation'
  | 'rollup'
  | 'person'
  | 'files'
  | 'checkbox'
  | 'url'
  | 'email'
  | 'phone'
  | 'created_time'
  | 'created_by'
  | 'last_edited_time'
  | 'last_edited_by'
  | 'button'
  | 'unique_id'
  | 'place';

export type DatabaseViewType =
  | 'table'
  | 'board'
  | 'timeline'
  | 'calendar'
  | 'list'
  | 'gallery'
  | 'chart'
  | 'dashboard'
  | 'form'
  | 'feed'
  | 'map';

export interface DatabasePropertySummary {
  id: string;
  databaseId: string;
  name: string;
  type: DatabasePropertyType;
  config: Record<string, JsonValue>;
  sortOrder: number;
  createdAt: number;
  updatedAt: number;
}

export interface DatabaseViewSummary {
  id: string;
  databaseId: string;
  name: string;
  type: DatabaseViewType;
  config: Record<string, JsonValue>;
  sortOrder: number;
  createdAt: number;
  updatedAt: number;
}

export interface DatabaseRowSummary {
  id: string;
  databaseId: string;
  pageId: string;
  sortKey: string;
  sequenceNumber: number;
  values: Record<string, JsonValue>;
  createdBy: string;
  updatedBy: string;
  createdAt: number;
  updatedAt: number;
  archivedAt: number | null;
}

export interface DatabaseTemplateSummary {
  id: string;
  databaseId: string;
  pageId: string;
  name: string;
  description: string;
  values: Record<string, JsonValue>;
  isDefault: boolean;
  createdBy: string;
  updatedBy: string;
  createdAt: number;
  updatedAt: number;
}

export interface ProjectWorkspaceSummary {
  hubPageId: string;
  projectsPageId: string;
  tasksPageId: string;
  sprintsPageId: string;
  projectsDatabaseId: string;
  tasksDatabaseId: string;
  sprintsDatabaseId: string;
}

export type DatabaseAutomationTrigger =
  'row_created' | 'row_updated' | 'property_changed' | 'form_submitted' | 'manual';

export type DatabaseAutomationAction =
  'set_property' | 'toggle_checkbox' | 'increment_number' | 'archive_row' | 'webhook';

export interface DatabaseAutomationSummary {
  id: string;
  databaseId: string;
  name: string;
  enabled: boolean;
  triggerType: DatabaseAutomationTrigger;
  triggerConfig: Record<string, JsonValue>;
  actionType: DatabaseAutomationAction;
  actionConfig: Record<string, JsonValue>;
  createdBy: string;
  updatedBy: string;
  createdAt: number;
  updatedAt: number;
}

export interface DatabaseAutomationRunSummary {
  id: string;
  databaseId: string;
  automationId: string;
  rowId: string | null;
  triggerType: DatabaseAutomationTrigger;
  status: 'running' | 'succeeded' | 'failed' | 'skipped';
  attempt: number;
  responseCode: number | null;
  errorMessage: string | null;
  startedAt: number;
  completedAt: number | null;
}

export interface DatabaseSummary {
  id: string;
  organizationId: string;
  pageId: string;
  title: string;
  isLocked: boolean;
  role: SpaceRole;
  createdBy: string;
  updatedBy: string;
  createdAt: number;
  updatedAt: number;
}

export interface DatabaseSnapshot {
  database: DatabaseSummary;
  properties: DatabasePropertySummary[];
  views: DatabaseViewSummary[];
  rows: DatabaseRowSummary[];
  templates: DatabaseTemplateSummary[];
}

export interface DatabaseFormLinkSummary {
  id: string;
  databaseId: string;
  viewId: string;
  status: 'active' | 'revoked';
  expiresAt: number | null;
  createdAt: number;
  revokedAt: number | null;
}

export interface PublicDatabaseFormField {
  id: string;
  name: string;
  type: DatabasePropertyType;
  config: Record<string, JsonValue>;
  required: boolean;
}

export interface PublicDatabaseFormDefinition {
  id: string;
  title: string;
  description: string;
  submitLabel: string;
  successMessage: string;
  fields: PublicDatabaseFormField[];
  expiresAt: number | null;
}

export interface CreateDatabaseResponse extends DatabaseSnapshot {
  page: PageSummary;
}

export interface TrashedPageSummary extends PageSummary {
  deletedAt: number;
}

export interface PageSearchResult {
  page: PageSummary;
  snippet: string;
}

export interface RecentPageResult {
  page: PageSummary;
  visitedAt: number;
}

export interface FavoritePageResult {
  page: PageSummary;
  favoritedAt: number;
}

export interface AttachmentSummary {
  id: string;
  pageId: string;
  originalName: string;
  mimeType: string;
  byteSize: number;
  sha256: string;
  status: 'pending' | 'ready' | 'quarantined' | 'deleted';
  createdBy: string;
  createdAt: number;
}

export interface CommentSummary {
  id: string;
  threadId: string;
  author: AuthUserSummary;
  body: string;
  createdAt: number;
  updatedAt: number;
}

export interface CommentThreadSummary {
  id: string;
  pageId: string;
  generation: number;
  anchorStart: string | null;
  anchorEnd: string | null;
  quotedText: string | null;
  status: 'open' | 'resolved';
  createdBy: string;
  createdAt: number;
  resolvedBy: string | null;
  resolvedAt: number | null;
  comments: CommentSummary[];
}

export type NotificationType =
  'mention' | 'comment_reply' | 'page_shared' | 'permission_changed' | 'invitation_accepted';

export interface NotificationSummary {
  id: string;
  organizationId: string;
  actor: AuthUserSummary | null;
  type: NotificationType;
  pageId: string | null;
  pageTitle: string | null;
  threadId: string | null;
  commentId: string | null;
  metadata: Record<string, unknown>;
  createdAt: number;
  readAt: number | null;
}

export interface ShareLinkSummary {
  id: string;
  pageId: string;
  role: 'viewer' | 'commenter';
  expiresAt: number | null;
  revokedAt: number | null;
  createdBy: string;
  createdAt: number;
}

export interface AuditEventSummary {
  id: string;
  actor: AuthUserSummary | null;
  eventType: string;
  targetType: string;
  targetId: string;
  metadata: Record<string, unknown>;
  createdAt: number;
}

export interface CollabTicketResponse {
  ticket: string;
  expiresAt: number;
  generation: number;
}

export interface CreatePageResponse {
  page: PageSummary;
}

export interface ListPagesResponse {
  pages: PageSummary[];
}

export type RevisionKind = 'automatic' | 'manual' | 'restore' | 'pre_delete' | 'pre_export';

export interface RevisionSummary {
  id: string;
  pageId: string;
  generation: number;
  collabSeq: number;
  kind: RevisionKind;
  label: string | null;
  description: string | null;
  contentHash: string;
  createdBy: string | null;
  createdAt: number;
}

export interface ListRevisionsResponse {
  revisions: RevisionSummary[];
}

export interface CreateRevisionResponse {
  revision: RevisionSummary;
}

export interface RestoreRevisionResponse {
  page: PageSummary;
  restoredRevisionId: string;
  previousRevision: RevisionSummary;
  idempotencyKey: string;
}

export type AuthMode = 'passkey';

export interface AuthUserSummary {
  id: string;
  email: string;
  displayName: string;
  avatarUrl: string | null;
}

export interface AuthSessionResponse {
  mode: AuthMode;
  authenticated: boolean;
  user: AuthUserSummary | null;
  passkeyConfigured: boolean;
  enrollmentConfigured: boolean;
  expectedOrigin: string | null;
}

export function isPageId(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

export * from './http-sync';
export * from './limits';
