/* AskElira 3 — Frontend */

let selectedGoalId = null;
let chatHistory = [];
let previousFloorStatuses = {};
let activeWorkspaceFile = null;

// ── Boot ──
document.addEventListener('DOMContentLoaded', () => {
  fetchStatus();
  fetchGoals();
  fetchUserModel();
  loadWebChatHistory().then(function() {
    fetchTelegramMessages().then(function(tgMsgs) { renderChat(tgMsgs || []); });
  });
  bindEvents();
  startAutoRefresh();
});

// ── API helpers ──
async function api(path, opts = {}) {
  const headers = { 'Content-Type': 'application/json' };
  const token = localStorage.getItem('askelira_token');
  if (token) headers['Authorization'] = `Bearer ${token}`;

  const fetchOpts = { headers, ...opts };
  if (opts.body && typeof opts.body === 'object') {
    fetchOpts.body = JSON.stringify(opts.body);
  }
  const res = await fetch(path, fetchOpts);
  if (res.status === 401) {
    const newToken = window.prompt('AskElira API token required:');
    if (newToken) {
      localStorage.setItem('askelira_token', newToken.trim());
      return api(path, opts); // retry once with new token
    }
    throw new Error('Unauthorized');
  }
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error || res.statusText);
  }
  return res.json();
}

async function apiText(path) {
  const res = await fetch(path);
  if (!res.ok) throw new Error(res.statusText);
  return res.text();
}

// ── Toast notifications ──
function showToast(message, type) {
  type = type || 'info';
  const container = document.getElementById('toast-container');
  const toast = document.createElement('div');
  toast.className = 'toast ' + type;
  toast.textContent = message;
  container.appendChild(toast);
  setTimeout(() => { toast.remove(); }, 4000);
}

// ── Persistent web chat history ──
async function loadWebChatHistory() {
  try {
    var msgs = await api('/api/chat-messages');
    if (msgs && msgs.length) {
      chatHistory = msgs.map(function(m) { return { role: m.role, content: m.content }; });
    }
  } catch (_) {
    // Chat history not available — start fresh
  }
}

// ── Status ──
async function fetchStatus() {
  try {
    const s = await api('/api/status');
    setDot('llm-dot', s.llm);
    setDot('tg-dot', s.telegram);
    setDot('search-dot', s.webSearch !== 'None');
    document.getElementById('llm-label').textContent = s.llm ? s.llmProvider : 'LLM';
    document.getElementById('search-label').textContent = s.webSearch !== 'None' ? s.webSearch : 'Search';
  } catch (e) {
    setDot('llm-dot', false);
  }
}

function setDot(id, on) {
  var el = document.getElementById(id);
  if (el) el.classList.toggle('on', !!on);
}

// ── User Model ──
async function fetchUserModel() {
  try {
    var model = await api('/api/user-model');
    renderUserModel(model);
  } catch (err) {
    // User model not available — ignore
  }
}

function renderUserModel(model) {
  if (!model) return;

  var nameEl = document.getElementById('um-name');
  if (nameEl) nameEl.textContent = model.name || '--';

  var interestsEl = document.getElementById('um-interests');
  if (interestsEl) {
    interestsEl.innerHTML = (model.interests || []).slice(0, 8).map(function(i) {
      return '<span class="um-tag">' + esc(i) + '</span>';
    }).join('') || '<span style="font-size:11px;color:var(--text-dim)">learning...</span>';
  }

  var techEl = document.getElementById('um-tech');
  if (techEl) {
    techEl.innerHTML = (model.techStack || []).slice(0, 8).map(function(t) {
      return '<span class="um-tag tech">' + esc(t) + '</span>';
    }).join('') || '<span style="font-size:11px;color:var(--text-dim)">learning...</span>';
  }

  var goalsEl = document.getElementById('um-goals');
  if (goalsEl) {
    goalsEl.innerHTML = (model.goals || []).slice(0, 5).map(function(g) {
      return '<span class="um-tag goal">' + esc(g) + '</span>';
    }).join('') || '<span style="font-size:11px;color:var(--text-dim)">learning...</span>';
  }

  var suggestionsEl = document.getElementById('um-suggestions');
  if (suggestionsEl) {
    var suggestions = (model.suggestedNext || []).slice(0, 3);
    if (suggestions.length === 0) {
      suggestionsEl.innerHTML = '<span style="font-size:11px;color:var(--text-dim)">none yet</span>';
    } else {
      suggestionsEl.innerHTML = suggestions.map(function(s) {
        return '<div class="um-suggestion" data-suggestion="' + esc(s) + '">' + esc(s) + '</div>';
      }).join('');

      // Clicking a suggestion starts a build for it
      suggestionsEl.querySelectorAll('.um-suggestion').forEach(function(el) {
        el.addEventListener('click', function() {
          var text = el.dataset.suggestion;
          if (text) {
            document.getElementById('goal-input').value = text;
            switchTab('building');
            document.getElementById('goal-input').focus();
          }
        });
      });
    }
  }
}

