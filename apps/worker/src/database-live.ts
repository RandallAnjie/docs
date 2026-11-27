import { durableRooms } from './durable-rooms';
import type { Env } from './env';
import { isCollaborationOriginAllowed } from './origins';
import { signDatabaseLiveTicket, verifyDatabaseLiveTicket } from './tickets';

/**
 * Live database changes: everyone viewing a database (its full page or an
 * inline block in a document) holds a light WebSocket to one room per
 * database. Writes post a "changed" note there, and viewers refetch.
 */
const LIVE_TICKET_TTL_MS = 5 * 60 * 1_000;

function databaseLiveRoom(env: Env, databaseId: string): DurableObjectStub {
  const rooms = durableRooms(env);
  return rooms.get(rooms.idFromName(`database-live:${databaseId}`));
}

/** Tell viewers of a database that it changed. Never throws. */
export async function notifyDatabaseChanged(
  env: Env,
  databaseId: string,
  actorId: string | null,
): Promise<void> {
  try {
    await databaseLiveRoom(env, databaseId).fetch(
      'https://database-live.internal/internal/database-changed',
      {
        method: 'POST',
        body: JSON.stringify({ type: 'changed', databaseId, actorId, at: Date.now() }),
      },
    );
  } catch (reason) {
    console.error(
      JSON.stringify({
        level: 'warn',
        event: 'database_live_notify_failed',
        message: reason instanceof Error ? reason.message : String(reason),
      }),
    );
  }
}

/** Database a mutating `/api/databases/:id/...` request wrote to, if any. */
export function databaseIdFromMutationPath(pathname: string, method: string): string | null {
  if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) return null;
  const match = pathname.match(/^\/api\/databases\/([^/]+)(?:\/(.*))?$/);
  if (!match?.[1]) return null;
  if (match[2] === 'live-ticket') return null;
  return decodeURIComponent(match[1]);
}

export async function issueDatabaseLiveTicket(
  env: Env,
  databaseId: string,
  actor: { id: string; displayName?: string | null; email?: string | null },
): Promise<{ ticket: string; expiresAt: number } | null> {
  if (!env.COLLAB_TICKET_SECRET || env.COLLAB_TICKET_SECRET.length < 32) return null;
  const now = Date.now();
  const expiresAt = now + LIVE_TICKET_TTL_MS;
  const ticket = await signDatabaseLiveTicket(
    {
      version: 'database-live-1',
      databaseId,
      actorId: actor.id,
      displayName: (actor.displayName || actor.email?.split('@')[0] || '协作者').slice(0, 80),
      issuedAt: now,
      expiresAt,
    },
    env.COLLAB_TICKET_SECRET,
  );
  return { ticket, expiresAt };
}

export async function openDatabaseLiveSocket(
  request: Request,
  env: Env,
  databaseId: string,
): Promise<Response> {
  if (request.headers.get('upgrade')?.toLowerCase() !== 'websocket') {
    return new Response('WebSocket upgrade required', { status: 426 });
  }
  if (!isCollaborationOriginAllowed(request.url, request.headers.get('origin'), env.APP_ORIGIN)) {
    return new Response('Origin not allowed', { status: 403 });
  }
  const ticketValue = new URL(request.url).searchParams.get('ticket');
  if (!ticketValue || !env.COLLAB_TICKET_SECRET) {
    return new Response('Missing ticket', { status: 401 });
  }
  const ticket = await verifyDatabaseLiveTicket(ticketValue, env.COLLAB_TICKET_SECRET);
  if (!ticket || ticket.databaseId !== databaseId) {
    return new Response('Invalid ticket', { status: 401 });
  }
  const headers = new Headers();
  headers.set('upgrade', 'websocket');
  headers.set('x-rdocs-actor-id', ticket.actorId);
  headers.set('x-rdocs-display-name', ticket.displayName);
  return databaseLiveRoom(env, databaseId).fetch(
    new Request('https://database-live.internal/internal/database-watch', { headers }),
  );
}
