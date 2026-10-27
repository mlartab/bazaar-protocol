import dotenv from "dotenv";

dotenv.config();

import OpenAI from "openai";

export const INSPECTOR_TIMEOUT_MS = 30000;
// muse-spark-1.3 spends hundreds of completion tokens on hidden reasoning;
// a 100-token cap starves the verdict (finish_reason=length, content=null).
export const INSPECTOR_MAX_TOKENS = 1000;
export const INSPECTOR_SYSTEM_PROMPT =
  "You are a strict visual inspector. Reply ONLY with the word YES or NO. Do not include punctuation.";

function sanitizePayload(payload) {
  return payload.replace(/<[^>]*>/g, "").replace(/[\x00-\x1F\x7F]/g, "");
}

const unavailable = (message) =>
  Object.assign(new Error(message), { code: "INSPECTOR_UNAVAILABLE" });

function toImageUrl(payload) {
  const trimmed = payload.trim();
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  if (/^data:image\/[a-zA-Z0-9+.-]+;base64,/i.test(trimmed)) return trimmed;
  return `data:image/png;base64,${trimmed}`;
}

function buildPrompt(brief, capability) {
  if (capability === "report_gen") {
    return "Is this a professional chart or graph? Reply YES or NO.";
  }
  const subject =
    capability === "video_gen" ? "this image (representing a video frame)" : "this image";
  if (typeof brief === "string" && brief.trim() !== "") {
    return `Does ${subject} contain the product requested in this brief: ${brief}? Reply YES or NO.`;
  }
  return `Does ${subject} contain the product requested? Reply YES or NO.`;
}

function defaultClient(timeoutMs) {
  const apiKey = process.env.MODEL_API_KEY;
  const baseURL = process.env.META_BASE_URL;
  if (!apiKey || !baseURL) {
    throw unavailable("Inspector credentials (MODEL_API_KEY / META_BASE_URL) are not configured.");
  }
  return new OpenAI({ apiKey, baseURL, timeout: timeoutMs });
}

function extractText(completion) {
  const content = completion?.choices?.[0]?.message?.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((part) => typeof part?.text === "string")
      .map((part) => part.text)
      .join(" ");
  }
  return "";
}

export async function verifyDelivery(sessionId, payload, options = {}) {
  void sessionId; // Delivery context arrives via options.brief from the session row.
  void options.quantity; // Threaded for future batch verification; inspection is single-payload.
  if (options.capability === "text_gen" || options.capability === "doc_gen") {
    return { success: true, status: "SETTLED" };
  }
  const timeoutMs = options.timeoutMs ?? INSPECTOR_TIMEOUT_MS;
  const client = options.client ?? defaultClient(timeoutMs);

  let completion;
  try {
    completion = await client.chat.completions.create({
      model: process.env.META_MODEL ?? "muse-spark-1.3",
      max_tokens: INSPECTOR_MAX_TOKENS,
      messages: [
        { role: "system", content: INSPECTOR_SYSTEM_PROMPT },
        {
          role: "user",
          content: [
            { type: "text", text: buildPrompt(options.brief, options.capability) },
            { type: "image_url", image_url: { url: toImageUrl(sanitizePayload(payload)) } },
          ],
        },
      ],
    });
  } catch (err) {
    if (err?.code === "INSPECTOR_UNAVAILABLE") throw err;
    console.error("[inspector] Meta API request failed:", {
      message: err?.message,
      status: err?.status,
      code: err?.code,
      type: err?.type,
      response: err?.response?.data ?? err?.error ?? err?.response,
    });
    throw unavailable(`Inspector request failed: ${err?.message ?? err}`);
  }

  const verdict = extractText(completion).toUpperCase();
  if (verdict.includes("YES")) {
    return { success: true, status: "SETTLED" };
  }
  if (verdict.includes("NO")) {
    return { success: false, status: "REJECTED", reason: "VISUAL_MISMATCH" };
  }
  throw unavailable("Inspector returned an inconclusive verdict.");
}