// ── Goals list ──
async function fetchGoals() {
  try {
    var goals = await api('/api/goals');
    renderGoalList(goals);
    if (selectedGoalId) fetchGoalDetail(selectedGoalId);
  } catch (err) {
    console.error('Failed to fetch goals:', err);
  }
}

function renderGoalList(goals) {
  var el = document.getElementById('goal-list');
  if (!goals.length) {
    el.innerHTML = '<div class="empty" style="height:100px"><p>No goals yet</p></div>';
    return;
  }
  el.innerHTML = goals.map(function(g) {
    var floorInfo = g.floorCount > 0 ? g.floorsLive + '/' + g.floorCount : '';
    return '<div class="goal-item ' + (g.id === selectedGoalId ? 'active' : '') + '" data-id="' + g.id + '">' +
      '<span class="goal-text">' + esc(g.text) + '</span>' +
      '<div class="goal-meta">' +
        '<span class="badge ' + g.status + '">' + g.status.replace('_', ' ') + '</span>' +
        (floorInfo ? '<span class="floor-progress">' + floorInfo + ' floors</span>' : '') +
      '</div>' +
    '</div>';
  }).join('');

  el.querySelectorAll('.goal-item').forEach(function(item) {
    item.addEventListener('click', function() { selectGoal(item.dataset.id); });
  });
}

// ── Goal detail ──
function selectGoal(id) {
  selectedGoalId = id;
  fetchGoalDetail(id);
  fetchGoals();
  switchTab('building');
}

async function fetchGoalDetail(id) {
  try {
    var data = await api('/api/goals/' + id);
    renderGoalDetail(data);
    checkFloorStatusChanges(data.floors);
  } catch (err) {
    console.error('Failed to fetch goal detail:', err);
  }
}

function checkFloorStatusChanges(floors) {
  if (!floors) return;
  floors.forEach(function(f) {
    var key = f.id;
    var prev = previousFloorStatuses[key];
    if (prev && prev !== f.status) {
      if (f.status === 'live') {
        showToast('Floor "' + f.name + '" is LIVE!', 'success');
      } else if (f.status === 'blocked') {
        showToast('Floor "' + f.name + '" is BLOCKED', 'error');
      } else if (f.status === 'building') {
        showToast('David is building "' + f.name + '"', 'info');
      }
    }
    previousFloorStatuses[key] = f.status;
  });
}

