/* Email Organizer — Dashboard JS */
'use strict';

// ── State ────────────────────────────────────────────────
const state = {
  emails: [],
  categories: {},       // emailId → { category, reason }
  customCategories: [], // [{ id, name, createdAt }]
  activeCategory: 'all',
  activeEmailId: null,
  emailCache: {},
};

// ── DOM refs ─────────────────────────────────────────────
const $ = id => document.getElementById(id);

const els = {
  loadingState:      $('loading-state'),
  loadingText:       $('loading-text'),
  emptyState:        $('empty-state'),
  emailList:         $('email-list'),
  panelTitle:        $('panel-title'),
  panelSubtitle:     $('panel-subtitle'),
  categoryNav:       $('category-nav'),
  customCategoryNav: $('custom-category-nav'),
  sidebarStatus:     $('sidebar-status'),

  detailPanel:       $('email-detail-panel'),
  detailPlaceholder: $('detail-placeholder'),
  detailContent:     $('detail-content'),
  detailSubject:     $('detail-subject'),
  detailFrom:        $('detail-from'),
  detailDate:        $('detail-date'),
  detailCatBadge:    $('detail-category-badge'),
  detailBody:        $('detail-body'),
  detailClose:       $('detail-close'),

  btnRefresh:    $('btn-refresh'),
  btnSummarize:  $('btn-summarize'),
  btnDraft:      $('btn-draft'),
  btnCopyDraft:  $('btn-copy-draft'),

  summaryPanel:  $('summary-panel'),
  summaryText:   $('summary-text'),
  draftPanel:    $('draft-panel'),
  draftText:     $('draft-text'),

  userAvatar:    $('user-avatar'),
  userName:      $('user-name'),

  btnAddLabel:    $('btn-add-label'),
  addLabelForm:   $('add-label-form'),
  addLabelInput:  $('add-label-input'),
  btnLabelCancel: $('btn-label-cancel'),
};

// ── Built-in category metadata ────────────────────────────
const CAT_META = {
  all:         { label: 'All Emails',  icon: '📬' },
  urgent:      { label: 'Urgent',      icon: '🔴' },
  work:        { label: 'Work',        icon: '💼' },
  personal:    { label: 'Personal',    icon: '👤' },
  finance:     { label: 'Finance',     icon: '💳' },
  newsletters: { label: 'Newsletters', icon: '📰' },
  social:      { label: 'Social',      icon: '💬' },
  spam:        { label: 'Spam',        icon: '🚫' },
  other:       { label: 'Other',       icon: '📂' },
};

// Colors and icons cycled for custom categories
const CUSTOM_COLORS = [
  { bg: '#ECFDF5', color: '#059669' },
  { bg: '#FFF7ED', color: '#C2410C' },
  { bg: '#F0F9FF', color: '#0369A1' },
  { bg: '#FDF4FF', color: '#A21CAF' },
  { bg: '#FFFBEB', color: '#B45309' },
  { bg: '#FFF1F2', color: '#BE123C' },
  { bg: '#F0FDF4', color: '#15803D' },
  { bg: '#EFF6FF', color: '#1D4ED8' },
];
const CUSTOM_ICONS = ['🏷️', '🔬', '📚', '🎯', '🌟', '🏠', '🎨', '🚀', '💡', '🎵', '🌍', '🤝'];

function customStyle(index) {
  return CUSTOM_COLORS[index % CUSTOM_COLORS.length];
}
function customIcon(index) {
  return CUSTOM_ICONS[index % CUSTOM_ICONS.length];
}

// ── Init ─────────────────────────────────────────────────
(async function init() {
  await loadUser();
  await Promise.all([loadCustomCategories(), loadEmails()]);
})();

// ── Auth ─────────────────────────────────────────────────
async function loadUser() {
  try {
    const res = await fetch('/auth/status');
    const data = await res.json();
    if (!data.authenticated) { window.location.href = '/'; return; }
    if (data.user) {
      if (data.user.picture) els.userAvatar.src = data.user.picture;
      els.userName.textContent = data.user.name || data.user.email;
    }
  } catch {
    window.location.href = '/';
  }
}

// ── Custom Categories ─────────────────────────────────────
async function loadCustomCategories() {
  try {
    const res = await fetch('/api/categories');
    if (!res.ok) return;
    state.customCategories = await res.json();
    renderCustomCategories();
  } catch (err) {
    console.error('Failed to load custom categories:', err);
  }
}

