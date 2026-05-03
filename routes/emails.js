const express = require('express');
const { google } = require('googleapis');
const router = express.Router();

function requireAuth(req, res, next) {
  if (!req.session.tokens) {
    console.log('[emails] Request rejected — no session tokens');
    return res.status(401).json({ error: 'Not authenticated' });
  }
  next();
}

function getGmailClient(tokens) {
  const oauth2Client = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_REDIRECT_URI
  );
  oauth2Client.setCredentials(tokens);
  oauth2Client.on('tokens', (newTokens) => {
    console.log('[emails] Token refreshed');
    if (newTokens.refresh_token) tokens.refresh_token = newTokens.refresh_token;
    tokens.access_token = newTokens.access_token;
  });
  return google.gmail({ version: 'v1', auth: oauth2Client });
}

function extractBody(payload) {
  if (!payload) return '';
  if (payload.body?.data) {
    return Buffer.from(payload.body.data, 'base64').toString('utf-8');
  }
  const parts = payload.parts || [];
  for (const part of parts) {
    if (part.mimeType === 'text/plain' && part.body?.data) {
      return Buffer.from(part.body.data, 'base64').toString('utf-8');
    }
  }
  for (const part of parts) {
    if (part.mimeType?.startsWith('multipart/')) {
      const nested = extractBody(part);
      if (nested) return nested;
    }
  }
  for (const part of parts) {
    if (part.mimeType === 'text/html' && part.body?.data) {
      return Buffer.from(part.body.data, 'base64')
        .toString('utf-8')
        .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
        .replace(/<[^>]+>/g, ' ')
        .replace(/\s{2,}/g, ' ')
        .trim();
    }
  }
  return '';
}

function parseHeader(headers, name) {
  return headers?.find(h => h.name.toLowerCase() === name.toLowerCase())?.value || '';
}

// Fetch message metadata in batches to avoid rate-limit 429s
async function fetchMetadataBatched(gmail, messageIds, batchSize = 10) {
  const results = [];
  for (let i = 0; i < messageIds.length; i += batchSize) {
    const batch = messageIds.slice(i, i + batchSize);
    const batchResults = await Promise.all(
      batch.map(async (id) => {
        const { data } = await gmail.users.messages.get({
          userId: 'me',
          id,
          format: 'metadata',
          metadataHeaders: ['From', 'Subject', 'Date', 'To'],
        });
        const h = data.payload?.headers || [];
        return {
          id,
          from:     parseHeader(h, 'From'),
          to:       parseHeader(h, 'To'),
          subject:  parseHeader(h, 'Subject') || '(No Subject)',
          date:     parseHeader(h, 'Date'),
          snippet:  data.snippet || '',
          isUnread: data.labelIds?.includes('UNREAD') ?? false,
          labelIds: data.labelIds || [],
        };
      })
    );
    results.push(...batchResults);
  }
  return results;
}

// GET /api/emails/check — diagnostic, call this first to verify Gmail API works
router.get('/check', requireAuth, async (req, res) => {
  const report = {
    sessionOk: true,
    hasAccessToken: !!req.session.tokens?.access_token,
    hasRefreshToken: !!req.session.tokens?.refresh_token,
    gmailApiReachable: false,
    profileEmail: null,
    inboxCount: null,
    error: null,
  };

  try {
    const gmail = getGmailClient(req.session.tokens);

    // Test 1: get user profile (light call)
    const { data: profile } = await gmail.users.getProfile({ userId: 'me' });
    report.profileEmail = profile.emailAddress;
    report.gmailApiReachable = true;
    report.inboxCount = profile.messagesTotal;
    console.log('[emails/check] Profile OK:', profile.emailAddress, 'total messages:', profile.messagesTotal);
  } catch (err) {
    const status = err.response?.status;
    const detail = err.response?.data?.error?.message || err.message;
    report.error = `${status ? status + ': ' : ''}${detail}`;
    console.error('[emails/check] FAILED:', report.error);
  }

  res.json(report);
});

// GET /api/emails
router.get('/', requireAuth, async (req, res) => {
  console.log('[emails] GET / — fetching inbox');
  console.log('[emails] Token present:', !!req.session.tokens?.access_token);

  try {
    const gmail = getGmailClient(req.session.tokens);
    const maxResults = Math.min(parseInt(req.query.limit) || 50, 100);

    console.log('[emails] Calling gmail.users.messages.list…');
    const { data: list } = await gmail.users.messages.list({
      userId: 'me',
      maxResults,
      labelIds: ['INBOX'],
    });

    console.log(`[emails] List response: resultSizeEstimate=${list.resultSizeEstimate}, messages=${list.messages?.length ?? 0}`);

    if (!list.messages?.length) {
      console.log('[emails] No messages returned — inbox may be empty');
      return res.json([]);
    }

    const ids = list.messages.map(m => m.id);
    console.log(`[emails] Fetching metadata for ${ids.length} messages in batches of 10…`);

    const emails = await fetchMetadataBatched(gmail, ids);
    console.log(`[emails] Done — returning ${emails.length} emails`);
    res.json(emails);

  } catch (err) {
    const status = err.response?.status;
    const detail = err.response?.data?.error?.message || err.message;
    console.error(`[emails] ERROR ${status || ''}: ${detail}`);
    console.error('[emails] Full error:', JSON.stringify(err.response?.data || {}, null, 2));

    if (status === 401) {
      return res.status(401).json({ error: 'Gmail token expired — please sign in again', detail });
    }
    if (status === 403) {
      return res.status(403).json({ error: 'Gmail API access denied — check OAuth scopes', detail });
    }
    res.status(500).json({ error: 'Failed to fetch emails', detail });
  }
});

// GET /api/emails/:id
router.get('/:id', requireAuth, async (req, res) => {
  console.log(`[emails] GET /${req.params.id}`);
  try {
    const gmail = getGmailClient(req.session.tokens);
    const { data } = await gmail.users.messages.get({
      userId: 'me',
      id: req.params.id,
      format: 'full',
    });

    const h = data.payload?.headers || [];
    const body = extractBody(data.payload);
    console.log(`[emails] Fetched message, body length: ${body.length}`);

    res.json({
      id:       data.id,
      from:     parseHeader(h, 'From'),
      to:       parseHeader(h, 'To'),
      subject:  parseHeader(h, 'Subject') || '(No Subject)',
      date:     parseHeader(h, 'Date'),
      body:     body || data.snippet || '',
      snippet:  data.snippet || '',
      isUnread: data.labelIds?.includes('UNREAD') ?? false,
      labelIds: data.labelIds || [],
    });
  } catch (err) {
    const status = err.response?.status;
    const detail = err.response?.data?.error?.message || err.message;
    console.error(`[emails] ERROR fetching ${req.params.id} — ${status}: ${detail}`);
    res.status(500).json({ error: 'Failed to fetch email', detail });
  }
});

module.exports = router;