function renderGoalDetail(goal) {
  var el = document.getElementById('goal-detail');
  if (!goal || !goal.floors) {
    el.innerHTML = '<div class="empty"><h3>Select a goal</h3><p>Or create a new one above</p></div>';
    return;
  }

  var floorsHtml = goal.floors.map(function(f, i) {
    var isActive = ['researching', 'building', 'auditing', 'reviewing'].indexOf(f.status) !== -1;

    // Humorous worker badge for active floors
    var workerBadgeHtml = '';
    if (isActive) {
      var workers = {
        researching: { name: 'Alba', phases: ['researching...', 'scanning...', 'ooh shiny...', 'reading...', 'googling...'] },
        building:    { name: 'David', phases: ['coding...', 'compiling...', 'bugs? surely not...', 'refactoring...', 'shipping...'] },
        auditing:    { name: 'Vex', phases: ['auditing...', 'nitpicking...', 'scoring...', 'verifying...', 'score!'] },
        reviewing:   { name: 'Elira', phases: ['reviewing...', 'judging...', 'hmm...', 'approved?', 'perfect'] },
      };
      var w = workers[f.status] || { name: 'Hermes', phases: ['thinking...', 'planning...', 'reasoning...', 'deciding...'] };
      workerBadgeHtml = '<span class="worker-badge ' + f.status + '" data-worker="' + w.name + '" data-phases="' + w.phases.join('|') + '">' +
        '<span class="worker-name">' + w.name + ' </span>' +
        '<span class="worker-phase">' + w.phases[0] + '</span>' +
        ' <span class="worker-dots"><span class="dot">.</span><span class="dot">.</span></span>' +
        '</span>';
    }

    // Agent badges based on what has run
    var agents = [];
    if (f.research) agents.push('alba');
    if (f.vex1_score !== null && f.vex1_score !== undefined) agents.push('vex');
    if (f.result) agents.push('david');
    if (f.vex2_score !== null && f.vex2_score !== undefined) agents.push('vex');
    if (f.status === 'live' || f.status === 'blocked') agents.push('elira');
    if (f.fix_patches) agents.push('steven');

    var agentBadgesHtml = agents.map(function(a) {
      return '<span class="agent-badge ' + a + '">' + a.charAt(0).toUpperCase() + a.slice(1) + '</span>';
    }).join('');

    // Vex score bars
    var vexHtml = '';
    if (f.vex1_score !== null && f.vex1_score !== undefined) {
      vexHtml += renderVexBar('Vex1', f.vex1_score);
    }
    if (f.vex2_score !== null && f.vex2_score !== undefined) {
      vexHtml += renderVexBar('Vex2', f.vex2_score);
    }

    // Fix button for blocked floors
    var fixBtnHtml = '';
    if (f.status === 'blocked') {
      fixBtnHtml = '<button class="btn btn-steven btn-small floor-fix-btn" data-floor-id="' + f.id + '">Fix with Steven</button>';
    }

    // Iteration info
    var iterHtml = f.iteration > 0 ? '<span class="floor-iter">iter ' + f.iteration + '/3</span>' : '';

    return (i > 0 ? '<div class="connector"></div>' : '') +
      '<div class="floor-card ' + f.status + '" data-floor-id="' + f.id + '">' +
        '<div class="floor-header">' +
          '<span class="floor-name">' + esc(f.name) + workerBadgeHtml + '</span>' +
          '<div class="floor-right">' +
            iterHtml +
            '<span class="badge ' + f.status + '">' + f.status + '</span>' +
            '<span class="floor-num">F' + f.floor_number + '</span>' +
          '</div>' +
        '</div>' +
        '<div class="floor-desc">' + esc(f.description || '') + '</div>' +
        '<div class="floor-agents">' + agentBadgesHtml + '</div>' +
        vexHtml +
        fixBtnHtml +
        '<div class="floor-detail" id="floor-detail-' + f.id + '">' +
          renderFloorDetailSections(f, goal) +
        '</div>' +
      '</div>';
  }).join('');

  var liveCount = goal.floors.filter(function(f) { return f.status === 'live'; }).length;
  var progressPct = goal.floors.length > 0 ? Math.round(liveCount / goal.floors.length * 100) : 0;

  el.innerHTML =
    '<div class="goal-header">' +
      '<div class="goal-header-top">' +
        '<h2>' + esc(goal.text) + '</h2>' +
        '<button class="btn-delete" id="delete-goal-btn" data-id="' + goal.id + '" title="Delete this goal">Delete</button>' +
      '</div>' +
      '<div class="meta">' +
        '<span class="badge ' + goal.status + '">' + goal.status.replace('_', ' ') + '</span>' +
        '<span>' + goal.floors.length + ' floors</span>' +
        '<span>' + progressPct + '% complete</span>' +
        '<span>' + timeAgo(goal.created_at) + '</span>' +
      '</div>' +
    '</div>' +
    '<div class="floor-list">' + floorsHtml + '</div>';

  // Bind floor card click to expand
  el.querySelectorAll('.floor-card').forEach(function(card) {
    card.addEventListener('click', function(e) {
      if (e.target.tagName === 'BUTTON') return;
      var detail = card.querySelector('.floor-detail');
      if (detail) detail.classList.toggle('open');
    });
  });

  // Bind fix buttons
  el.querySelectorAll('.floor-fix-btn').forEach(function(btn) {
    btn.addEventListener('click', function() {
      triggerFix(btn.dataset.floorId);
    });
  });

  // Bind delete button
  var deleteBtn = document.getElementById('delete-goal-btn');
  if (deleteBtn) {
    deleteBtn.addEventListener('click', function(e) {
      e.stopPropagation();
      var goalId = deleteBtn.dataset.id;
      showDeleteConfirm(goalId, goal.text);
    });
  }
}

