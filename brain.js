/**
 * brain.js — Greg's Sales Intelligence Layer
 *
 * Connects Greg (Telegram bot) to Supabase + Claude API to:
 *   1. Auto-classify incoming Telegram messages for sales relevance
 *   2. Create/update deals automatically from conversation context
 *   3. Extract lessons from deal conversations nightly
 *   4. Answer pipeline questions with AI-powered closing advice
 *
 * Env vars required:
 *   ANTHROPIC_API_KEY          — Claude API key
 *   SUPABASE_URL               — Bolis Command Center project URL
 *   SUPABASE_SERVICE_ROLE_KEY  — Service role key (bypasses RLS)
 */

require("dotenv").config();
const Anthropic     = require("@anthropic-ai/sdk");
const { createClient } = require("@supabase/supabase-js");

// ── Clients ───────────────────────────────────────────────────────────────────

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// ── Helpers ───────────────────────────────────────────────────────────────────

async function isMonitoredChat(chatId) {
  const { data } = await supabase
    .from("monitored_chats")
    .select("id")
    .eq("chat_id", chatId)
    .eq("active", true)
    .maybeSingle();
  return !!data;
}

async function registerChat(chatId, chatName) {
  await supabase
    .from("monitored_chats")
    .upsert({ chat_id: chatId, chat_name: chatName, active: true }, { onConflict: "chat_id" });
}

// ── Message classification ────────────────────────────────────────────────────
// Ask Claude whether a message is sales-relevant and what action to take.

const CLASSIFY_SYSTEM = `You are Greg, a sales intelligence assistant for Bolis Media — a social media marketing agency.
Your job is to classify Telegram messages from the sales team and determine if they relate to sales pipeline activity.

Return ONLY valid JSON matching this schema:
{
  "relevant": boolean,           // is this sales-relevant?
  "action": "new_deal" | "update_deal" | "lesson" | "ignore",
  "client_name": string | null,  // extracted client/prospect name if present
  "status": "lead" | "active" | "negotiating" | "closed" | "lost" | null,
  "value": number | null,        // deal value in dollars if mentioned
  "owner_handle": string | null, // @handle of person handling this deal
  "summary": string | null,      // 1-sentence summary of what happened
  "lesson": string | null        // if action==="lesson", the insight to save
}

Be conservative — only mark relevant=true if the message clearly relates to a sales deal, prospect, or negotiation.
Ignore operational messages about ad posting, scheduling, content, or internal logistics.`;

async function classifyMessage(senderHandle, text) {
  try {
    const msg = await anthropic.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 256,
      system: CLASSIFY_SYSTEM,
      messages: [{ role: "user", content: `Sender: @${senderHandle}\nMessage: ${text}` }],
    });
    const raw = msg.content[0]?.text?.trim() || "{}";
    return JSON.parse(raw);
  } catch (e) {
    console.error("[brain] classifyMessage error:", e.message);
    return { relevant: false, action: "ignore" };
  }
}

// ── Auto-capture pipeline ─────────────────────────────────────────────────────

