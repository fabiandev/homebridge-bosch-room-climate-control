export function pretty(obj: object): string {
  return JSON.stringify(obj, null, 2);
}