function renderCustomCategories() {
  const nav = els.customCategoryNav;

  if (state.customCategories.length === 0) {
    nav.innerHTML = '<p class="no-custom-cats">No custom labels yet</p>';
    return;
  }

  nav.innerHTML = state.customCategories.map((cat, i) => {
    const style = customStyle(i);
    const icon = customIcon(i);
    const isActive = state.activeCategory === cat.name ? 'active' : '';
    const countId = `count-custom-${cat.id}`;
    return `
      <div class="category-item custom-cat-item ${isActive}" data-category="${escHtml(cat.name)}" tabindex="0" role="button">
        <span class="cat-icon">${icon}</span>
        <span class="cat-label">${escHtml(cat.name)}</span>
        <span class="cat-count" id="${countId}">0</span>
        <button class="cat-delete" data-cat-id="${cat.id}" title="Delete label" aria-label="Delete ${escHtml(cat.name)}">×</button>
      </div>
    `;
  }).join('');

  // Click: select category or delete
  nav.querySelectorAll('.custom-cat-item').forEach(item => {
    item.addEventListener('click', e => {
      const deleteBtn = e.target.closest('.cat-delete');
      if (deleteBtn) {
        e.stopPropagation();
        deleteCustomCategory(deleteBtn.dataset.catId, item.dataset.category);
        return;
      }
      setActiveCategory(item.dataset.category);
    });
    item.addEventListener('keydown', e => {
      if (e.key === 'Enter' || e.key === ' ') setActiveCategory(item.dataset.category);
    });
  });
}

async function addCustomCategory(name) {
  try {
    const res = await fetch('/api/categories', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    });
    if (!res.ok) {
      const err = await res.json();
      alert(err.error || 'Failed to add label');
      return;
    }
    const cat = await res.json();
    state.customCategories.push(cat);
    renderCustomCategories();
    updateCounts();

    // Re-categorize so the new label is considered
    if (state.emails.length > 0) {
      await categorizeEmails();
      renderEmailList();
      updateCounts();
    }
  } catch (err) {
    console.error('Failed to add custom category:', err);
  }
}

async function deleteCustomCategory(id, name) {
  if (!confirm(`Delete the label "${name}"? Emails won't be deleted.`)) return;

  try {
    await fetch(`/api/categories/${id}`, { method: 'DELETE' });
    state.customCategories = state.customCategories.filter(c => c.id !== id);

    // If we were viewing this category, go back to all
    if (state.activeCategory === name) {
      setActiveCategory('all');
    }

    renderCustomCategories();
    updateCounts();
  } catch (err) {
    console.error('Failed to delete custom category:', err);
  }
}

// ── Load & Categorize Emails ──────────────────────────────
async function loadEmails() {
  showLoading('Loading your emails…');

  try {
    const res = await fetch('/api/emails?limit=50');

    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      const detail = body.detail || body.error || `HTTP ${res.status}`;
      console.error('[app] /api/emails failed:', res.status, detail);

      if (res.status === 401) {
        showErrorState('Session expired — please sign in again.', true);
      } else if (res.status === 403) {
        showErrorState(`Gmail access denied: ${detail}\n\nMake sure the Gmail API is enabled in Google Cloud Console and the OAuth scope is approved.`);
      } else {
        showErrorState(`Failed to load emails: ${detail}`);
      }
      setSidebarStatus('Error loading emails');
      return;
    }

    state.emails = await res.json();

    if (state.emails.length === 0) {
      showEmpty();
      updateCounts();
      setSidebarStatus('Inbox is empty');
      return;
    }

    renderEmailList();
    showLoading('Categorizing with AI…');
    await categorizeEmails();
    renderEmailList();
    updateCounts();
    setSidebarStatus(`${state.emails.length} emails loaded`);
  } catch (err) {
    console.error('[app] loadEmails error:', err);
    showErrorState(`Network error: ${err.message}`);
    setSidebarStatus('Error loading emails');
  }
}

async function categorizeEmails() {
  try {
    const payload = state.emails.map(e => ({
      id: e.id, from: e.from, subject: e.subject, snippet: e.snippet,
    }));

    const customNames = state.customCategories.map(c => c.name);

    const res = await fetch('/api/ai/categorize', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ emails: payload, customCategories: customNames }),
    });

    const data = await res.json();

    if (!res.ok) {
      const detail = data.detail || data.error || `HTTP ${res.status}`;
      console.error('[app] Categorization failed:', res.status, detail);
      setSidebarStatus(`AI categorization failed: ${detail}`);
      return;
    }

    state.categories = {};
    for (const c of data) {
      state.categories[c.id] = { category: c.category, reason: c.reason };
    }
  } catch (err) {
    console.error('[app] Categorization network error:', err);
    setSidebarStatus('AI categorization unavailable');
  }
}