function renderVexBar(label, score) {
  var colorClass = score >= 80 ? 'green' : score >= 60 ? 'yellow' : 'red';
  return '<div class="vex-score-bar">' +
    '<label>' + label + '</label>' +
    '<div class="vex-bar"><div class="vex-bar-fill ' + colorClass + '" style="width:' + score + '%"></div></div>' +
    '<span class="vex-score-num">' + score + '</span>' +
  '</div>';
}

function renderFloorDetailSections(floor, goal) {
  var sections = '';

  if (floor.success_condition) {
    sections += '<div class="floor-detail-section"><h4>Success Condition</h4><pre>' + esc(floor.success_condition) + '</pre></div>';
  }

  if (floor.deliverable) {
    sections += '<div class="floor-detail-section"><h4>Deliverable</h4><pre>' + esc(floor.deliverable) + '</pre></div>';
  }

  if (floor.research) {
    sections += '<div class="floor-detail-section"><h4>Research Summary</h4><pre>' + esc(floor.research.substring(0, 1000)) + '</pre></div>';
  }

  if (floor.result) {
    // Try to extract file list from result
    try {
      var parsed = JSON.parse(floor.result);
      if (parsed && parsed.files) {
        var fileNames = typeof parsed.files === 'object' && !Array.isArray(parsed.files)
          ? Object.keys(parsed.files)
          : parsed.files;
        if (fileNames.length > 0) {
          sections += '<div class="floor-detail-section"><h4>Files Created</h4><ul class="files-list">' +
            fileNames.map(function(f) {
              return '<li data-file="' + esc(f) + '">' + esc(f) + '</li>';
            }).join('') +
          '</ul></div>';
        }
      }
    } catch (e) {
      // Not JSON, show raw
    }

    sections += '<div class="floor-detail-section"><h4>Build Output</h4><pre>' + esc(floor.result.substring(0, 2000)) + '</pre></div>';
  }

  if (floor.fix_patches) {
    sections += '<div class="floor-detail-section"><h4>Steven Patches</h4><pre>' + esc(floor.fix_patches.substring(0, 1000)) + '</pre></div>';
  }

  return sections || '<p style="color:var(--text-dim);font-size:12px">No details yet</p>';
}

// ── Fix with Steven ──
async function triggerFix(floorId) {
  try {
    showToast('Steven is on it...', 'info');
    await api('/api/floors/' + floorId + '/fix', { method: 'POST', body: {} });
  } catch (err) {
    showToast('Fix failed: ' + err.message, 'error');
  }
}

// ── Delete goal ──
function showDeleteConfirm(goalId, goalText) {
  // Remove existing overlay if any
  var existing = document.getElementById('delete-overlay');
  if (existing) existing.remove();

  var overlay = document.createElement('div');
  overlay.id = 'delete-overlay';
  overlay.className = 'delete-overlay';
  overlay.innerHTML =
    '<div class="delete-modal">' +
      '<h3>Delete this goal?</h3>' +
      '<p class="delete-goal-text">"' + esc(goalText.substring(0, 80)) + '"</p>' +
      '<p class="delete-warning">This permanently removes the goal, all floors, logs, and workspace files.</p>' +
      '<div class="delete-actions">' +
        '<button class="btn-delete-cancel" id="delete-cancel">Cancel</button>' +
        '<button class="btn-delete-confirm" id="delete-confirm">Delete</button>' +
      '</div>' +
    '</div>';
  document.body.appendChild(overlay);

  document.getElementById('delete-cancel').addEventListener('click', function() {
    overlay.remove();
  });
  overlay.addEventListener('click', function(e) {
    if (e.target === overlay) overlay.remove();
  });
  document.getElementById('delete-confirm').addEventListener('click', function() {
    overlay.remove();
    performDelete(goalId);
  });
}

async function performDelete(goalId) {
  try {
    await api('/api/goals/' + goalId, { method: 'DELETE' });
    showToast('Goal deleted', 'success');
    selectedGoalId = null;
    document.getElementById('goal-detail').innerHTML =
      '<div class="empty"><h3>Goal deleted</h3><p>Select or create a new goal</p></div>';
    fetchGoals();
  } catch (err) {
    showToast('Delete failed: ' + err.message, 'error');
  }
}

