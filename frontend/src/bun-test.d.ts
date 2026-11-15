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
      toBeGreaterThan(expected: number): void;
      toContain(expected: string): void;
      toBeNull(): void;
      toBeUndefined(): void;
    };
  };
}

/** bun 运行时最小声明（只为单测扫描源码，不引入 @types/bun / bun.lock 变更）。 */
declare module "bun" {
  export class Glob {
    constructor(pattern: string);
    scanSync(cwd: string): string[];
  }
}
declare const Bun: { file(path: string): { text(): Promise<string> } };