// ── Rendering ─────────────────────────────────────────────
function isCustomCategory(name) {
  return state.customCategories.some(c => c.name === name);
}

function customCategoryIndex(name) {
  return state.customCategories.findIndex(c => c.name === name);
}

function getFilteredEmails() {
  if (state.activeCategory === 'all') return state.emails;
  return state.emails.filter(e => {
    const cat = state.categories[e.id]?.category;
    return cat === state.activeCategory;
  });
}

function renderEmailList() {
  const filtered = getFilteredEmails();
  els.loadingState.style.display = 'none';

  if (filtered.length === 0) {
    showEmpty();
    return;
  }

  els.emptyState.style.display = 'none';
  els.emailList.style.display = 'block';
  els.emailList.innerHTML = filtered.map(e => emailItemHTML(e)).join('');

  els.emailList.querySelectorAll('.email-item').forEach(item => {
    item.addEventListener('click', () => openEmail(item.dataset.id));
  });
}

function categoryTagHTML(cat) {
  if (!cat) return '';
  const idx = customCategoryIndex(cat);
  if (idx >= 0) {
    const { bg, color } = customStyle(idx);
    return `<span class="email-category-tag" style="background:${bg};color:${color}">${escHtml(cat)}</span>`;
  }
  const label = CAT_META[cat]?.label || cat;
  return `<span class="email-category-tag tag-${cat}">${label}</span>`;
}

function emailItemHTML(email) {
  const cat = state.categories[email.id]?.category || '';
  const isActive = email.id === state.activeEmailId ? 'active' : '';
  const isUnread = email.isUnread ? 'unread' : '';
  const date = formatDate(email.date);
  const sender = extractName(email.from);

  return `
    <div class="email-item ${isActive} ${isUnread}" data-id="${email.id}">
      <div class="email-item-top">
        <span class="email-sender" title="${escHtml(email.from)}">${escHtml(sender)}</span>
        <span class="email-date">${escHtml(date)}</span>
      </div>
      <div class="email-subject">${escHtml(email.subject)}</div>
      <div class="email-snippet">${escHtml(email.snippet)}</div>
      ${categoryTagHTML(cat)}
    </div>
  `;
}

function updateCounts() {
  // Built-in counts
  const totals = {};
  for (const cat of Object.keys(CAT_META)) totals[cat] = 0;
  totals.all = state.emails.length;

  // Custom category counts
  const customTotals = {};
  for (const c of state.customCategories) customTotals[c.id] = 0;

  for (const e of state.emails) {
    const cat = state.categories[e.id]?.category;
    if (!cat) continue;

    if (totals[cat] !== undefined) {
      totals[cat]++;
    } else {
      // Could be a custom category name
      const customCat = state.customCategories.find(c => c.name === cat);
      if (customCat) customTotals[customCat.id]++;
      else totals.other++;
    }
  }

  for (const [cat, count] of Object.entries(totals)) {
    const el = document.getElementById(`count-${cat}`);
    if (el) el.textContent = count;
  }

  for (const [id, count] of Object.entries(customTotals)) {
    const el = document.getElementById(`count-custom-${id}`);
    if (el) el.textContent = count;
  }
}

function setActiveCategory(cat) {
  state.activeCategory = cat;
  state.activeEmailId = null;

  // Built-in nav
  document.querySelectorAll('#category-nav .category-item').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.category === cat);
  });

  // Custom nav
  document.querySelectorAll('#custom-category-nav .custom-cat-item').forEach(item => {
    item.classList.toggle('active', item.dataset.category === cat);
  });

  // Panel title
  const builtIn = CAT_META[cat];
  if (builtIn) {
    els.panelTitle.textContent = builtIn.label;
  } else {
    els.panelTitle.textContent = cat;
  }

  renderEmailList();
  hideDetailPanel();
}

// ── Email Detail ──────────────────────────────────────────
async function openEmail(id) {
  state.activeEmailId = id;

  document.querySelectorAll('.email-item').forEach(item => {
    item.classList.toggle('active', item.dataset.id === id);
  });

  els.detailPanel.classList.add('visible');
  els.detailPlaceholder.style.display = 'none';
  els.detailContent.style.display = 'flex';
  els.detailBody.textContent = 'Loading…';
  els.detailSubject.textContent = '';
  els.detailFrom.textContent = '';
  els.detailDate.textContent = '';
  els.detailCatBadge.innerHTML = '';

  hideAIPanels();

  try {
    let email = state.emailCache[id];
    if (!email) {
      const res = await fetch(`/api/emails/${id}`);
      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        throw new Error(errData.detail || errData.error || `HTTP ${res.status}`);
      }
      email = await res.json();
      state.emailCache[id] = email;
    }
    renderDetail(email, state.categories[id]?.category || '');
  } catch (err) {
    console.error('[app] openEmail failed:', err.message);
    // Store metadata as fallback so Draft Reply / Summarize still work
    const meta = state.emails.find(e => e.id === id);
    if (meta && !state.emailCache[id]) state.emailCache[id] = meta;
    els.detailBody.textContent = `Could not load full email body: ${err.message}`;
    // Still render what we have from metadata
    if (meta) renderDetail(meta, state.categories[id]?.category || '');
  }
}

