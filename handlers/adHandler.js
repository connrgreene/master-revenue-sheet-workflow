/**
 * handlers/adHandler.js
 * Called for every message in the Internal Network Ads group.
 *
 * Flow:
 *  1. Parse the message text for ad structure
 *  2. Build the row (matches columns in the revenue sheets)
 *  3. Append to Master Revenue Sheet (always)
 *  4. Append to the individual page's revenue sheet (if handle is known in pages.json)
 *  5. Reply with a ✅ confirmation (or stay silent if not an ad)
 */

const { parseAdMessage }  = require("../parser");
const { appendRow }       = require("../sheets");
const pages               = require("../config/pages.json");

const TARGET_CHAT_ID  = process.env.TARGET_CHAT_ID;
const MASTER_SHEET_ID = process.env.MASTER_SHEET_ID;
const TAB_NAME        = process.env.SHEET_TAB_NAME || "IG Revenue Tracker";

// Placeholder values that haven't been filled in yet (to skip writing to that sheet)
const PLACEHOLDER_PATTERN = /^SHEET_ID_/;

/**
 * Build the row array that matches the revenue sheet column order:
 * [Client Name, Ad Type, Bulk #, Date Posted, Post Type, Post Duration, Ad Price, Notes, (blank), Gross Revenue to Date, Purchase Price]
 *
 * Columns I (hidden) and J (Gross Revenue to Date) and K (Purchase Price) are left
 * blank — they're typically calculated or filled in manually.
 */
function buildRow(parsed, pageHandle) {
  return [
    parsed.client,       // A: Client Name
    parsed.category,     // B: Ad Type (category from message)
    "",                  // C: Bulk # (manual)
    parsed.datePosted,   // D: Date Posted
    parsed.postType,     // E: Post Type (feed/reels/carousel)
    parsed.postDuration, // F: Post Duration (perm/30min NIF/etc.)
    `$${parsed.adPrice}`,// G: Ad Price
    parsed.notes || "",  // H: Notes
    pageHandle ? `@${pageHandle}` : "", // I: Page handle (extra context on Master sheet)
  ];
}

/**
 * Main handler — called by the Telegraf bot for every incoming message.
 */
async function handleAdMessage(ctx) {
  try {
    const chatId = String(ctx.chat?.id);

    // Only process messages from the target group
    if (TARGET_CHAT_ID && chatId !== String(TARGET_CHAT_ID)) return;

    const text = ctx.message?.text || ctx.message?.caption;
    if (!text) return;

    const date   = ctx.message?.date ? new Date(ctx.message.date * 1000) : new Date();
    const parsed = parseAdMessage(text, date);

    // Not an ad message — ignore silently
    if (!parsed) return;

    console.log(
      `[adHandler] Ad detected: "${parsed.client}" / ${parsed.category} / $${parsed.adPrice}` +
      (parsed.pageHandle ? ` → @${parsed.pageHandle}` : " (no page handle found)")
    );

    const row = buildRow(parsed, parsed.pageHandle);
    const results = [];

    // ── Write to Master Revenue Sheet ──────────────────────────────────────────
    if (MASTER_SHEET_ID && !PLACEHOLDER_PATTERN.test(MASTER_SHEET_ID)) {
      try {
        await appendRow(MASTER_SHEET_ID, TAB_NAME, row);
        results.push("✅ Master sheet");
      } catch (err) {
        console.error(`[adHandler] Master sheet write error: ${err.message}`);
        results.push("❌ Master sheet (error)");
      }
    } else {
      console.warn("[adHandler] MASTER_SHEET_ID not configured — skipping master sheet.");
      results.push("⚠️ Master sheet (not configured)");
    }

    // ── Write to individual page revenue sheet ─────────────────────────────────
    // 🚧 DISABLED during A/B test phase — master sheet only for now.
    // Re-enable once master sheet output is validated against the manual process.
    /*
    if (parsed.pageHandle) {
      const sheetId = pages[parsed.pageHandle];

      if (sheetId && !PLACEHOLDER_PATTERN.test(sheetId)) {
        try {
          await appendRow(sheetId, TAB_NAME, row);
          results.push(`✅ @${parsed.pageHandle} sheet`);
        } catch (err) {
          console.error(
            `[adHandler] Individual sheet write error for @${parsed.pageHandle}: ${err.message}`
          );
          results.push(`❌ @${parsed.pageHandle} sheet (error — check share permissions)`);
        }
      } else if (!sheetId) {
        console.warn(
          `[adHandler] No sheet ID mapped for @${parsed.pageHandle}. Add it to config/pages.json.`
        );
        results.push(`⚠️ @${parsed.pageHandle} (no sheet mapped — update pages.json)`);
      } else {
        // Has a placeholder value
        results.push(`⚠️ @${parsed.pageHandle} (sheet ID is a placeholder — update pages.json)`);
      }
    }
    */

    // ── Optional: reply in the chat with a status update ──────────────────────
    // Uncomment the block below if you want the bot to silently confirm each write.
    // (Keep it commented for production to avoid spamming the group.)
    /*
    const summary = results.join("\n");
    await ctx.reply(
      `📊 Revenue logged for *${parsed.client}* ($${parsed.adPrice})\n${summary}`,
      { parse_mode: "Markdown", reply_to_message_id: ctx.message.message_id }
    );
    */

  } catch (err) {
    console.error("[adHandler] Unhandled error:", err.message);
  }
}

module.exports = { handleAdMessage };
