// Labels volume changes made by this app. BluOS reports a source only for some origins (CEC,
// Endpoint); the app's own changes arrive without one. Before changing a volume the app notes the
// expected level, and the monitor uses that label when the matching change comes in.

const EXPIRE_MS = 10_000;
const expected = new Map<string, { level: number; origin: string; until: number }[]>(); // by host

export function expectVolume(host: string, level: number, origin: string) {
  const list = (expected.get(host) ?? []).filter((e) => e.until > Date.now());
  list.push({ level, origin, until: Date.now() + EXPIRE_MS });
  expected.set(host, list);
}

/** Returns (and consumes) the app origin of a volume change, if the app made it. */
export function claimVolume(host: string, level: number): string | undefined {
  const list = (expected.get(host) ?? []).filter((e) => e.until > Date.now());
  const i = list.findIndex((e) => e.level === level);
  if (i < 0) { expected.set(host, list); return undefined; }
  const [hit] = list.splice(i, 1);
  expected.set(host, list);
  return hit.origin;
}
