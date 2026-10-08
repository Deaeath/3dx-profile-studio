// Free built-in AI for 3DX Profile Studio (Cloudflare Worker).
//
// The page POSTs { system, prompt } to /v1/write. This Worker adds the Anthropic key (a Cloudflare
// secret, never sent to browsers), applies limits, and streams the reply back as server-sent events:
//   data: {"t":"<text so far>"}            text as it arrives (whole text, like the page expects)
//   data: {"done":true,"stop":"end_turn"}  finished (stop = Anthropic stop_reason)
//   data: {"error":{"code":"rate","message":"..."}}
// Nothing is stored or logged (only a timestamp per visitor IP for the rate limit, kept one minute).

import { DurableObject } from "cloudflare:workers";
import Anthropic from "@anthropic-ai/sdk";

const MAX_SYSTEM_CHARS = 30000;
const MAX_PROMPT_CHARS = 30000;

// One Limiter instance per key ("ip:1.2.3.4", "day:2026-10-07"); each counts its own hits exactly.
export class Limiter extends DurableObject {
  async take(limit, windowMs) {
    const now = Date.now();
    const hits = ((await this.ctx.storage.get("hits")) || []).filter((t) => now - t < windowMs);
    if (hits.length >= limit) return false;
    hits.push(now);
    await this.ctx.storage.put("hits", hits);
    await this.ctx.storage.setAlarm(now + windowMs);   // forget this visitor once the window has passed
    return true;
  }
  async alarm() {
    await this.ctx.storage.deleteAll();
  }
}

async function take(env, key, limit, windowMs) {
  if (!env.LIMITS) return true;
  try {
    return await env.LIMITS.get(env.LIMITS.idFromName(key)).take(limit, windowMs);
  } catch (e) {
    console.log("limiter error:", String(e));
    return true;   // a limiter outage shouldn't take the AI down; the Anthropic spend limit is the backstop
  }
}

function corsHeaders(origin, env) {
  const allowed = (env.ALLOWED_ORIGINS || "").split(",").map((s) => s.trim()).filter(Boolean);
  return allowed.includes(origin) ? { "Access-Control-Allow-Origin": origin, "Vary": "Origin" } : null;
}

function json(status, body, cors) {
  return new Response(JSON.stringify(body), {
    status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...(cors || {}) },
  });
}
const fail = (status, code, message, cors) => json(status, { error: { code, message } }, cors);

const BUSY = "The free AI is busy right now. Wait a minute and try again, or add your own key in AI settings.";

// Plain messages for players; never pass account details through
function describe(e) {
  if (e instanceof Anthropic.APIUserAbortError) return { code: "cancelled", message: "Stopped." };
  if (e instanceof Anthropic.RateLimitError) return { code: "rate", message: BUSY };
  if (e instanceof Anthropic.BadRequestError) return { code: "api", message: "The AI couldn't use that request. Try different wording." };
  if (e instanceof Anthropic.APIConnectionError) return { code: "network", message: "Couldn't reach the AI. Try again in a moment." };
  if (e instanceof Anthropic.APIError && (e.status === 529 || e.status >= 500)) return { code: "rate", message: BUSY };
  return { code: "unavailable", message: "The free AI isn't working right now. Try again later, or add your own key in AI settings." };
}

