const express = require('express');
const { google } = require('googleapis');
const router = express.Router();

const SCOPES = [
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/userinfo.email',
  'https://www.googleapis.com/auth/userinfo.profile',
];

function createOAuthClient() {
  return new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_REDIRECT_URI
  );
}

router.get('/login', (req, res) => {
  const oauth2Client = createOAuthClient();
  const authUrl = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: SCOPES,
    prompt: 'consent',
  });
  res.redirect(authUrl);
});

router.get('/callback', async (req, res) => {
  const { code, error, error_description } = req.query;

  if (error) {
    console.error('Google OAuth error:', error, error_description);
    return res.redirect(`/?error=${encodeURIComponent(error_description || error)}`);
  }

  if (!code) {
    return res.redirect('/?error=no_code');
  }

  try {
    const oauth2Client = createOAuthClient();

    const { tokens } = await oauth2Client.getToken(code);
    oauth2Client.setCredentials(tokens);

    const oauth2 = google.oauth2({ version: 'v2', auth: oauth2Client });
    const { data: userInfo } = await oauth2.userinfo.get();

    req.session.tokens = tokens;
    req.session.user = {
      email: userInfo.email,
      name: userInfo.name,
      picture: userInfo.picture,
    };

    // Ensure session is written before redirecting
    req.session.save((saveErr) => {
      if (saveErr) {
        console.error('Session save error:', saveErr);
        return res.redirect('/?error=session_error');
      }
      res.redirect('/dashboard.html');
    });
  } catch (err) {
    const detail = err.response?.data?.error_description
      || err.response?.data?.error
      || err.message;
    console.error('OAuth callback error:', detail, err.response?.data || '');
    res.redirect(`/?error=${encodeURIComponent(detail)}`);
  }
});

router.get('/debug', (req, res) => {
  res.json({
    clientId:    process.env.GOOGLE_CLIENT_ID ? process.env.GOOGLE_CLIENT_ID.slice(0, 20) + '…' : 'MISSING',
    clientSecret:process.env.GOOGLE_CLIENT_SECRET ? 'SET' : 'MISSING',
    redirectUri: process.env.GOOGLE_REDIRECT_URI || 'MISSING',
  });
});

router.get('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/'));
});

router.get('/status', (req, res) => {
  if (req.session.tokens && req.session.user) {
    res.json({ authenticated: true, user: req.session.user });
  } else {
    res.json({ authenticated: false });
  }
});

module.exports = router;