// ── Workspace tab ──
async function renderWorkspace() {
  var el = document.getElementById('workspace-content');
  if (!selectedGoalId) {
    el.innerHTML = '<div class="empty"><h3>Select a goal</h3><p>to view its workspace files</p></div>';
    return;
  }

  try {
    var files = await api('/api/goals/' + selectedGoalId + '/files');
    if (!files || files.length === 0) {
      el.innerHTML = '<div class="empty"><h3>No files yet</h3><p>David has not written any code for this goal</p></div>';
      return;
    }

    // Build tree structure
    var tree = buildFileTree(files);

    el.innerHTML =
      '<div class="workspace-area">' +
        '<div class="file-tree">' +
          '<h3>Files</h3>' +
          renderFileTree(tree, '') +
        '</div>' +
        '<div class="code-viewer">' +
          '<div class="code-viewer-header">' +
            '<span id="code-filename">Select a file</span>' +
          '</div>' +
          '<div class="code-viewer-content" id="code-content"><pre>Click a file to view its contents</pre></div>' +
        '</div>' +
      '</div>';

    // Bind file click
    el.querySelectorAll('.file-tree-item').forEach(function(item) {
      item.addEventListener('click', function() {
        loadWorkspaceFile(item.dataset.path);
        el.querySelectorAll('.file-tree-item').forEach(function(i) { i.classList.remove('active'); });
        item.classList.add('active');
      });
    });
  } catch (err) {
    el.innerHTML = '<div class="empty"><p>Error loading workspace: ' + esc(err.message) + '</p></div>';
  }
}

function buildFileTree(files) {
  var tree = {};
  files.forEach(function(f) {
    var parts = f.split('/');
    var current = tree;
    parts.forEach(function(part, i) {
      if (i === parts.length - 1) {
        current[part] = f; // leaf node = full path
      } else {
        if (!current[part]) current[part] = {};
        current = current[part];
      }
    });
  });
  return tree;
}

function renderFileTree(tree, prefix) {
  var html = '';
  var entries = Object.entries(tree).sort(function(a, b) {
    var aIsDir = typeof a[1] === 'object';
    var bIsDir = typeof b[1] === 'object';
    if (aIsDir && !bIsDir) return -1;
    if (!aIsDir && bIsDir) return 1;
    return a[0].localeCompare(b[0]);
  });

  entries.forEach(function(entry) {
    var name = entry[0];
    var value = entry[1];
    if (typeof value === 'object') {
      html += '<div class="file-tree-dir">' + esc(name) + '/</div>';
      html += renderFileTree(value, prefix + name + '/');
    } else {
      html += '<div class="file-tree-item" data-path="' + esc(value) + '">' +
        (prefix ? '' : '') + esc(name) +
      '</div>';
    }
  });
  return html;
}

async function loadWorkspaceFile(filepath) {
  try {
    var content = await apiText('/api/goals/' + selectedGoalId + '/files/' + filepath);
    document.getElementById('code-filename').textContent = filepath;
    var codeEl = document.getElementById('code-content');
    codeEl.innerHTML = '<pre>' + syntaxHighlight(content, filepath) + '</pre>';
    activeWorkspaceFile = filepath;
  } catch (err) {
    document.getElementById('code-content').innerHTML = '<pre>Error loading file: ' + esc(err.message) + '</pre>';
  }
}

// ── Basic syntax highlighting ──
function syntaxHighlight(code, filename) {
  var ext = (filename || '').split('.').pop().toLowerCase();
  var escaped = esc(code);

  if (['js', 'ts', 'mjs', 'cjs'].indexOf(ext) !== -1) {
    return highlightJS(escaped);
  }
  if (ext === 'py') {
    return highlightPython(escaped);
  }
  if (ext === 'json') {
    return highlightJSON(escaped);
  }
  return escaped;
}

