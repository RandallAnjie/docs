import { useEffect, useRef, useState } from 'react';

import { getDatabaseLiveTicket } from './api';

export interface DatabaseViewer {
  id: string;
  name: string;
}

export type DatabaseLiveMessage =
  | { type: 'changed'; databaseId: string; actorId: string | null; at: number }
  | { type: 'presence'; viewers: DatabaseViewer[] };

export function parseDatabaseLiveMessage(data: unknown): DatabaseLiveMessage | null {
  if (typeof data !== 'string' || data === 'pong') return null;
  try {
    const message = JSON.parse(data) as Record<string, unknown>;
    if (message.type === 'changed' && typeof message.databaseId === 'string') {
      return {
        type: 'changed',
        databaseId: message.databaseId,
        actorId: typeof message.actorId === 'string' ? message.actorId : null,
        at: typeof message.at === 'number' ? message.at : Date.now(),
      };
    }
    if (message.type === 'presence' && Array.isArray(message.viewers)) {
      return {
        type: 'presence',
        viewers: message.viewers.flatMap((viewer) =>
          viewer &&
          typeof viewer === 'object' &&
          typeof (viewer as DatabaseViewer).id === 'string' &&
          typeof (viewer as DatabaseViewer).name === 'string'
            ? [{ id: (viewer as DatabaseViewer).id, name: (viewer as DatabaseViewer).name }]
            : [],
        ),
      };
    }
  } catch {
    // Not a live message.
  }
  return null;
}

/** Reconnect delay after `attempt` failures: 1s, 2s, 4s … capped at 15s. */
export function liveReconnectDelay(attempt: number): number {
  return Math.min(15_000, 1_000 * 2 ** Math.max(0, attempt));
}

/**
 * Keep a live connection to one database while mounted: `onChange` runs
 * whenever anyone changes it, and the result lists who else has it open.
 */
export function useDatabaseLive(
  databaseId: string,
  onChange: (message: Extract<DatabaseLiveMessage, { type: 'changed' }>) => void,
): DatabaseViewer[] {
  const [viewers, setViewers] = useState<DatabaseViewer[]>([]);
  const changeRef = useRef(onChange);
  changeRef.current = onChange;

  useEffect(() => {
    if (typeof WebSocket === 'undefined') return;
    let disposed = false;
    let socket: WebSocket | null = null;
    let attempt = 0;
    let retry = 0;
    let ping = 0;
    const connect = async () => {
      if (disposed) return;
      try {
        const { ticket } = await getDatabaseLiveTicket(databaseId);
        if (disposed) return;
        const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
        const next = new WebSocket(
          `${protocol}//${window.location.host}/database-live/${encodeURIComponent(databaseId)}?ticket=${encodeURIComponent(ticket)}`,
        );
        socket = next;
        next.addEventListener('open', () => {
          attempt = 0;
          window.clearInterval(ping);
          ping = window.setInterval(() => {
            if (next.readyState === WebSocket.OPEN) next.send('ping');
          }, 25_000);
        });
        next.addEventListener('message', (event) => {
          const message = parseDatabaseLiveMessage(event.data);
          if (!message) return;
          if (message.type === 'presence') setViewers(message.viewers);
          else changeRef.current(message);
        });
        next.addEventListener('close', () => {
          window.clearInterval(ping);
          if (socket === next) socket = null;
          schedule();
        });
      } catch {
        schedule();
      }
    };
    const schedule = () => {
      if (disposed) return;
      window.clearTimeout(retry);
      retry = window.setTimeout(() => void connect(), liveReconnectDelay(attempt));
      attempt += 1;
    };
    void connect();
    return () => {
      disposed = true;
      window.clearTimeout(retry);
      window.clearInterval(ping);
      socket?.close();
      setViewers([]);
    };
  }, [databaseId]);

  return viewers;
}
