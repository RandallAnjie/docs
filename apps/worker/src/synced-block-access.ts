import type { SpaceRole } from '@rdocs/shared';

interface SyncedBlockPageAccess {
  collaborationEnabled: boolean;
  isLocked: boolean;
  role: SpaceRole;
}

function canEdit(access: SyncedBlockPageAccess): boolean {
  return (
    access.collaborationEnabled &&
    !access.isLocked &&
    (access.role === 'space_admin' || access.role === 'editor')
  );
}

export function syncedBlockTicketRole(
  source: SyncedBlockPageAccess,
  container: SyncedBlockPageAccess,
): 'editor' | 'viewer' | null {
  if (!source.collaborationEnabled || !container.collaborationEnabled) return null;
  return canEdit(source) && canEdit(container) ? 'editor' : 'viewer';
}
