const express = require('express');
const Anthropic = require('@anthropic-ai/sdk');
const router = express.Router();

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

function requireAuth(req, res, next) {
  if (!req.session.tokens) {
    return res.status(401).json({ error: 'Not authenticated' });
  }
  next();
}

// Cached system prompt for categorization — saves tokens on repeated calls
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

// POST /api/ai/categorize
router.post('/categorize', requireAuth, async (req, res) => {
  const { emails, customCategories = [] } = req.body;
  if (!emails?.length) return res.json([]);

  try {
    const emailList = emails
      .map(e =>
        `ID: ${e.id}\nFrom: ${e.from}\nSubject: ${e.subject}\nSnippet: ${e.snippet}`
      )
      .join('\n---\n');

    const customNote = customCategories.length
      ? `\nAdditional custom categories to consider: ${customCategories.join(', ')}. ` +
        `Prefer a custom category over a standard one when it's a clear fit. ` +
        `Use the custom category name exactly as written.`
      : '';

    const message = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 4096,
      system: [
        {
          type: 'text',
          text: CATEGORIZE_SYSTEM,
          cache_control: { type: 'ephemeral' },
        },
      ],
      messages: [
        {
          role: 'user',
          content: `Categorize these ${emails.length} emails:${customNote}\n\n${emailList}`,
        },
      ],
    });

    const raw = message.content[0].text.trim();
    const json = raw.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');
    const categories = JSON.parse(json);
    res.json(categories);
  } catch (err) {
    console.error('Categorization error:', err.message);
    res.status(500).json({ error: 'Failed to categorize emails' });
  }
});

// POST /api/ai/draft-reply
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
    const detail = err.message
      || err.error?.message
      || JSON.stringify(err.error || {});
    console.error('[ai/draft-reply] Anthropic error:', detail);
    res.status(500).json({ error: 'Failed to draft reply', detail });
  }
});

// POST /api/ai/summarize — summarize a single email
router.post('/summarize', requireAuth, async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: 'Email data required' });

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
    console.error('Summarize error:', err.message);
    res.status(500).json({ error: 'Failed to summarize email' });
  }
});

module.exports = router;
