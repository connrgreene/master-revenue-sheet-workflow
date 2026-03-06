/**
 * parser.js
 * Parses ad messages from the Internal Network Ads Telegram group.
 *
 * Expected message format:
 *
 *   {Client Name} - {Category} - ${Price}
 *
 *   @admin1 @admin2
 *
 *   **INSTRUCTIONS:**
 *   - feed / reels / carousel
 *   - 30min NIF / Perm post / etc.
 *
 *   **PAGE INFO:**
 *   [time] AZ / [time] EST
 *   @{page_handle} - ${price}
 *
 * Returns null if the message doesn't look like a valid ad.
 */

/**
 * @param {string} text  Raw Telegram message text
 * @param {Date}   date  Timestamp of the message
 * @returns {{ client, category, adPrice, pageHandle, postType, postDuration, notes, datePosted } | null}
 */
function parseAdMessage(text, date) {
  if (!text || typeof text !== "string") return null;

  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
  if (lines.length < 2) return null;

  // ── Line 1: "{Client} - {Category} - ${amount}" ─────────────────────────────
  // Allow $ or no $ (some messages write $0 or just a number)
  const headerMatch = lines[0].match(
    /^(.+?)\s*-\s*(.+?)\s*-\s*\$?([\d,]+(?:\.\d{1,2})?)$/
  );
  if (!headerMatch) return null;

  const client   = headerMatch[1].trim();
  const category = headerMatch[2].trim();
  const adPrice  = parseFloat(headerMatch[3].replace(/,/g, ""));

  // ── PAGE INFO section ────────────────────────────────────────────────────────
  // Find the line "**PAGE INFO:**" then scan for "@handle - $amount"
  let pageHandle = null;
  const pageInfoIdx = lines.findIndex((l) =>
    l.replace(/\*/g, "").toLowerCase().includes("page info")
  );

  if (pageInfoIdx !== -1) {
    // Look at lines after PAGE INFO for "@handle - $amount"
    for (let i = pageInfoIdx + 1; i < lines.length; i++) {
      const m = lines[i].match(/^@([\w.]+)\s*-\s*\$?([\d,]+(?:\.\d{1,2})?)/);
      if (m) {
        pageHandle = m[1].toLowerCase();
        break;
      }
    }
  }

  // Fallback: scan the whole message for an @handle that looks like a page (not an admin)
  if (!pageHandle) {
    for (const line of lines) {
      const m = line.match(/^@([\w.]+)\s*-\s*\$?([\d,]+)/);
      if (m) {
        pageHandle = m[1].toLowerCase();
        break;
      }
    }
  }

  // ── INSTRUCTIONS section ─────────────────────────────────────────────────────
  let postType     = "";
  let postDuration = "";
  const instrIdx = lines.findIndex((l) =>
    l.replace(/\*/g, "").toLowerCase().includes("instructions")
  );

  if (instrIdx !== -1) {
    const instrEnd = pageInfoIdx !== -1 ? pageInfoIdx : lines.length;
    const instrLines = lines.slice(instrIdx + 1, instrEnd).map((l) =>
      l.replace(/^[-*•]\s*/, "").replace(/\*/g, "").trim()
    );

    // Post type
    const typeKeywords = ["feed", "reel", "reels", "carousel", "story", "stories"];
    for (const instr of instrLines) {
      const lower = instr.toLowerCase();
      if (typeKeywords.some((k) => lower.includes(k))) {
        // Capitalise first letter
        postType = instr.charAt(0).toUpperCase() + instr.slice(1);
        break;
      }
    }

    // Post duration — perm / NIF / time-based
    const durationKeywords = ["perm", "nif", "do not delete", "24h", "48h", "hour", "week", "month"];
    for (const instr of instrLines) {
      const lower = instr.toLowerCase();
      if (durationKeywords.some((k) => lower.includes(k))) {
        postDuration = instr.charAt(0).toUpperCase() + instr.slice(1);
        break;
      }
    }

    // If still no postType (e.g. just "feed" with no keyword match above), try first bullet
    if (!postType && instrLines.length > 0) {
      postType = instrLines[0].charAt(0).toUpperCase() + instrLines[0].slice(1);
    }
  }

  // ── Notes — any non-standard instructions ────────────────────────────────────
  const notes = "";

  // ── Format the date ───────────────────────────────────────────────────────────
  const d = date || new Date();
  const datePosted = `${d.toLocaleDateString("en-US", {
    weekday: "short",
    month: "numeric",
    day: "numeric",
    year: "2-digit",
  })}`;

  return {
    client,
    category,
    adPrice,
    pageHandle,   // null if not found — will still write to Master sheet
    postType,
    postDuration,
    notes,
    datePosted,
  };
}

module.exports = { parseAdMessage };
