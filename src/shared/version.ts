export function compareVersions(a: string, b: string): number {
  const left = (a || "0").split(/[^\d]+/).filter(Boolean).map(Number);
  const right = (b || "0").split(/[^\d]+/).filter(Boolean).map(Number);
  const length = Math.max(left.length, right.length, 3);
  for (let index = 0; index < length; index++) {
    const leftPart = left[index] || 0;
    const rightPart = right[index] || 0;
    if (leftPart > rightPart) return 1;
    if (leftPart < rightPart) return -1;
  }
  return 0;
}
