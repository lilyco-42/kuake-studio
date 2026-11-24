import { describe, expect, test } from "bun:test";

import { extractShareLinks, indexSharesByPath, normalizeCloudPath, sharesForItem } from "@/lib/share-links";
import type { KuakeShare } from "@/lib/types";

const item = { path: "/06_待整理/IMG001.webp", file_name: "IMG001.webp" };
const shares: KuakeShare[] = [
  {
    pwd_id: "abc",
    share_url: "https://pan.quark.cn/s/abc",
    first_file: { file_name: "IMG001.webp" },
    path_info: "/06_待整理",
  },
  {
    pwd_id: "other",
    share_url: "https://pan.quark.cn/s/other",
    first_file: { file_name: "IMG002.webp" },
    path_info: "/06_待整理",
  },
  {
    pwd_id: "wrongdir",
    share_url: "https://pan.quark.cn/s/wrongdir",
    first_file: { file_name: "IMG001.webp" },
    path_info: "/别处",
  },
];

describe("share-links", () => {
  test("path normalization", () => {
    expect(normalizeCloudPath("a" + String.fromCharCode(92) + "b///")).toBe("/a/b");
    expect(normalizeCloudPath("")).toBe("/");
  });

  test("extracts links from create-share result", () => {
    expect(extractShareLinks({ data: { share_url: "https://pan.quark.cn/s/abc" } })).toEqual([
      "https://pan.quark.cn/s/abc",
    ]);
    expect(extractShareLinks({ pwd_id: "xyz", link: "https://pan.quark.cn/s/link" })).toEqual([
      "https://pan.quark.cn/s/link",
      "https://pan.quark.cn/s/xyz",
    ]);
  });

  test("only matches same file in same folder", () => {
    const index = indexSharesByPath(shares, [item]);
    expect(sharesForItem(index, item).map((s) => s.pwd_id)).toEqual(["abc"]);
    expect(sharesForItem(index, { path: "/别处/IMG001.webp", file_name: "IMG001.webp" })).toEqual([]);
  });
});