// Feedback from the page becomes a GitHub issue (public), filed with a token that can only write issues
const KINDS = { bug: "Bug", idea: "Idea", other: "Feedback" };
const unping = (s) => s.replace(/@/g, "@​");          // no @mentions from strangers
const fence = (s) => "```\n" + s.replace(/```/g, "`​``") + "\n```";

async function feedback(request, env, cors) {
  if (!env.GITHUB_TOKEN || !env.FEEDBACK_REPO) return fail(503, "unavailable", "Feedback isn't set up yet.", cors);
  let b;
  try { b = await request.json(); } catch { return fail(400, "api", "Bad request.", cors); }
  if (b.website) return json(200, { ok: true }, cors);       // honeypot field: bots fill it, people never see it
  const kind = KINDS[b.kind] ? b.kind : "other";
  const message = typeof b.message === "string" ? b.message.trim() : "";
  const contact = typeof b.contact === "string" ? b.contact.trim().slice(0, 100) : "";
  const sample = typeof b.sample === "string" ? b.sample.slice(0, 1500) : "";
  const version = String(b.version || "").slice(0, 20), mode = String(b.mode || "").slice(0, 20);
  if (message.length < 5) return fail(400, "api", "Tell us a little more first.", cors);
  if (message.length > 4000) return fail(413, "api", "That's a bit long. Keep it under 4000 characters.", cors);

  const ip = request.headers.get("CF-Connecting-IP") || "unknown";
  if (!(await take(env, `fb:${ip}`, 3, 3_600_000))) return fail(429, "rate", "Thanks! You've sent a few already. Try again in an hour.", cors);
  if (!(await take(env, `fbday:${new Date().toISOString().slice(0, 10)}`, 50, 86_400_000))) {
    return fail(429, "rate", "We've had lots of feedback today. Please try again tomorrow.", cors);
  }

  const first = message.split("\n")[0].slice(0, 70);
  const lines = [unping(message), "", "---",
                 `**From:** ${contact ? unping(contact) : "anonymous"} · **Version:** ${version || "?"} · **Mode:** ${mode || "?"}`];
  if (sample) lines.push("", "<details><summary>Their text</summary>", "", fence(sample), "", "</details>");
  lines.push("", "<sub>Sent with the Feedback button in 3DX Profile Studio.</sub>");

  let res;
  try {
    res = await fetch(`https://api.github.com/repos/${env.FEEDBACK_REPO}/issues`, {
      method: "POST",
      headers: { "Authorization": `Bearer ${env.GITHUB_TOKEN}`, "Accept": "application/vnd.github+json",
                 "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "3dx-profile-studio-feedback",
                 "Content-Type": "application/json" },
      body: JSON.stringify({ title: `${KINDS[kind]}: ${unping(first)}`, body: lines.join("\n"), labels: ["feedback", kind] }),
    });
  } catch {
    return fail(502, "network", "Couldn't send your feedback. Try again in a moment.", cors);
  }
  if (!res.ok) {
    console.log("github error", res.status, (await res.text()).slice(0, 300));
    return fail(502, "unavailable", "Couldn't send your feedback right now. Try again later.", cors);
  }
  const issue = await res.json();
  return json(200, { ok: true, number: issue.number, url: issue.html_url }, cors);
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const cors = corsHeaders(request.headers.get("Origin") || "", env);

    if (request.method === "OPTIONS") {
      if (!cors) return new Response(null, { status: 403 });
      return new Response(null, {
        status: 204,
        headers: { ...cors, "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
                   "Access-Control-Allow-Headers": "Content-Type", "Access-Control-Max-Age": "86400" },
      });
    }
    if (request.method === "GET" && url.pathname === "/") {
      return json(200, { ok: true, service: "3dx-profile-studio-ai", model: env.MODEL, ready: !!env.ANTHROPIC_API_KEY,
                         feedback: !!env.GITHUB_TOKEN }, { "Access-Control-Allow-Origin": "*" });
    }
    if (request.method === "POST" && url.pathname === "/v1/feedback") {
      if (!cors) return fail(403, "unavailable", "Feedback only works inside 3DX Profile Studio.", null);
      return feedback(request, env, cors);
    }
    if (request.method !== "POST" || url.pathname !== "/v1/write") return fail(404, "api", "Not found.", cors);
    if (!cors) return fail(403, "unavailable", "This free AI only works inside 3DX Profile Studio.", null);
    if (!env.ANTHROPIC_API_KEY) return fail(503, "unavailable", "The free AI isn't set up yet.", cors);

    // Exact limits (Durable Objects): per visitor per minute, and optionally for the whole site per day
    const ip = request.headers.get("CF-Connecting-IP") || "unknown";
    if (!(await take(env, `ip:${ip}`, Number(env.PER_MINUTE) || 10, 60_000))) return fail(429, "rate", BUSY, cors);
    const daily = Number(env.DAILY_LIMIT) || 0;
    if (daily && !(await take(env, `day:${new Date().toISOString().slice(0, 10)}`, daily, 86_400_000))) {
      return fail(429, "rate", "The free AI has used up today's allowance. Try again tomorrow, or add your own key in AI settings.", cors);
    }

    let body;
    try { body = await request.json(); } catch { return fail(400, "api", "Bad request.", cors); }
    const system = typeof body.system === "string" ? body.system : "";
    const prompt = typeof body.prompt === "string" ? body.prompt : "";
    if (!prompt.trim()) return fail(400, "api", "Nothing to write about yet.", cors);
    if (system.length > MAX_SYSTEM_CHARS || prompt.length > MAX_PROMPT_CHARS) {
      return fail(413, "api", "That's too much text for the free AI. Select less, or add your own key in AI settings.", cors);
    }

    const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
    const model = env.MODEL || "claude-opus-5-5";
    const params = { model, max_tokens: Number(env.MAX_TOKENS) || 16000, system,
                     messages: [{ role: "user", content: prompt }] };
    if (env.EFFORT) params.output_config = { effort: env.EFFORT };
    // On a safety decline, re-run on Anthropic's recommended model instead of failing
    const fallback = /^claude-(opus-5-5|opus-5|sonnet-5-5|fable-5-1)$/.test(model);
    const opts = { signal: request.signal };   // the player pressing Stop cancels the request

    const { readable, writable } = new TransformStream();
    const writer = writable.getWriter();
    const enc = new TextEncoder();
    const send = (obj) => writer.write(enc.encode(`data: ${JSON.stringify(obj)}\n\n`));

    const pump = (async () => {
      try {
        const stream = fallback
          ? client.beta.messages.stream({ ...params, betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" }, opts)
          : client.messages.stream(params, opts);
        let text = "";
        for await (const ev of stream) {
          if (ev.type === "content_block_delta" && ev.delta.type === "text_delta") {
            text += ev.delta.text;
            await send({ t: text });
          }
        }
        const msg = await stream.finalMessage();
        await send({ done: true, stop: msg.stop_reason });
      } catch (e) {
        try { await send({ error: describe(e) }); } catch { /* player already left */ }
      } finally {
        try { await writer.close(); } catch { /* already closed */ }
      }
    })();
    ctx.waitUntil(pump);

    return new Response(readable, {
      status: 200, headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-store", ...cors },
    });
  },
};
