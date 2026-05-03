require('dotenv').config();
const express = require('express');
const session = require('express-session');
const path = require('path');

const authRoutes = require('./routes/auth');
const emailRoutes = require('./routes/emails');
const aiRoutes = require('./routes/ai');
const categoryRoutes = require('./routes/categories');

const isProd = process.env.NODE_ENV === 'production';

const app = express();

// Render (and most PaaS) terminates SSL at the load balancer and forwards HTTP
// internally — trust proxy so Express sees the correct protocol for secure cookies
if (isProd) app.set('trust proxy', 1);

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.use(session({
  secret: process.env.SESSION_SECRET || 'dev-secret-change-in-production',
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: isProd,   // HTTPS-only cookies in production
    httpOnly: true,
    sameSite: isProd ? 'lax' : false,
    maxAge: 24 * 60 * 60 * 1000,
  },
}));

app.use('/auth', authRoutes);
app.use('/api/emails', emailRoutes);
app.use('/api/ai', aiRoutes);
app.use('/api/categories', categoryRoutes);

// Redirect root to index
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Email Organizer running — port ${PORT} — env: ${process.env.NODE_ENV || 'development'}`);
});
