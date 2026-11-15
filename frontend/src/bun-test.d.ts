/**
 * bun:test 的最小类型声明。
 * 为什么手写：CI 用 bun install --frozen-lockfile，为单测新增 @types/bun 会改 bun.lock，
 * 而 bun 自带的 test runner 在运行时本就提供这些 API；这里只补 tsc 需要的签名。
 */
declare module "bun:test" {
  export function describe(name: string, fn: () => void): void;
  export function test(name: string, fn: () => void | Promise<void>): void;
  export const expect: {
    <T>(received: T): {
      toBe(expected: T): void;
      toEqual(expected: unknown): void;
      toHaveLength(expected: number): void;
      toBeGreaterThanOrEqual(expected: number): void;
      toContain(expected: string): void;
      toBeNull(): void;
      toBeUndefined(): void;
    };
  };
}
