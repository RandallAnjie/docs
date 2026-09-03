import {
  BookOpen,
  Building2,
  CalendarDays,
  FileText,
  FolderKanban,
  LibraryBig,
  Users,
  type LucideIcon,
} from 'lucide-react';
import type { ReactNode } from 'react';

const NAMED_ICONS: Record<string, LucideIcon> = {
  'book-open': BookOpen,
  'building-2': Building2,
  'calendar-days': CalendarDays,
  'file-text': FileText,
  'folder-kanban': FolderKanban,
  'library-big': LibraryBig,
  users: Users,
  bookopen: BookOpen,
};

export function namedSpaceIcon(icon: string | null | undefined): LucideIcon | null {
  const value = icon?.trim().toLowerCase() ?? '';
  if (!value) return null;
  return NAMED_ICONS[value] ?? NAMED_ICONS[value.replace(/_/g, '-')] ?? null;
}

export function SpaceIcon({
  icon,
  size = 16,
  fallback = '◆',
}: {
  icon: string | null | undefined;
  size?: number;
  fallback?: string;
}): ReactNode {
  const Named = namedSpaceIcon(icon);
  if (Named) return <Named size={size} aria-hidden="true" />;
  const glyph = icon?.trim() ?? '';
  return glyph || fallback;
}
