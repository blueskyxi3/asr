import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { test } from "node:test";
import type { FastifyRequest } from "fastify";
import { authenticateVoice } from "../src/voice-module.js";

test("module identity binds user, plugin, method, URI and expiry; bearer keys cannot access internal routes", () => {
  const secret = "module-pairing-secret-at-least-32-characters";
  const apiKey = "service-api-key-at-least-32-characters";
  const claims = { plugin_id: "asr", user_id: 1, method: "GET", uri: "/assets/plugin.js", expires_at: Math.floor(Date.now() / 1000) + 30 };
  const identity = (changes = {}) => {
    const body = Buffer.from(JSON.stringify({ ...claims, ...changes })).toString("base64url");
    return `${body}.${createHmac("sha256", secret).update(body).digest("base64url")}`;
  };
  const request = (token: string, url = claims.uri) => ({ headers: { "x-aihub-identity": token }, method: "GET", url }) as unknown as FastifyRequest;
  assert.doesNotThrow(() => authenticateVoice(request(identity()), apiKey, secret));
  for (const changes of [{ user_id: 0 }, { plugin_id: "agent" }, { method: "POST" }, { uri: "/assets/other.js" }, { expires_at: 1 }]) {
    assert.throws(() => authenticateVoice(request(identity(changes)), apiKey, secret));
  }
  assert.throws(() => authenticateVoice(request(identity() + "extra"), apiKey, secret));
  assert.throws(() => authenticateVoice(request(identity()), apiKey, ""));
  assert.throws(() => authenticateVoice({ url: "/internal/manifest", headers: { authorization: `Bearer ${apiKey}` } } as unknown as FastifyRequest, apiKey, secret));
  assert.throws(() => authenticateVoice({ url: "/assets/plugin.js", headers: { authorization: "中".repeat(apiKey.length + 7) } } as unknown as FastifyRequest, apiKey, secret));
});
