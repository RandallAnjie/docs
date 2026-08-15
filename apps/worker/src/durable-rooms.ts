import type { Env } from './env';

export function durableRooms(env: Env): DurableObjectNamespace {
  const rooms = env.DOCUMENTROOM ?? env.DocumentRoom;
  if (!rooms) {
    throw new Error('DOCUMENTROOM binding is missing');
  }
  return rooms;
}
