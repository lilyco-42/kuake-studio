import { describe, expect, test } from "bun:test";

import { boot, startRun, uploadTempRaw } from "@/lib/api";

const realFetch = globalThis.fetch;

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("token 自愈", () => {
  test("后端重启换了令牌时，401 会自动重新握手并重试一次", async () => {
    try {
      let bootCalls = 0;
      const sentTokens: string[] = [];

      globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith("/api/boot")) {
          bootCalls += 1;
          const token = bootCalls === 1 ? "old-token" : "fresh-token";
          return json({ token, name: "kuake-studio", version: "0.5.12", kuake: "" });
        }
        if (url.endsWith("/api/run")) {
          const headers = (init?.headers ?? {}) as Record<string, string>;
          sentTokens.push(headers["X-Kuake-Token"]);
          if (sentTokens.at(-1) !== "fresh-token") {
            return new Response("Unauthorized: bad token", { status: 401 });
          }
          return json({ session_id: "sid-1" });
        }
        return new Response("not found", { status: 404 });
      }) as typeof fetch;

      await boot();
      const sid = await startRun("download", { path: "/a.bin" });

      expect(sid).toBe("sid-1");
      expect(bootCalls).toBe(2);
      expect(sentTokens).toEqual(["old-token", "fresh-token"]);
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});
describe("上传暂存", () => {
  test("大文件走原始二进制路由，不读成 base64", async () => {
    try {
      const seen: { url: string; headers: Record<string, string>; body: unknown }[] = [];
      globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        seen.push({
          url: String(input),
          headers: (init?.headers ?? {}) as Record<string, string>,
          body: init?.body,
        });
        return json({ path: "/tmp/staged.bin", name: "big.bin", size: 3 * 1024 * 1024 });
      }) as typeof fetch;

      const blob = new Blob([new Uint8Array(3 * 1024 * 1024)], {
        type: "application/octet-stream",
      });
      const staged = await uploadTempRaw("big.bin", blob);

      expect(staged).toEqual({ path: "/tmp/staged.bin", name: "big.bin", size: 3145728 });
      expect(seen).toHaveLength(1);
      expect(seen[0].url).toBe("/api/upload/raw");
      expect(seen[0].headers["Content-Type"]).toBe("application/octet-stream");
      expect(seen[0].headers["X-Kuake-File"]).toBe(btoa("big.bin"));
      expect(seen[0].body).toBe(blob);
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});
