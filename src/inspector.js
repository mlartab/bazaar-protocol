import dotenv from "dotenv";
dotenv.config();

export const INSPECTOR_SYSTEM_PROMPT =
  "You are a strict visual inspector. Reply ONLY with the word YES or NO. Do not include punctuation.";

const unavailable = (message) =>
  Object.assign(new Error(message), { code: "INSPECTOR_UNAVAILABLE" });

function sanitizePayload(payload) {
  return payload.replace(/<[^>]*>/g, "").replace(/[\x00-\x1F\x7F]/g, "");
}

function buildPrompt(brief, capability) {
  if (capability === "report_gen") {
    return "Is this a professional chart or graph? Reply YES or NO.";
  }
  const subject = capability === "video_gen" ? "this image (representing a video frame)" : "this image";
  if (typeof brief === "string" && brief.trim() !== "") {
    return `Does ${subject} contain the product requested in this brief: ${brief}? Reply YES or NO.`;
  }
  return `Does ${subject} contain the product requested? Reply YES or NO.`;
}

export async function verifyDelivery(sessionId, payload, options = {}) {
  void sessionId;
  if (options.capability === "text_gen" || options.capability === "doc_gen") {
    return { success: true, status: "SETTLED" };
  }

  // .trim() kills any invisible spaces or carriage returns from Railway
  const apiKey = (process.env.MODEL_API_KEY || "").trim();
  const baseURL = (process.env.META_BASE_URL || "https://api.meta.ai/v1").trim();
  const model = (process.env.META_MODEL || "muse-spark-1.3").trim();

  if (!apiKey) throw unavailable("Missing MODEL_API_KEY");

  const imageUrl = payload.trim().startsWith("http") 
    ? payload.trim() 
    : `data:image/png;base64,${sanitizePayload(payload)}`;

  const body = {
    model: model,
    max_tokens: 1000,
    messages: [
      { role: "system", content: INSPECTOR_SYSTEM_PROMPT },
      {
        role: "user",
        content: [
          { type: "text", text: buildPrompt(options.brief, options.capability) },
          { type: "image_url", image_url: { url: imageUrl } }
        ]
      }
    ]
  };

  try {
    const response = await fetch(`${baseURL}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${apiKey}`
      },
      body: JSON.stringify(body)
    });

    const data = await response.json();

    if (!response.ok) {
      console.error("[inspector] Native Fetch Error:", JSON.stringify(data));
      throw unavailable(`API failed: ${data?.error?.message || response.statusText}`);
    }

    const content = data?.choices?.[0]?.message?.content || "";
    const verdict = content.toUpperCase();

    if (verdict.includes("YES")) return { success: true, status: "SETTLED" };
    if (verdict.includes("NO")) return { success: false, status: "REJECTED", reason: "VISUAL_MISMATCH" };
    
    throw unavailable(`Inconclusive verdict: ${content}`);

  } catch (err) {
    console.error("[inspector] Fetch exception:", err.message);
    throw unavailable(err.message);
  }
}