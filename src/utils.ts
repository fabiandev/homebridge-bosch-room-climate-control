export function pretty(obj: object): string {
  return JSON.stringify(obj, null, 2);
}

export const debounce = <F extends (...args: any[]) => any>(
  func: F,
  waitFor: number,
) => {
  let timeout;

  const debounced = (...args: any[]) => {
    clearTimeout(timeout);
    timeout = setTimeout(() => func(...args), waitFor);
  };

  return debounced as unknown as (...args: Parameters<F>) => ReturnType<F>;
};