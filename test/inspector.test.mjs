import assert from "node:assert/strict";
import test from "node:test";
import { INSPECTOR_MAX_TOKENS, verifyDelivery } from "../src/inspector.js";

const PIXEL_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

const stubClient = (content, onCreate) => ({
  chat: {
    completions: {
      create: async (params) => {
        onCreate?.(params);
        return { choices: [{ message: { content } }] };
      },
    },
  },
});

test("YES verdict settles the delivery", async () => {
  const result = await verifyDelivery("session-1", PIXEL_B64, {
    client: stubClient("YES"),
  });
  assert.deepEqual(result, { success: true, status: "SETTLED" });
});

test("NO verdict rejects with VISUAL_MISMATCH", async () => {
  const result = await verifyDelivery("session-1", PIXEL_B64, {
    client: stubClient("No, the product is missing from this image."),
  });
  assert.deepEqual(result, { success: false, status: "REJECTED", reason: "VISUAL_MISMATCH" });
});

test("inconclusive or empty verdicts raise INSPECTOR_UNAVAILABLE", async () => {
  await assert.rejects(verifyDelivery("s", PIXEL_B64, { client: stubClient("Maybe, hard to tell") }), {
    code: "INSPECTOR_UNAVAILABLE",
  });
  await assert.rejects(verifyDelivery("s", PIXEL_B64, { client: stubClient(null) }), {
    code: "INSPECTOR_UNAVAILABLE",
  });
});

test("API errors raise INSPECTOR_UNAVAILABLE", async () => {
  const failing = { chat: { completions: { create: async () => { throw new Error("socket hang up"); } } } };
  await assert.rejects(verifyDelivery("s", PIXEL_B64, { client: failing }), {
    code: "INSPECTOR_UNAVAILABLE",
  });
});

test("missing credentials raise INSPECTOR_UNAVAILABLE without a client", async () => {
  const savedKey = process.env.MODEL_API_KEY;
  const savedBase = process.env.META_BASE_URL;
  delete process.env.MODEL_API_KEY;
  delete process.env.META_BASE_URL;
  try {
    await assert.rejects(verifyDelivery("s", PIXEL_B64), { code: "INSPECTOR_UNAVAILABLE" });
  } finally {
    if (savedKey !== undefined) process.env.MODEL_API_KEY = savedKey;
    if (savedBase !== undefined) process.env.META_BASE_URL = savedBase;
  }
});

test("image URLs pass through and the brief is in the prompt", async () => {
  let seen;
  const result = await verifyDelivery("s", "https://example.com/creative.png", {
    brief: "red sneakers on a white background",
    client: stubClient("YES", (params) => {
      seen = params;
    }),
  });
  assert.equal(result.status, "SETTLED");
  assert.equal(seen.model, process.env.META_MODEL);
  const parts = seen.messages[1].content;
  assert.equal(
    parts.find((p) => p.type === "image_url").image_url.url,
    "https://example.com/creative.png"
  );
  assert.match(parts.find((p) => p.type === "text").text, /red sneakers on a white background/);
  assert.match(parts.find((p) => p.type === "text").text, /YES or NO/);
});

test("raw base64 is wrapped in a data URL", async () => {
  let seen;
  await verifyDelivery("s", PIXEL_B64, {
    client: stubClient("YES", (params) => {
      seen = params;
    }),
  });
  const url = seen.messages[1].content.find((p) => p.type === "image_url").image_url.url;
  assert.equal(url, `data:image/png;base64,${PIXEL_B64}`);
});

test("video_gen uses the video-frame prompt", async () => {
  let seen;
  const result = await verifyDelivery("s", "https://example.com/frame.png", {
    capability: "video_gen",
    brief: "product launch clip",
    client: stubClient("YES", (params) => {
      seen = params;
    }),
  });
  assert.equal(result.status, "SETTLED");
  const text = seen.messages[1].content.find((p) => p.type === "text").text;
  assert.match(text, /representing a video frame/);
  assert.match(text, /product launch clip/);
});

test("report_gen uses the professional-chart prompt", async () => {
  let seen;
  await verifyDelivery("s", "https://example.com/chart.png", {
    capability: "report_gen",
    brief: "2026 Market Analysis",
    client: stubClient("YES", (params) => {
      seen = params;
    }),
  });
  assert.equal(
    seen.messages[1].content.find((p) => p.type === "text").text,
    "Is this a professional chart or graph? Reply YES or NO."
  );
  assert.equal(seen.max_tokens, INSPECTOR_MAX_TOKENS);
  assert.ok(INSPECTOR_MAX_TOKENS >= 1000, "token budget must fit model reasoning + verdict");
});

test("image_gen keeps the image prompt without a brief", async () => {
  let seen;
  await verifyDelivery("s", PIXEL_B64, {
    capability: "image_gen",
    client: stubClient("YES", (params) => {
      seen = params;
    }),
  });
  assert.equal(
    seen.messages[1].content.find((p) => p.type === "text").text,
    "Does this image contain the product requested? Reply YES or NO."
  );
});

test("text_gen and doc_gen settle without a client or credentials", async () => {
  const savedKey = process.env.MODEL_API_KEY;
  const savedBase = process.env.META_BASE_URL;
  delete process.env.MODEL_API_KEY;
  delete process.env.META_BASE_URL;
  try {
    for (const capability of ["text_gen", "doc_gen"]) {
      const result = await verifyDelivery("s", "a plain-text deliverable", {
        capability,
        quantity: 5,
      });
      assert.deepEqual(result, { success: true, status: "SETTLED" });
    }
  } finally {
    if (savedKey !== undefined) process.env.MODEL_API_KEY = savedKey;
    if (savedBase !== undefined) process.env.META_BASE_URL = savedBase;
  }
});

test("payload is sanitized and a strict system prompt is sent", async () => {
  let seen;
  const result = await verifyDelivery("s", "https://example.com/creative.png<img src=x onerror=alert(1)>\x00\x1f", {
    client: stubClient("YES", (params) => {
      seen = params;
    }),
  });
  assert.equal(result.status, "SETTLED");
  assert.equal(seen.messages[0].role, "system");
  assert.equal(
    seen.messages[0].content,
    "You are a strict visual inspector. Reply ONLY with the word YES or NO. Do not include punctuation."
  );
  const url = seen.messages[1].content.find((p) => p.type === "image_url").image_url.url;
  assert.equal(url, "https://example.com/creative.png");
});