async function captureMessage(chatId, messageId, senderHandle, text) {
  // 1. Store raw message (deduped by chat_id + message_id)
  const { error: insertErr } = await supabase
    .from("deal_messages")
    .upsert({
      chat_id:        chatId,
      message_id:     messageId,
      sender_handle:  senderHandle,
      message_text:   text,
      classified:     false,
    }, { onConflict: "chat_id,message_id" });

  if (insertErr) {
    console.error("[brain] captureMessage insert error:", insertErr.message);
    return;
  }

  // 2. Classify with Claude
  const result = await classifyMessage(senderHandle, text);
  if (!result.relevant) {
    // Mark classified so we don't re-process
    await supabase
      .from("deal_messages")
      .update({ classified: true })
      .eq("chat_id", chatId)
      .eq("message_id", messageId);
    return;
  }

  console.log(`[brain] 🎯 Sales signal from @${senderHandle}: ${result.action} — ${result.summary}`);

  // 3. Act on classification
  if (result.action === "new_deal" && result.client_name) {
    // Check if deal already exists for this client
    const { data: existing } = await supabase
      .from("deals")
      .select("id")
      .ilike("client_name", result.client_name)
      .not("status", "in", '("closed","lost")')
      .maybeSingle();

    let dealId;
    if (existing) {
      dealId = existing.id;
      // Update if we have new info
      const updates = {};
      if (result.status)       updates.status       = result.status;
      if (result.value)        updates.value        = result.value;
      if (result.owner_handle) updates.owner_handle = result.owner_handle.replace(/^@/, "");
      if (Object.keys(updates).length) {
        await supabase.from("deals").update(updates).eq("id", dealId);
      }
    } else {
      const { data: newDeal } = await supabase
        .from("deals")
        .insert({
          client_name:    result.client_name,
          status:         result.status || "lead",
          value:          result.value  || null,
          owner_handle:   result.owner_handle?.replace(/^@/, "") || senderHandle,
          source_chat_id: chatId,
          notes:          result.summary || null,
        })
        .select("id")
        .single();
      dealId = newDeal?.id;

      // Log activity
      if (dealId) {
        await supabase.from("deal_activities").insert({
          deal_id:  dealId,
          activity: `Deal created: ${result.summary || result.client_name}`,
          actor:    senderHandle,
        });
      }
    }

    // Link message to deal
    if (dealId) {
      await supabase
        .from("deal_messages")
        .update({ deal_id: dealId, classified: true })
        .eq("chat_id", chatId)
        .eq("message_id", messageId);
    }
  }

  if (result.action === "update_deal" && result.client_name) {
    const { data: deal } = await supabase
      .from("deals")
      .select("id, status")
      .ilike("client_name", result.client_name)
      .not("status", "in", '("closed","lost")')
      .maybeSingle();

    if (deal) {
      const updates = {};
      if (result.status && result.status !== deal.status) updates.status = result.status;
      if (result.value)        updates.value        = result.value;
      if (result.owner_handle) updates.owner_handle = result.owner_handle.replace(/^@/, "");
      if (Object.keys(updates).length) {
        await supabase.from("deals").update(updates).eq("id", deal.id);
        await supabase.from("deal_activities").insert({
          deal_id:  deal.id,
          activity: result.summary || `Updated: ${Object.keys(updates).join(", ")}`,
          actor:    senderHandle,
        });
      }
      await supabase
        .from("deal_messages")
        .update({ deal_id: deal.id, classified: true })
        .eq("chat_id", chatId)
        .eq("message_id", messageId);
    }
  }

  if (result.action === "lesson" && result.lesson) {
    await supabase.from("sales_lessons").insert({
      lesson:  result.lesson,
      context: result.summary || null,
      source_message_ids: JSON.stringify([{ chat_id: chatId, message_id: messageId }]),
    });
    await supabase
      .from("deal_messages")
      .update({ classified: true })
      .eq("chat_id", chatId)
      .eq("message_id", messageId);
  }
}

// ── Pipeline summary ──────────────────────────────────────────────────────────

const PIPELINE_SYSTEM = `You are Greg, a sharp sales assistant for Bolis Media — a social media marketing agency.
Given a list of open deals and recent sales lessons, provide:
1. A concise pipeline summary (who's close, who needs attention)
2. For each active deal: one concrete next action to move it forward
3. Any patterns you see across deals

Be direct, specific, and actionable. Use bullet points. Keep it under 400 words.`;

async function getPipelineSummary() {
  // Pull open deals
  const { data: deals } = await supabase
    .from("deals")
    .select("client_name, status, value, owner_handle, notes, created_at, updated_at")
    .not("status", "in", '("closed","lost")')
    .order("updated_at", { ascending: false });

  if (!deals?.length) return "📭 No open deals in the pipeline right now.";

  // Pull recent lessons (last 10)
  const { data: lessons } = await supabase
    .from("sales_lessons")
    .select("lesson, context")
    .order("created_at", { ascending: false })
    .limit(10);

  const dealsText = deals.map((d) =>
    `- ${d.client_name} | ${d.status}${d.value ? ` | $${d.value}` : ""}${d.owner_handle ? ` | @${d.owner_handle}` : ""}${d.notes ? ` | ${d.notes}` : ""}`
  ).join("\n");

  const lessonsText = lessons?.length
    ? lessons.map((l) => `- ${l.lesson}`).join("\n")
    : "No lessons recorded yet.";

  try {
    const msg = await anthropic.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 600,
      system: PIPELINE_SYSTEM,
      messages: [{
        role: "user",
        content: `OPEN DEALS:\n${dealsText}\n\nRECENT SALES LESSONS:\n${lessonsText}`,
      }],
    });
    return msg.content[0]?.text?.trim() || "Could not generate summary.";
  } catch (e) {
    console.error("[brain] getPipelineSummary error:", e.message);
    return "⚠️ Could not generate pipeline summary right now.";
  }
}

