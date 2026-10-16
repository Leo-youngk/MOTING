import assert from "node:assert/strict";
import test from "node:test";
import { activeAiProvider, fallbackAiProvider, getAiProviders, normalizeAiSettings, withAiProviders } from "../lib/ai-providers.ts";
import { DEFAULT_SETTINGS } from "../lib/types.ts";
import type { AiProvider } from "../lib/types.ts";

const google: AiProvider = {
  id: "google", name: "Google", baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
  apiKey: "google-fixture", model: "gemini-fixture", fallbackModel: "gemini-backup",
};
const other: AiProvider = {
  id: "other", name: "另一接口", baseUrl: "https://example.com/v1",
  apiKey: "other-fixture", model: "other-model", fallbackModel: "",
};

test("legacy settings migrate without losing the key, selected model or backup", () => {
  const settings = normalizeAiSettings({ ...DEFAULT_SETTINGS,
    aiBaseUrl: google.baseUrl, aiApiKey: google.apiKey, aiModel: google.model,
    aiFallbackModel: google.fallbackModel,
  });
  assert.equal(getAiProviders(settings).length, 1);
  assert.equal(activeAiProvider(settings)?.apiKey, google.apiKey);
  assert.equal(settings.aiFallbackModel, google.fallbackModel);
  assert.deepEqual(normalizeAiSettings(settings), settings);
});

test("switching providers preserves both configurations and mirrors the active credentials", () => {
  const first = withAiProviders(DEFAULT_SETTINGS, [google, other], google.id);
  const switched = withAiProviders(first, getAiProviders(first), other.id);
  assert.equal(switched.aiApiKey, other.apiKey);
  assert.equal(switched.aiBaseUrl, other.baseUrl);
  assert.equal(switched.aiModel, other.model);
  assert.deepEqual(switched.aiProviders, [google, other]);
  assert.equal(withAiProviders(switched, getAiProviders(switched), google.id).aiApiKey, google.apiKey);
});

test("cross-provider fallback requires a configured, different provider", () => {
  const settings = { ...withAiProviders(DEFAULT_SETTINGS, [google, other], google.id), aiFallbackProviderId: other.id };
  assert.equal(fallbackAiProvider(settings)?.id, other.id);
  assert.equal(fallbackAiProvider({ ...settings, aiFallbackProviderId: google.id }), undefined);
  assert.equal(fallbackAiProvider({ ...settings, aiProviders: [google, { ...other, model: "" }] }), undefined);
  assert.equal(withAiProviders(settings, [google, other], other.id).aiFallbackProviderId, "");
});

test("deletion and an unknown synced selection resolve safely without resurrecting old keys", () => {
  const settings = { ...withAiProviders(DEFAULT_SETTINGS, [google, other], google.id), aiFallbackProviderId: other.id };
  const removed = withAiProviders(settings, [google]);
  assert.equal(removed.aiFallbackProviderId, "");
  const empty = withAiProviders(settings, []);
  assert.equal(empty.aiApiKey, "");
  assert.deepEqual(getAiProviders(normalizeAiSettings(empty)), []);
  assert.equal(normalizeAiSettings({ ...settings, aiActiveProviderId: "deleted" }).aiApiKey, google.apiKey);
  assert.deepEqual(normalizeAiSettings(JSON.parse(JSON.stringify(settings))), settings);
});