function highlightJS(code) {
  // Comments
  code = code.replace(/(\/\/[^\n]*)/g, '<span class="cmt">$1</span>');
  // Strings
  code = code.replace(/(&quot;[^&]*&quot;|&#x27;[^&]*&#x27;|`[^`]*`)/g, '<span class="str">$1</span>');
  // Keywords
  var kws = ['const', 'let', 'var', 'function', 'async', 'await', 'return', 'if', 'else', 'for', 'while',
    'class', 'new', 'import', 'export', 'from', 'require', 'module', 'try', 'catch', 'throw', 'switch', 'case', 'default', 'break', 'continue'];
  kws.forEach(function(kw) {
    code = code.replace(new RegExp('\\b(' + kw + ')\\b', 'g'), '<span class="kw">$1</span>');
  });
  // Numbers
  code = code.replace(/\b(\d+\.?\d*)\b/g, '<span class="num">$1</span>');
  return code;
}

function highlightPython(code) {
  code = code.replace(/(#[^\n]*)/g, '<span class="cmt">$1</span>');
  code = code.replace(/(&quot;[^&]*&quot;|&#x27;[^&]*&#x27;)/g, '<span class="str">$1</span>');
  var kws = ['def', 'class', 'import', 'from', 'return', 'if', 'elif', 'else', 'for', 'while', 'try', 'except',
    'with', 'as', 'yield', 'lambda', 'pass', 'break', 'continue', 'and', 'or', 'not', 'in', 'is', 'True', 'False', 'None'];
  kws.forEach(function(kw) {
    code = code.replace(new RegExp('\\b(' + kw + ')\\b', 'g'), '<span class="kw">$1</span>');
  });
  code = code.replace(/\b(\d+\.?\d*)\b/g, '<span class="num">$1</span>');
  return code;
}

function highlightJSON(code) {
  code = code.replace(/(&quot;[^&]*&quot;)\s*:/g, '<span class="fn">$1</span>:');
  code = code.replace(/:\s*(&quot;[^&]*&quot;)/g, ': <span class="str">$1</span>');
  code = code.replace(/\b(\d+\.?\d*)\b/g, '<span class="num">$1</span>');
  code = code.replace(/\b(true|false|null)\b/g, '<span class="kw">$1</span>');
  return code;
}

// ── Chat ──
let lastTgMsgId = 0;

async function fetchTelegramMessages() {
  try {
    var tgMsgs = await api('/api/telegram-messages?limit=100');
    if (!tgMsgs || !tgMsgs.length) return;
    lastTgMsgId = tgMsgs[tgMsgs.length - 1].id;
    return tgMsgs;
  } catch (e) {
    return [];
  }
}

function renderChat(tgMsgs) {
  var el = document.getElementById('chat-messages');

  // Build a map of Telegram message signatures to detect web duplicates
  var tgSigSet = {};
  if (tgMsgs) {
    tgMsgs.forEach(function(m) {
      tgSigSet[m.role + '|' + m.content.substring(0, 50)] = true;
    });
  }

  // Telegram messages (newer ones from polling, not yet in chatHistory)
  var tgHtml = '';
  if (tgMsgs) {
    tgMsgs.forEach(function(m) {
      var sig = m.role + '|' + m.content.substring(0, 50);
      // Skip if this exact message is already in chatHistory (mirrored from web send)
      if (chatHistory.some(function(h) { return h.role + '|' + h.content.substring(0, 50) === sig; })) return;
      var badge = '<span class="mode-tag tg">Telegram</span>';
      if (m.role === 'assistant') {
        var lower = m.content.toLowerCase();
        var modeTag = lower.indexOf('steven') !== -1 || lower.indexOf('fix') !== -1 || lower.indexOf('patch') !== -1
          ? '<span class="mode-tag steven">Steven mode</span>'
          : '<span class="mode-tag elira">Elira mode</span>';
        tgHtml += '<div class="chat-msg assistant">' + badge + modeTag + esc(m.content) + '</div>';
      } else {
        tgHtml += '<div class="chat-msg user">' + badge + esc(m.content) + '</div>';
      }
    });
  }

  // Web chat session messages
  var webHtml = chatHistory.map(function(m) {
    if (m.role === 'assistant') {
      var lower = m.content.toLowerCase();
      var modeTag = lower.indexOf('steven') !== -1 || lower.indexOf('fix') !== -1 || lower.indexOf('patch') !== -1
        ? '<span class="mode-tag steven">Steven mode</span>'
        : '<span class="mode-tag elira">Elira mode</span>';
      return '<div class="chat-msg assistant">' + modeTag + esc(m.content) + '</div>';
    }
    return '<div class="chat-msg user">' + esc(m.content) + '</div>';
  }).join('');

  el.innerHTML = tgHtml + webHtml;
  requestAnimationFrame(function() {
    el.scrollTop = el.scrollHeight;
  });
}

async function sendChat() {
  var input = document.getElementById('chat-input');
  var text = input.value.trim();
  if (!text) return;
  input.value = '';

  chatHistory.push({ role: 'user', content: text });
  renderChat([]);

  try {
    var data = await api('/api/chat', {
      method: 'POST',
      body: { messages: chatHistory, goalId: selectedGoalId || null },
    });
    chatHistory.push({ role: 'assistant', content: data.reply });
  } catch (e) {
    chatHistory.push({ role: 'assistant', content: 'Error: ' + e.message });
  }
  renderChat([]);
}

// ── Logs ──
async function fetchLogs() {
  try {
    var opts = selectedGoalId ? '?goalId=' + selectedGoalId : '';
    var logs = await api('/api/logs' + opts);
    renderLogs(logs.slice(0, 20));
  } catch (err) {
    console.error('Failed to fetch logs:', err);
  }
}

function renderLogs(logs) {
  var el = document.getElementById('log-list');
  if (!logs || !logs.length) {
    el.innerHTML = '<div style="color:var(--text-dim);font-size:11px">No logs yet</div>';
    return;
  }
  // Reverse to show newest at bottom
  el.innerHTML = logs.reverse().map(function(l) {
    return '<div class="log-entry">' +
      '<span class="log-time">' + timeAgo(l.created_at) + '</span>' +
      '<span class="log-agent ' + l.agent + '">' + l.agent + '</span>' +
      '<span class="log-msg">' + esc(l.message) + '</span>' +
    '</div>';
  }).join('');
  el.scrollTop = el.scrollHeight;
}

// ── Build ──
async function createGoal() {
  var input = document.getElementById('goal-input');
  var text = input.value.trim();
  if (!text) return;

  var btn = document.getElementById('build-btn');
  btn.disabled = true;
  btn.textContent = 'Building...';
  input.value = '';

  try {
    var goal = await api('/api/goals', {
      method: 'POST',
      body: { text: text },
    });
    selectedGoalId = goal.id;
    showToast('Goal created! Pipeline starting...', 'success');
    fetchGoals();
  } catch (err) {
    showToast('Failed: ' + err.message, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Build';
  }
}

// ── Tabs ──
function switchTab(name) {
  document.querySelectorAll('.tab').forEach(function(t) {
    t.classList.toggle('active', t.dataset.tab === name);
  });
  document.querySelectorAll('.tab-content').forEach(function(tc) {
    tc.style.display = 'none';
  });
  var target = document.getElementById('tab-' + name);
  if (target) target.style.display = '';

  if (name === 'workspace') renderWorkspace();
}

// ── Events ──
function bindEvents() {
  document.getElementById('build-btn').addEventListener('click', createGoal);
  document.getElementById('goal-input').addEventListener('keydown', function(e) {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); createGoal(); }
  });
  document.getElementById('chat-send').addEventListener('click', sendChat);
  document.getElementById('chat-input').addEventListener('keydown', function(e) {
    if (e.key === 'Enter') sendChat();
  });
  document.querySelectorAll('.tab').forEach(function(t) {
    t.addEventListener('click', function() { switchTab(t.dataset.tab); });
  });
  document.getElementById('new-goal-btn').addEventListener('click', function() {
    switchTab('building');
    document.getElementById('goal-input').focus();
  });
}

// ── Auto refresh ──
function startAutoRefresh() {
  // Goals + detail every 5 seconds, user model every 30 seconds
  setInterval(function() {
    fetchGoals();
  }, 5000);

  setInterval(function() {
    fetchUserModel();
  }, 30000);

  // Logs every 3 seconds when active
  setInterval(function() {
    if (selectedGoalId) fetchLogs();
  }, 3000);

  // Telegram messages every 4 seconds
  setInterval(function() {
    fetchTelegramMessages().then(function(tgMsgs) {
      if (tgMsgs) renderChat(tgMsgs);
    });
  }, 4000);
}

// ── Utilities ──
function esc(str) {
  if (!str) return '';
  var d = document.createElement('div');
  d.textContent = str;
  return d.innerHTML;
}

function timeAgo(epoch) {
  if (!epoch) return '';
  var now = Math.floor(Date.now() / 1000);
  var diff = now - epoch;
  if (diff < 0) return 'just now';
  if (diff < 60) return diff + 's ago';
  if (diff < 3600) return Math.floor(diff / 60) + 'm ago';
  if (diff < 86400) return Math.floor(diff / 3600) + 'h ago';
  return Math.floor(diff / 86400) + 'd ago';
}
