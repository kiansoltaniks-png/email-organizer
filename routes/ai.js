const express = require('express');
const Anthropic = require('@anthropic-ai/sdk');
const router = express.Router();

// Trim the key — Render dashboard values can have invisible trailing whitespace
const apiKey = process.env.ANTHROPIC_API_KEY?.trim();
if (!apiKey) {
  console.error('[ai] ANTHROPIC_API_KEY is not set — all AI routes will fail');
}

const anthropic = new Anthropic({ apiKey: apiKey || 'missing' });

function requireAuth(req, res, next) {
  if (!req.session.tokens) {
    return res.status(401).json({ error: 'Not authenticated' });
  }
  next();
}

// Extract a readable error detail from Anthropic SDK errors
function anthropicErrDetail(err) {
  // SDK wraps API errors in err.error; network errors surface as err.message
  return err.error?.error?.message   // Anthropic API error message
    || err.error?.message
    || err.message
    || 'Unknown error';
}

function anthropicErrStatus(err) {
  return err.status || err.error?.status || 500;
}

// ── GET /api/ai/health ────────────────────────────────────
// Hit this in the browser after signing in to verify the API key works.
router.get('/health', requireAuth, async (req, res) => {
  if (!apiKey) {
    return res.json({ ok: false, error: 'ANTHROPIC_API_KEY is not set on the server' });
  }

  try {
    const msg = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 8,
      messages: [{ role: 'user', content: 'Reply with: ok' }],
    });
    res.json({
      ok: true,
      response: msg.content[0]?.text,
      keyPrefix: apiKey.slice(0, 16) + '…',
    });
  } catch (err) {
    const status = anthropicErrStatus(err);
    const detail = anthropicErrDetail(err);
    console.error(`[ai/health] API check failed — HTTP ${status}: ${detail}`);
    res.json({ ok: false, httpStatus: status, error: detail });
  }
});

// ── POST /api/ai/categorize ───────────────────────────────
const CATEGORIZE_SYSTEM = `You are an email categorization assistant. Analyze emails and assign each one exactly one category from this list:

- urgent: Requires immediate action (deadlines, account alerts, emergencies, time-sensitive requests)
- work: Professional, business, job-related, colleagues, clients, recruiters
- personal: Friends, family, personal contacts, social invitations
- newsletters: Marketing emails, blogs, digests, promotional campaigns, subscriptions
- finance: Bills, invoices, receipts, bank statements, payment confirmations, financial services
- social: Social media notifications (LinkedIn, Twitter, Facebook), community forums, events
- spam: Suspicious, phishing attempts, unsolicited bulk mail, scams
- other: Doesn't fit any category above

Rules:
- Every email must get exactly one category
- If ambiguous between urgent and another category, prefer urgent
- Newsletters and promotions always go to "newsletters" even if they seem relevant
- Respond ONLY with a valid JSON array. No explanation, no markdown.

Format: [{"id":"<email_id>","category":"<category>","reason":"<one short phrase>"}]`;

