const express = require('express');
const fs = require('fs');
const path = require('path');
const router = express.Router();

const DATA_FILE = path.join(__dirname, '../data/categories.json');

function requireAuth(req, res, next) {
  if (!req.session.tokens) return res.status(401).json({ error: 'Not authenticated' });
  next();
}

function loadData() {
  try {
    if (!fs.existsSync(DATA_FILE)) return {};
    return JSON.parse(fs.readFileSync(DATA_FILE, 'utf-8'));
  } catch {
    return {};
  }
}

function saveData(data) {
  const dir = path.dirname(DATA_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}

function userKey(req) {
  return req.session.user?.email || 'default';
}

// GET /api/categories
router.get('/', requireAuth, (req, res) => {
  const data = loadData();
  res.json(data[userKey(req)] || []);
});

// POST /api/categories
router.post('/', requireAuth, (req, res) => {
  const name = req.body.name?.trim();
  if (!name) return res.status(400).json({ error: 'Name is required' });
  if (name.length > 40) return res.status(400).json({ error: 'Name too long' });

  const data = loadData();
  const key = userKey(req);
  if (!data[key]) data[key] = [];

  const category = {
    id: `custom_${Date.now()}`,
    name,
    createdAt: new Date().toISOString(),
  };

  data[key].push(category);
  saveData(data);
  res.json(category);
});

// DELETE /api/categories/:id
router.delete('/:id', requireAuth, (req, res) => {
  const data = loadData();
  const key = userKey(req);
  if (data[key]) {
    data[key] = data[key].filter(c => c.id !== req.params.id);
    saveData(data);
  }
  res.json({ ok: true });
});

module.exports = router;