// ── Deal-specific advice ──────────────────────────────────────────────────────

async function getDealAdvice(clientName) {
  // Find deal
  const { data: deal } = await supabase
    .from("deals")
    .select("*")
    .ilike("client_name", `%${clientName}%`)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (!deal) return `❌ No deal found matching "${clientName}".`;

  // Pull messages for this deal
  const { data: messages } = await supabase
    .from("deal_messages")
    .select("sender_handle, message_text, captured_at")
    .eq("deal_id", deal.id)
    .order("captured_at", { ascending: true })
    .limit(30);

  // Pull lessons
  const { data: lessons } = await supabase
    .from("sales_lessons")
    .select("lesson")
    .order("created_at", { ascending: false })
    .limit(5);

  const convoText = messages?.length
    ? messages.map((m) => `@${m.sender_handle}: ${m.message_text}`).join("\n")
    : "No conversation history recorded yet.";

  const lessonsText = lessons?.length
    ? lessons.map((l) => `- ${l.lesson}`).join("\n")
    : "";

  try {
    const msg = await anthropic.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 500,
      system: `You are Greg, a sales advisor for Bolis Media. Analyze this deal and give specific, actionable closing advice.`,
      messages: [{
        role: "user",
        content: `DEAL: ${deal.client_name} | ${deal.status}${deal.value ? ` | $${deal.value}` : ""}
Notes: ${deal.notes || "none"}

CONVERSATION HISTORY:
${convoText}

${lessonsText ? `RELEVANT LESSONS:\n${lessonsText}` : ""}

What should we do next to close this deal?`,
      }],
    });
    return `💼 *${deal.client_name}* (${deal.status})\n\n${msg.content[0]?.text?.trim()}`;
  } catch (e) {
    console.error("[brain] getDealAdvice error:", e.message);
    return "⚠️ Could not generate deal advice right now.";
  }
}

// ── Nightly lesson extraction ─────────────────────────────────────────────────
// Runs once a day — scans closed deals from last 7 days and extracts lessons.

async function extractNightlyLessons() {
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

  const { data: recentDeals } = await supabase
    .from("deals")
    .select("id, client_name, status, notes")
    .in("status", ["closed", "lost"])
    .gte("updated_at", sevenDaysAgo);

  if (!recentDeals?.length) return 0;

  let extracted = 0;
  for (const deal of recentDeals) {
    const { data: messages } = await supabase
      .from("deal_messages")
      .select("sender_handle, message_text")
      .eq("deal_id", deal.id)
      .order("captured_at", { ascending: true })
      .limit(50);

    if (!messages?.length) continue;

    const convoText = messages.map((m) => `@${m.sender_handle}: ${m.message_text}`).join("\n");

    try {
      const msg = await anthropic.messages.create({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 400,
        system: `You are a sales coach analyzing completed deals for Bolis Media. Extract 1-3 concrete, reusable lessons from this conversation. Return ONLY a JSON array of strings. Example: ["Lesson one.", "Lesson two."]`,
        messages: [{
          role: "user",
          content: `Deal: ${deal.client_name} — ${deal.status}\n\n${convoText}`,
        }],
      });

      const raw = msg.content[0]?.text?.trim() || "[]";
      const lessons = JSON.parse(raw);
      for (const lesson of lessons) {
        await supabase.from("sales_lessons").insert({
          lesson,
          context:  `Extracted from ${deal.status} deal: ${deal.client_name}`,
          deal_id:  deal.id,
        });
        extracted++;
      }
    } catch (e) {
      console.error(`[brain] extractNightlyLessons error for ${deal.client_name}:`, e.message);
    }
  }

  console.log(`[brain] 🎓 Extracted ${extracted} lessons from ${recentDeals.length} recent deals.`);
  return extracted;
}

// ── Exports ───────────────────────────────────────────────────────────────────

module.exports = {
  isMonitoredChat,
  registerChat,
  captureMessage,
  getPipelineSummary,
  getDealAdvice,
  extractNightlyLessons,
};