function renderDetail(email, cat) {
  els.detailSubject.textContent = email.subject;
  els.detailFrom.textContent = `From: ${email.from}`;
  els.detailDate.textContent = formatDateFull(email.date);
  els.detailCatBadge.innerHTML = categoryTagHTML(cat);
  els.detailBody.textContent = email.body || email.snippet || '(No content)';
}

function hideDetailPanel() {
  state.activeEmailId = null;
  els.detailContent.style.display = 'none';
  els.detailPlaceholder.style.display = 'flex';
  els.detailPanel.classList.remove('visible');
  hideAIPanels();
}

function hideAIPanels() {
  els.summaryPanel.style.display = 'none';
  els.draftPanel.style.display = 'none';
  els.summaryText.textContent = '';
  els.draftText.value = '';
}

// ── AI Actions ────────────────────────────────────────────
els.btnSummarize.addEventListener('click', async () => {
  const email = getCurrentEmail();
  if (!email) {
    console.warn('[app] Summarize clicked but no email is loaded yet');
    return;
  }

  els.summaryPanel.style.display = 'block';
  els.summaryText.innerHTML = loadingDotsHTML('Summarizing');
  els.btnSummarize.disabled = true;

  try {
    const res = await fetch('/api/ai/summarize', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email }),
    });

    const data = await res.json();

    if (!res.ok) {
      const errMsg = data.detail || data.error || `Server error ${res.status}`;
      console.error('[app] summarize API error:', errMsg);
      els.summaryText.textContent = `Error: ${errMsg}`;
      return;
    }

    els.summaryText.textContent = data.summary || 'No summary returned.';
  } catch (err) {
    console.error('[app] summarize network error:', err);
    els.summaryText.textContent = `Network error: ${err.message}`;
  } finally {
    els.btnSummarize.disabled = false;
  }
});

els.btnDraft.addEventListener('click', async () => {
  const email = getCurrentEmail();
  if (!email) {
    console.warn('[app] Draft Reply clicked but no email is loaded yet');
    return;
  }

  els.draftPanel.style.display = 'block';
  els.draftText.value = '';
  els.draftText.placeholder = 'Drafting reply with Claude AI…';
  els.btnDraft.disabled = true;

  try {
    const res = await fetch('/api/ai/draft-reply', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email }),
    });

    const data = await res.json();

    if (!res.ok) {
      const errMsg = data.detail || data.error || `Server error ${res.status}`;
      console.error('[app] draft-reply API error:', errMsg);
      els.draftText.value = '';
      els.draftText.placeholder = `Error: ${errMsg}`;
      return;
    }

    if (!data.draft) {
      els.draftText.placeholder = 'AI returned an empty draft — try again.';
      return;
    }

    els.draftText.value = data.draft;
    els.draftText.placeholder = '';
  } catch (err) {
    console.error('[app] draft-reply network error:', err);
    els.draftText.value = '';
    els.draftText.placeholder = `Network error: ${err.message}`;
  } finally {
    els.btnDraft.disabled = false;
  }
});

els.btnCopyDraft.addEventListener('click', async () => {
  const text = els.draftText.value;
  if (!text) return;
  try {
    await navigator.clipboard.writeText(text);
    els.btnCopyDraft.textContent = 'Copied!';
    els.btnCopyDraft.classList.add('copied');
    setTimeout(() => {
      els.btnCopyDraft.textContent = 'Copy';
      els.btnCopyDraft.classList.remove('copied');
    }, 2000);
  } catch {
    els.btnCopyDraft.textContent = 'Copy failed';
  }
});

function getCurrentEmail() {
  if (!state.activeEmailId) return null;
  // Prefer full cached email (has body), fall back to list metadata (has snippet)
  return state.emailCache[state.activeEmailId]
    || state.emails.find(e => e.id === state.activeEmailId)
    || null;
}

// ── Add Label Form ────────────────────────────────────────
els.btnAddLabel.addEventListener('click', () => {
  els.btnAddLabel.style.display = 'none';
  els.addLabelForm.style.display = 'flex';
  els.addLabelInput.value = '';
  els.addLabelInput.focus();
});

