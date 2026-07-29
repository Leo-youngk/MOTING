import assert from "node:assert/strict";
import test from "node:test";

import { pickStableWindowsVersion } from "../worker/edge-tts.ts";
import type { EdgeProduct } from "../worker/edge-tts.ts";

const products: EdgeProduct[] = [
  {
    Product: "Beta",
    Releases: [
      {
        Platform: "Windows",
        Architecture: "x64",
        ProductVersion: "151.0.4100.1",
      },
    ],
  },
  {
    Product: "Stable",
    Releases: [
      {
        Platform: "MacOS",
        Architecture: "universal",
        ProductVersion: "150.0.4078.100",
      },
      {
        Platform: "Windows",
        Architecture: "arm64",
        ProductVersion: "150.0.4078.104",
      },
      {
        Platform: "Windows",
        Architecture: "x64",
        ProductVersion: "150.0.4078.105",
      },
    ],
  },
];

test("从更新接口里挑出 Windows x64 稳定版", () => {
  assert.equal(pickStableWindowsVersion(products), "150.0.4078.105");
});

test("缺少稳定版渠道时返回 null", () => {
  assert.equal(pickStableWindowsVersion([products[0]]), null);
});

test("版本号格式不合法时返回 null", () => {
  const malformed: EdgeProduct[] = [
    {
      Product: "Stable",
      Releases: [
        {
          Platform: "Windows",
          Architecture: "x64",
          ProductVersion: "150.0.4078.105'&x=",
        },
      ],
    },
  ];
  assert.equal(pickStableWindowsVersion(malformed), null);
});
