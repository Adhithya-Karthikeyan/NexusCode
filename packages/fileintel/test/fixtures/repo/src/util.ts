// Shared utilities referenced across the fixture repo.
export function helper(x: number): number {
  return x + 1;
}

export const formatName = (name: string): string => `<${name}>`;

const INTERNAL_SEED = 3;

export function seldomUsed(): number {
  return INTERNAL_SEED;
}