els.btnLabelCancel.addEventListener('click', closeAddLabelForm);

els.addLabelForm.addEventListener('submit', async e => {
  e.preventDefault();
  const name = els.addLabelInput.value.trim();
  if (!name) return;

  const saveBtn = $('btn-label-save');
  saveBtn.disabled = true;
  saveBtn.textContent = '…';

  await addCustomCategory(name);

  saveBtn.disabled = false;
  saveBtn.textContent = 'Add';
  closeAddLabelForm();
});

// Close form on Escape
els.addLabelInput.addEventListener('keydown', e => {
  if (e.key === 'Escape') closeAddLabelForm();
});

function closeAddLabelForm() {
  els.addLabelForm.style.display = 'none';
  els.btnAddLabel.style.display = 'flex';
  els.addLabelInput.value = '';
}

// ── General Event Listeners ───────────────────────────────
els.categoryNav.addEventListener('click', e => {
  const btn = e.target.closest('.category-item');
  if (btn) setActiveCategory(btn.dataset.category);
});

els.detailClose.addEventListener('click', hideDetailPanel);

els.btnRefresh.addEventListener('click', async () => {
  els.btnRefresh.classList.add('spinning');
  state.emails = [];
  state.categories = {};
  state.activeEmailId = null;
  state.emailCache = {};
  hideDetailPanel();
  await loadEmails();
  els.btnRefresh.classList.remove('spinning');
});

document.querySelectorAll('.ai-close').forEach(btn => {
  btn.addEventListener('click', () => {
    const panel = $(btn.dataset.panel);
    if (panel) panel.style.display = 'none';
  });
});

// ── Helpers ───────────────────────────────────────────────
function showLoading(text) {
  els.loadingState.style.display = 'flex';
  els.loadingText.textContent = text;
  els.emptyState.style.display = 'none';
  els.emailList.style.display = 'none';
}

function showEmpty() {
  els.loadingState.style.display = 'none';
  els.emptyState.style.display = 'flex';
  els.emptyState.innerHTML = `
    <svg width="64" height="64" viewBox="0 0 64 64" fill="none">
      <rect x="8" y="16" width="48" height="36" rx="4" stroke="#CBD5E1" stroke-width="2"/>
      <path d="M8 24L32 40L56 24" stroke="#CBD5E1" stroke-width="2"/>
    </svg>
    <p>No emails in this category</p>`;
  els.emailList.style.display = 'none';
}

function showErrorState(message, showSignIn = false) {
  els.loadingState.style.display = 'none';
  els.emptyState.style.display = 'flex';
  els.emptyState.innerHTML = `
    <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="#EF4444" stroke-width="1.5">
      <circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>
    </svg>
    <p style="color:#EF4444;font-weight:600;text-align:center;padding:0 1rem;white-space:pre-wrap">${escHtml(message)}</p>
    ${showSignIn ? '<a href="/auth/login" style="color:#4F46E5;font-size:.85rem">Sign in again</a>' : ''}
    <p style="font-size:.75rem;color:#94A3B8">Check <code>server.log</code> or open DevTools → Console for details.</p>`;
  els.emailList.style.display = 'none';
}

function setSidebarStatus(text) {
  els.sidebarStatus.textContent = text;
}

function loadingDotsHTML(label) {
  return `<div class="ai-loading">
    <span>${label}</span>
    <span class="ai-loading-dot"></span>
    <span class="ai-loading-dot"></span>
    <span class="ai-loading-dot"></span>
  </div>`;
}

function escHtml(str) {
  if (!str) return '';
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function extractName(from) {
  if (!from) return 'Unknown';
  const match = from.match(/^"?([^"<]+)"?\s*</);
  if (match) return match[1].trim();
  return from.replace(/<[^>]+>/, '').trim() || from;
}

function formatDate(dateStr) {
  if (!dateStr) return '';
  try {
    const d = new Date(dateStr);
    const now = new Date();
    if (d.toDateString() === now.toDateString()) {
      return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    }
    const days = Math.floor((now - d) / 86400000);
    if (days < 7) return d.toLocaleDateString([], { weekday: 'short' });
    return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
  } catch {
    return dateStr;
  }
}

function formatDateFull(dateStr) {
  if (!dateStr) return '';
  try {
    return new Date(dateStr).toLocaleString([], {
      weekday: 'short', month: 'short', day: 'numeric',
      hour: '2-digit', minute: '2-digit',
    });
  } catch {
    return dateStr;
  }
}