router.post('/categorize', requireAuth, async (req, res) => {
  const { emails, customCategories = [] } = req.body;
  if (!emails?.length) return res.json([]);

  console.log(`[ai/categorize] Categorizing ${emails.length} emails`);

  try {
    const emailList = emails
      .map(e => `ID: ${e.id}\nFrom: ${e.from}\nSubject: ${e.subject}\nSnippet: ${e.snippet}`)
      .join('\n---\n');

    const customNote = customCategories.length
      ? `\nAdditional custom categories to consider: ${customCategories.join(', ')}. ` +
        `Prefer a custom category over a standard one when it's a clear fit. ` +
        `Use the custom category name exactly as written.`
      : '';

    const message = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 4096,
      system: CATEGORIZE_SYSTEM,
      messages: [
        {
          role: 'user',
          content: `Categorize these ${emails.length} emails:${customNote}\n\n${emailList}`,
        },
      ],
    });

    // Log the full Anthropic response metadata so Render logs show everything
    console.log('[ai/categorize] Anthropic response:', JSON.stringify({
      id:          message.id,
      model:       message.model,
      stop_reason: message.stop_reason,
      usage:       message.usage,
      content_len: message.content.length,
      content_type: message.content[0]?.type,
    }));

    const raw = message.content[0]?.text ?? '';
    console.log(`[ai/categorize] FULL raw response:\n${raw}`);

    const jsonStr = raw.trim().replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '').trim();
    console.log(`[ai/categorize] JSON string to parse:\n${jsonStr}`);

    let categories;
    try {
      categories = JSON.parse(jsonStr);
    } catch (parseErr) {
      console.error(`[ai/categorize] JSON.parse failed: ${parseErr.message}`);
      return res.status(500).json({
        error: 'AI returned malformed JSON',
        detail: parseErr.message,
        raw: raw.slice(0, 1000),
      });
    }

    if (!Array.isArray(categories)) {
      console.error(`[ai/categorize] Parsed value is not an array:`, typeof categories, JSON.stringify(categories).slice(0, 200));
      return res.status(500).json({
        error: 'AI response was not a JSON array',
        detail: `Got type: ${typeof categories}`,
        raw: raw.slice(0, 1000),
      });
    }

    console.log(`[ai/categorize] Done — ${categories.length} categories returned`);
    res.json(categories);

  } catch (err) {
    const status = anthropicErrStatus(err);
    const detail = anthropicErrDetail(err);
    console.error(`[ai/categorize] Anthropic API error — HTTP ${status}: ${detail}`);
    // Log the full error object for Render's log viewer
    if (err.error) console.error('[ai/categorize] Full error body:', JSON.stringify(err.error, null, 2));
    res.status(500).json({ error: 'Failed to categorize emails', detail, httpStatus: status });
  }
});

// ── POST /api/ai/draft-reply ──────────────────────────────
router.post('/draft-reply', requireAuth, async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: 'Email data required' });

  const emailBody = (email.body || email.snippet || '').trim();
  if (!emailBody && !email.subject) {
    return res.status(400).json({ error: 'Email has no content to reply to' });
  }

  console.log(`[ai/draft-reply] Drafting reply for: "${email.subject}" from ${email.from}`);

  try {
    const message = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 1024,
      messages: [
        {
          role: 'user',
          content: `Draft a reply to this email. Be professional, concise, and helpful. Match the tone of the original.

--- ORIGINAL EMAIL ---
From: ${email.from}
Subject: ${email.subject}
Date: ${email.date || ''}

${(emailBody || email.snippet || '(no body)').slice(0, 3000)}
--- END ---

Write only the reply body text. Do not include a subject line. Start directly with the response.`,
        },
      ],
    });

    const draft = message.content[0].text;
    console.log(`[ai/draft-reply] Done — ${draft.length} chars, stop_reason: ${message.stop_reason}`);
    res.json({ draft });
  } catch (err) {
    const status = anthropicErrStatus(err);
    const detail = anthropicErrDetail(err);
    console.error(`[ai/draft-reply] Anthropic API error — HTTP ${status}: ${detail}`);
    if (err.error) console.error('[ai/draft-reply] Full error body:', JSON.stringify(err.error, null, 2));
    res.status(500).json({ error: 'Failed to draft reply', detail, httpStatus: status });
  }
});

// ── POST /api/ai/summarize ────────────────────────────────
router.post('/summarize', requireAuth, async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: 'Email data required' });

  console.log(`[ai/summarize] Summarizing: "${email.subject}"`);

  try {
    const message = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 256,
      messages: [
        {
          role: 'user',
          content: `Summarize this email in 2-3 sentences. Highlight the key ask or information.

From: ${email.from}
Subject: ${email.subject}
Content: ${(email.body || email.snippet || '').slice(0, 2000)}`,
        },
      ],
    });

    res.json({ summary: message.content[0].text });
  } catch (err) {
    const status = anthropicErrStatus(err);
    const detail = anthropicErrDetail(err);
    console.error(`[ai/summarize] Anthropic API error — HTTP ${status}: ${detail}`);
    res.status(500).json({ error: 'Failed to summarize email', detail, httpStatus: status });
  }
});

module.exports = router;
