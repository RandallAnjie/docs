export type ShareLinkRole = 'viewer' | 'commenter' | 'editor';

export function isShareLinkRole(value: unknown): value is ShareLinkRole {
  return value === 'viewer' || value === 'commenter' || value === 'editor';
}

export function publicShareTicketRole(shareRole: string, isLocked: boolean): 'editor' | 'viewer' {
  if (isLocked || shareRole !== 'editor') return 'viewer';
  return 'editor';
}

export function publicShareDisplayName(role: 'editor' | 'viewer'): string {
  return role === 'editor' ? '外部访客' : '外部只读';
}
