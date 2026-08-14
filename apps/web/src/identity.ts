const COLORS = ['#3156a3', '#b6492e', '#37805a', '#8a4da3', '#b07a17', '#317f8d'];

export interface LocalIdentity {
  id: string;
  name: string;
  color: string;
}

export function getLocalIdentity(): LocalIdentity {
  const existing = localStorage.getItem('rdocs.identity');
  if (existing) {
    try {
      return JSON.parse(existing) as LocalIdentity;
    } catch {
      localStorage.removeItem('rdocs.identity');
    }
  }

  const suffix = Math.floor(100 + Math.random() * 900);
  const identity: LocalIdentity = {
    id: crypto.randomUUID(),
    name: `访客 ${suffix}`,
    color: COLORS[Math.floor(Math.random() * COLORS.length)] ?? COLORS[0]!,
  };
  localStorage.setItem('rdocs.identity', JSON.stringify(identity));
  return identity;
}
