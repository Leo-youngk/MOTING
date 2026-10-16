import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright");
const browser = await chromium.launch({
  headless: true, args: ["--no-sandbox"],
  ...(process.env.BROWSER_BIN ? { executablePath: process.env.BROWSER_BIN } : {}),
});
try {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, reducedMotion: "reduce" });
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.route("**/api/ai/models", async route => {
    const { baseUrl } = route.request().postDataJSON();
    await route.fulfill({ json: { data: [{ id: baseUrl.includes("deepseek") ? "deepseek-fixture" : "legacy-fixture" }] } });
  });
  await page.route("**/api/weread/**", route => route.fulfill({ json: { data: [] } }));
  await page.goto(process.env.TEST_BASE_URL || "http://127.0.0.1:4173");
  await page.getByRole("button", { name: "设置", exact: true }).waitFor();

  const stored = () => page.evaluate(() => new Promise((resolve, reject) => {
    const request = indexedDB.open("moting-reader");
    request.onsuccess = () => {
      const db = request.result;
      const transaction = db.transaction("settings", "readonly");
      const item = transaction.objectStore("settings").get("reader");
      item.onsuccess = () => resolve(item.result);
      transaction.oncomplete = () => db.close();
      transaction.onerror = () => reject(transaction.error);
    };
  }));
  await page.evaluate(() => new Promise((resolve, reject) => {
    const request = indexedDB.open("moting-reader");
    request.onsuccess = () => {
      const db = request.result;
      const transaction = db.transaction("settings", "readwrite");
      transaction.objectStore("settings").put({
        aiBaseUrl: "https://legacy.example/v1", aiApiKey: "legacy-key", aiModel: "legacy-fixture",
        aiFallbackModel: "legacy-backup", aiDeepThinking: false,
      }, "reader");
      transaction.oncomplete = () => { db.close(); resolve(); };
      transaction.onerror = () => reject(transaction.error);
    };
  }));
  await page.reload();
  const openSettings = async () => {
    const add = page.getByRole("button", { name: "添加服务商", exact: true });
    const settingsButton = page.getByRole("button", { name: "设置", exact: true });
    const aiLink = page.getByRole("button", { name: /AI 助手/ });
    await add.or(settingsButton).or(aiLink).first().waitFor();
    if (await add.isVisible()) return;
    if (await settingsButton.isVisible()) await settingsButton.click();
    await aiLink.click();
  };
  await openSettings();
  await page.getByText("配置 · 原有配置", { exact: true }).waitFor();
  assert.equal(await page.getByPlaceholder("输入 API Key").inputValue(), "legacy-key");

  await page.getByRole("button", { name: "添加服务商", exact: true }).click();
  await page.getByRole("dialog", { name: "添加服务商" }).getByRole("button", { name: "DeepSeek", exact: true }).click();
  await page.getByText("配置 · DeepSeek", { exact: true }).waitFor();
  await page.getByPlaceholder("输入 API Key").fill("deepseek-key");
  await page.getByText("主模型", { exact: true }).click(); // blur saves the connection
  await page.getByRole("status").filter({ hasText: "接口返回了 1 个模型" }).waitFor();
  await page.getByRole("button", { name: "填写模型名称", exact: true }).click();
  await page.getByRole("dialog", { name: "主模型", exact: true }).getByRole("button", { name: "deepseek-fixture", exact: true }).click();
  await page.getByRole("button", { name: "使用 DeepSeek", exact: true }).click();
  await page.waitForFunction(() => document.querySelector(".ai-provider-row .text-button[disabled]")?.getAttribute("aria-label") === "使用 DeepSeek");
  let settings = await stored();
  assert.equal(settings.aiApiKey, "deepseek-key");
  assert.equal(settings.aiModel, "deepseek-fixture");
  assert.equal(settings.aiProviders.length, 2);
  const deepseek = settings.aiProviders.find(provider => provider.name === "DeepSeek");

  await page.getByRole("button", { name: "使用 原有配置", exact: true }).click();
  assert.equal(await page.getByPlaceholder("输入 API Key").inputValue(), "legacy-key");
  await page.getByLabel("备用服务商", { exact: true }).selectOption(deepseek.id);
  await page.reload();
  await openSettings();
  assert.equal(await page.getByLabel("备用服务商", { exact: true }).inputValue(), deepseek.id);
  assert.equal(await page.getByPlaceholder("输入 API Key").inputValue(), "legacy-key");
  assert.ok(await page.locator("body").evaluate(body => body.scrollWidth <= innerWidth), "mobile page must not overflow horizontally");
  if (process.env.SCREENSHOT_PATH) await page.screenshot({ path: process.env.SCREENSHOT_PATH, fullPage: true });

  await page.getByRole("button", { name: "DeepSeek deepseek-fixture", exact: true }).click();
  await page.getByRole("button", { name: "删除此服务商", exact: true }).click();
  settings = await stored();
  assert.equal(settings.aiProviders.length, 1);
  assert.equal(settings.aiFallbackProviderId, "");
  assert.equal(settings.aiApiKey, "legacy-key");
  await page.getByText("配置 · 原有配置", { exact: true }).waitFor();
  await page.getByRole("button", { name: "删除此服务商", exact: true }).click();
  await page.waitForFunction(() => document.querySelectorAll(".ai-provider-row").length === 0);
  await page.reload();
  await openSettings();
  assert.equal(await page.locator(".ai-provider-row").count(), 0);
  settings = await stored();
  assert.equal(settings.aiApiKey, "");
  assert.deepEqual(errors, []);
  console.log("PASS: mobile legacy migration, independent keys/models, provider switching, backup persistence, deletion and reload");
} finally { await browser.close(); }
