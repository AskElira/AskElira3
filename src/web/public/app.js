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
  fetchOverview();
  loadWebChatHistory().then(function() {
    fetchTelegramMessages().then(function(tgMsgs) { renderChat(tgMsgs || []); });
  });
  bindEvents();
  startAutoRefresh();
  showTutorialIfFirstVisit();
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
  var container = document.getElementById('toast-container');
  var toast = document.createElement('div');
  toast.className = 'toast ' + type;
  toast.textContent = message;
  container.appendChild(toast);
  setTimeout(function() {
    toast.classList.add('toast-exit');
    toast.addEventListener('animationend', function() { toast.remove(); });
    // Fallback removal in case animationend doesn't fire
    setTimeout(function() { if (toast.parentNode) toast.remove(); }, 500);
  }, 3500);
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
    var pct = g.floorCount > 0 ? Math.round(g.floorsLive / g.floorCount * 100) : 0;
    var barColor = 'green';
    if (g.floorsBlocked > 0) barColor = 'red';
    else if (g.status === 'building' && pct < 100) barColor = 'amber';

    var progressBar = g.floorCount > 0
      ? '<div class="goal-progress-bar"><div class="goal-progress-fill ' + barColor + '" style="width:' + pct + '%"></div></div>'
      : '';

    return '<div class="goal-item ' + (g.id === selectedGoalId ? 'active' : '') + '" data-id="' + g.id + '">' +
      '<span class="goal-text">' + esc(g.text) + '</span>' +
      '<div class="goal-meta">' +
        '<span class="badge ' + g.status + '">' + g.status.replace('_', ' ') + '</span>' +
        (floorInfo ? '<span class="floor-progress">' + floorInfo + ' floors</span>' : '') +
      '</div>' +
      progressBar +
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
  // Close mobile sidebar
  closeMobileSidebar();
}

var cachedMetrics = null;

async function fetchGoalDetail(id) {
  try {
    var results = await Promise.all([
      api('/api/goals/' + id),
      api('/api/stats/metrics').catch(function() { return null; })
    ]);
    var data = results[0];
    cachedMetrics = results[1];
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

    // Floor timeline (only show for floors that have some progress)
    var timelineHtml = '';
    if (f.status !== 'pending' && cachedMetrics) {
      timelineHtml = renderFloorTimeline(f, cachedMetrics);
    }

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
        timelineHtml +
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

  var allHtml = tgHtml + webHtml;

  // Show welcome state if no messages
  if (!allHtml.trim()) {
    el.innerHTML =
      '<div class="chat-welcome">' +
        '<div class="chat-avatar-large">E</div>' +
        '<h3>Hey, I\'m Elira</h3>' +
        '<p>Your AI build team. Ask me anything or tell me what to build.</p>' +
        '<div class="chat-quick-actions">' +
          '<button class="chat-quick-action" data-text="Build a REST API for a todo app">Build something new</button>' +
          '<button class="chat-quick-action" data-text="fix">Fix blocked floors</button>' +
          '<button class="chat-quick-action" data-text="continue">Continue building</button>' +
          '<button class="chat-quick-action" data-text="status">Show build status</button>' +
        '</div>' +
      '</div>';
    // Bind quick actions
    el.querySelectorAll('.chat-quick-action').forEach(function(btn) {
      btn.addEventListener('click', function() {
        document.getElementById('chat-input').value = btn.dataset.text;
        sendChat();
      });
    });
    return;
  }

  el.innerHTML = allHtml;
  requestAnimationFrame(function() {
    el.scrollTop = el.scrollHeight;
  });
}

async function sendChat() {
  var input = document.getElementById('chat-input');
  var text = input.value.trim();
  if (!text) return;
  input.value = '';
  input.style.height = 'auto';

  var lower = text.toLowerCase();

  // ── Action: Build ──
  var buildMatch = text.match(/^(build|create|make|start)\s+(.{3,})/i);
  if (buildMatch) {
    chatHistory.push({ role: 'user', content: text });
    renderChat([]);
    try {
      var goal = await api('/api/goals', { method: 'POST', body: { text: buildMatch[2].trim() } });
      selectedGoalId = goal.id;
      chatHistory.push({ role: 'assistant', content: 'Building: "' + buildMatch[2].trim() + '"\n\nPipeline started. Switch to the Building tab to watch progress.' });
      showToast('Goal created! Pipeline starting...', 'success');
      fetchGoals();
      switchTab('building');
    } catch (err) {
      chatHistory.push({ role: 'assistant', content: 'Build failed: ' + err.message });
    }
    renderChat([]);
    return;
  }

  // ── Action: Fix with Steven ──
  if (/\bfix\b|fix.*steven|steven.*fix|repair|unblock/i.test(lower)) {
    chatHistory.push({ role: 'user', content: text });
    renderChat([]);
    var fixGoalId = selectedGoalId;
    if (!fixGoalId) {
      // Try to find a goal with blocked floors
      try {
        var allGoals = await api('/api/goals');
        var goalWithBlocked = allGoals.find(function(g) { return g.floorsBlocked > 0; });
        if (goalWithBlocked) fixGoalId = goalWithBlocked.id;
      } catch (_) {}
    }
    if (fixGoalId) {
      try {
        var fixResult = await api('/api/goals/' + fixGoalId + '/fix', { method: 'POST', body: {} });
        chatHistory.push({ role: 'assistant', content: 'Steven is on it — fixing "' + (fixResult.floorName || 'blocked floor') + '".\n\nWatch the Building tab for progress.' });
        showToast('Steven fixing: ' + (fixResult.floorName || 'blocked floor'), 'info');
        fetchGoals();
      } catch (err) {
        chatHistory.push({ role: 'assistant', content: 'Fix failed: ' + err.message + '\n\nThere might not be any blocked floors right now.' });
      }
    } else {
      chatHistory.push({ role: 'assistant', content: 'No blocked floors found. Everything looks okay!' });
    }
    renderChat([]);
    return;
  }

  // ── Action: Continue / Resume build ──
  if (/^(continue|resume|keep building|retry|try again|run again)/i.test(lower)) {
    chatHistory.push({ role: 'user', content: text });
    renderChat([]);
    var resumeGoalId = selectedGoalId;
    if (!resumeGoalId) {
      try {
        var goals = await api('/api/goals');
        var incomplete = goals.find(function(g) { return g.status !== 'goal_met' && g.status !== 'completed'; });
        if (incomplete) resumeGoalId = incomplete.id;
      } catch (_) {}
    }
    if (resumeGoalId) {
      try {
        var runResult = await api('/api/goals/' + resumeGoalId + '/run', { method: 'POST', body: {} });
        selectedGoalId = resumeGoalId;
        chatHistory.push({ role: 'assistant', content: 'Resuming pipeline for this goal. ' + (runResult.floors || 0) + ' floors queued.\n\nSwitch to the Building tab to watch.' });
        showToast('Pipeline resumed', 'success');
        fetchGoals();
        switchTab('building');
      } catch (err) {
        chatHistory.push({ role: 'assistant', content: 'Resume failed: ' + err.message });
      }
    } else {
      chatHistory.push({ role: 'assistant', content: 'No incomplete goals to resume. Tell me what to build!' });
    }
    renderChat([]);
    return;
  }

  // ── Action: Status ──
  if (/^(status|what.s running|show.*goals|my builds)/i.test(lower)) {
    chatHistory.push({ role: 'user', content: text });
    renderChat([]);
    try {
      var statusGoals = await api('/api/goals');
      if (!statusGoals.length) {
        chatHistory.push({ role: 'assistant', content: 'No goals yet. Tell me what to build!' });
      } else {
        var lines = statusGoals.slice(0, 5).map(function(g) {
          var icon = g.status === 'goal_met' ? '✅' : g.status === 'blocked' ? '🔴' : g.status === 'building' ? '🔨' : '⏳';
          return icon + ' ' + g.text.substring(0, 50) + '\n   ' + g.floorsLive + '/' + g.floorCount + ' live' + (g.floorsBlocked ? ', ' + g.floorsBlocked + ' blocked' : '');
        });
        chatHistory.push({ role: 'assistant', content: 'Goals:\n\n' + lines.join('\n\n') });
      }
    } catch (err) {
      chatHistory.push({ role: 'assistant', content: 'Error fetching status: ' + err.message });
    }
    renderChat([]);
    return;
  }

  // ── Action: Delete ──
  if (/^(delete|remove|trash|nuke)\s/i.test(lower) && selectedGoalId) {
    chatHistory.push({ role: 'user', content: text });
    renderChat([]);
    try {
      var delGoal = await api('/api/goals/' + selectedGoalId, { method: 'DELETE' });
      chatHistory.push({ role: 'assistant', content: 'Deleted "' + (delGoal.text || 'goal').substring(0, 50) + '" — removed goal, floors, logs, and workspace.' });
      selectedGoalId = null;
      fetchGoals();
      switchTab('overview');
    } catch (err) {
      chatHistory.push({ role: 'assistant', content: 'Delete failed: ' + err.message });
    }
    renderChat([]);
    return;
  }

  // ── Default: Chat with Hermes ──
  chatHistory.push({ role: 'user', content: text });
  renderChat([]);

  try {
    var data = await api('/api/chat', {
      method: 'POST',
      body: { messages: chatHistory, goalId: selectedGoalId || null },
    });
    chatHistory.push({ role: 'assistant', content: data.reply });
    // Show badge if chat is minimized
    var cw = document.getElementById('chat-window');
    if (cw && !cw.classList.contains('open')) {
      var badge = document.getElementById('chat-badge');
      if (badge) badge.style.display = '';
    }
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
  document.querySelectorAll('.header-tab').forEach(function(t) {
    t.classList.toggle('active', t.dataset.tab === name);
  });
  document.querySelectorAll('.tab-content').forEach(function(tc) {
    tc.style.display = 'none';
  });
  var target = document.getElementById('tab-' + name);
  if (target) target.style.display = '';

  if (name === 'workspace') renderWorkspace();
  if (name === 'overview') fetchOverview();
}

// ── Events ──
function bindEvents() {
  // Chat widget toggle
  var chatBubble = document.getElementById('chat-bubble');
  var chatWindow = document.getElementById('chat-window');
  var chatMinimize = document.getElementById('chat-minimize');

  if (chatBubble) {
    chatBubble.addEventListener('click', function() {
      chatWindow.classList.add('open');
      chatBubble.style.display = 'none';
      document.getElementById('chat-badge').style.display = 'none';
      document.getElementById('chat-input').focus();
    });
  }

  if (chatMinimize) {
    chatMinimize.addEventListener('click', function() {
      chatWindow.classList.remove('open');
      chatBubble.style.display = 'flex';
    });
  }

  document.getElementById('chat-send').addEventListener('click', sendChat);
  var chatInput = document.getElementById('chat-input');
  chatInput.addEventListener('keydown', function(e) {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendChat(); }
  });
  // Auto-resize textarea
  chatInput.addEventListener('input', function() {
    this.style.height = 'auto';
    this.style.height = Math.min(this.scrollHeight, 80) + 'px';
  });
  document.querySelectorAll('.header-tab').forEach(function(t) {
    t.addEventListener('click', function() { switchTab(t.dataset.tab); });
  });
  document.getElementById('new-goal-btn').addEventListener('click', function() {
    closeMobileSidebar();
    // Open chat widget and focus input
    var cw = document.getElementById('chat-window');
    var cb = document.getElementById('chat-bubble');
    if (cw && !cw.classList.contains('open')) {
      cw.classList.add('open');
      if (cb) cb.style.display = 'none';
    }
    var ci = document.getElementById('chat-input');
    ci.placeholder = 'Tell me what to build...';
    ci.focus();
  });

  // Hamburger menu
  var hamburger = document.getElementById('hamburger-btn');
  var sidebar = document.getElementById('sidebar');
  var overlay = document.getElementById('sidebar-overlay');

  if (hamburger) {
    hamburger.addEventListener('click', function() {
      var isOpen = sidebar.classList.toggle('open');
      hamburger.classList.toggle('open', isOpen);
      overlay.classList.toggle('open', isOpen);
    });
  }

  if (overlay) {
    overlay.addEventListener('click', closeMobileSidebar);
  }
}

function closeMobileSidebar() {
  var sidebar = document.getElementById('sidebar');
  var hamburger = document.getElementById('hamburger-btn');
  var overlay = document.getElementById('sidebar-overlay');
  if (sidebar) sidebar.classList.remove('open');
  if (hamburger) hamburger.classList.remove('open');
  if (overlay) overlay.classList.remove('open');
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

  // Overview every 10 seconds when active
  setInterval(function() {
    var overviewTab = document.getElementById('tab-overview');
    if (overviewTab && overviewTab.style.display !== 'none') {
      fetchOverview();
    }
  }, 10000);

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

// ── Overview Dashboard ──
async function fetchOverview() {
  try {
    var results = await Promise.all([
      api('/api/status'),
      api('/api/logs'),
      api('/api/stats/metrics').catch(function() { return { byAgent: [], floorStats: {}, recentFailures: [] }; }),
      api('/api/stats/circuits').catch(function() { return []; })
    ]);
    renderOverview(results[0], results[1], results[2], results[3]);
  } catch (err) {
    console.error('Overview fetch error:', err);
  }
}

function renderOverview(status, logs, metrics, circuits) {
  var el = document.getElementById('overview-content');
  if (!el) return;

  // Stat cards
  var budgetPct = status.llmBudgetPct || 0;
  var budgetColor = budgetPct > 20 ? 'green' : budgetPct > 5 ? 'accent' : 'red';
  var uptimeStr = formatUptime(status.uptime || 0);

  var statsHtml =
    '<div class="overview-grid">' +
      statCard('Goals', status.goalCount || 0, 'accent', '') +
      statCard('Floors Live', status.floorsLive || 0, 'green', 'of ' + (status.floorCount || 0) + ' total') +
      statCard('Blocked', status.floorsBlocked || 0, status.floorsBlocked > 0 ? 'red' : 'green', status.floorsActive > 0 ? status.floorsActive + ' active now' : 'none active') +
      statCard('LLM Budget', budgetPct + '%', budgetColor, status.llmTotalCalls + ' calls') +
      statCard('Uptime', uptimeStr, 'blue', 'v' + (status.version || '3.0.0')) +
    '</div>';

  // Health indicators
  var healthHtml =
    '<div class="overview-section">' +
      '<h3><span class="section-dot green"></span>System Health</h3>' +
      '<div class="health-row">' +
        healthChip('LLM', status.llm ? 'on' : 'off', status.llmProvider || 'None') +
        healthChip('Telegram', status.telegram ? 'on' : 'off', status.telegram ? 'Connected' : 'Off') +
        healthChip('Search', status.webSearch !== 'None' ? 'on' : 'off', status.webSearch || 'None') +
        healthChip('Budget', budgetPct > 5 ? 'on' : budgetPct > 0 ? 'warn' : 'off', budgetPct + '% left') +
      '</div>';

  // Circuit breakers
  if (circuits && Object.keys(circuits).length > 0) {
    healthHtml += '<div class="circuit-row">';
    var circuitKeys = Array.isArray(circuits) ? [] : Object.keys(circuits);
    circuitKeys.forEach(function(name) {
      var breaker = circuits[name];
      var state = breaker.state || 'closed';
      healthHtml += '<span class="circuit-chip ' + state + '">' + esc(name) + ': ' + state + '</span>';
    });
    healthHtml += '</div>';
  }
  healthHtml += '</div>';

  // Activity feed
  var recentLogs = (logs || []).slice(0, 12);
  var activityHtml =
    '<div class="overview-section">' +
      '<h3><span class="section-dot amber"></span>Recent Activity</h3>';

  if (recentLogs.length === 0) {
    activityHtml += '<p style="color:var(--text-dim);font-size:12px">No activity yet. Create a goal to get started.</p>';
  } else {
    activityHtml += '<div class="activity-feed">';
    recentLogs.forEach(function(l) {
      activityHtml +=
        '<div class="activity-item">' +
          '<span class="act-time">' + timeAgo(l.created_at) + '</span>' +
          '<span class="act-agent ' + l.agent + '">' + esc(l.agent) + '</span>' +
          '<span class="act-msg">' + esc(l.message) + '</span>' +
        '</div>';
    });
    activityHtml += '</div>';
  }
  activityHtml += '</div>';

  // Agent performance
  var byAgent = (metrics && metrics.byAgent) || [];
  var perfHtml = '';
  if (byAgent.length > 0) {
    perfHtml =
      '<div class="overview-section">' +
        '<h3><span class="section-dot green"></span>Agent Performance</h3>' +
        '<table class="agent-perf-table">' +
          '<thead><tr>' +
            '<th>Agent</th><th>Event</th><th>Total</th><th>Success</th><th>Rate</th><th>Avg Time</th>' +
          '</tr></thead>' +
          '<tbody>';
    byAgent.forEach(function(row) {
      var rate = row.total > 0 ? Math.round(row.successes / row.total * 100) : 0;
      var rateClass = rate >= 80 ? 'high' : rate >= 50 ? 'mid' : 'low';
      var avgTime = row.avg_duration_ms ? formatDuration(row.avg_duration_ms) : '--';
      perfHtml +=
        '<tr>' +
          '<td><span class="agent-badge ' + (row.agent || '').toLowerCase() + '">' + esc(row.agent) + '</span></td>' +
          '<td>' + esc(row.event) + '</td>' +
          '<td>' + row.total + '</td>' +
          '<td>' + row.successes + '</td>' +
          '<td><span class="success-rate ' + rateClass + '">' + rate + '%</span></td>' +
          '<td style="font-family:var(--mono);font-size:11px;color:var(--text-dim)">' + avgTime + '</td>' +
        '</tr>';
    });
    perfHtml += '</tbody></table></div>';
  }

  // Floor stats summary
  var floorStats = (metrics && metrics.floorStats) || {};
  var floorStatsHtml = '';
  if (floorStats.total_floors > 0) {
    var liveRate = floorStats.total_floors > 0 ? Math.round(floorStats.live_floors / floorStats.total_floors * 100) : 0;
    floorStatsHtml =
      '<div class="overview-section">' +
        '<h3><span class="section-dot ' + (liveRate >= 70 ? 'green' : 'amber') + '"></span>Floor Completion</h3>' +
        '<div class="overview-grid" style="grid-template-columns:repeat(3,1fr)">' +
          statCard('Completed', floorStats.live_floors || 0, 'green', 'of ' + floorStats.total_floors + ' tracked') +
          statCard('Success Rate', liveRate + '%', liveRate >= 70 ? 'green' : 'accent', '') +
          statCard('Avg Time', formatDuration(floorStats.avg_floor_ms || 0), 'blue', formatDuration(floorStats.min_floor_ms || 0) + ' - ' + formatDuration(floorStats.max_floor_ms || 0)) +
        '</div>' +
      '</div>';
  }

  el.innerHTML = statsHtml + healthHtml + floorStatsHtml + activityHtml + perfHtml;
}

function statCard(label, value, colorClass, sub) {
  return '<div class="stat-card">' +
    '<span class="stat-label">' + esc(label) + '</span>' +
    '<span class="stat-value ' + colorClass + '">' + esc(String(value)) + '</span>' +
    (sub ? '<span class="stat-sub">' + esc(sub) + '</span>' : '') +
  '</div>';
}

function healthChip(label, state, detail) {
  return '<div class="health-chip">' +
    '<span class="h-dot ' + state + '"></span>' +
    '<span>' + esc(label) + ': ' + esc(detail) + '</span>' +
  '</div>';
}

function formatUptime(seconds) {
  if (seconds < 60) return seconds + 's';
  if (seconds < 3600) return Math.floor(seconds / 60) + 'm';
  if (seconds < 86400) return Math.floor(seconds / 3600) + 'h ' + Math.floor((seconds % 3600) / 60) + 'm';
  return Math.floor(seconds / 86400) + 'd ' + Math.floor((seconds % 86400) / 3600) + 'h';
}

function formatDuration(ms) {
  if (!ms || ms === 0) return '--';
  if (ms < 1000) return Math.round(ms) + 'ms';
  if (ms < 60000) return (ms / 1000).toFixed(1) + 's';
  return (ms / 60000).toFixed(1) + 'm';
}

// ── Floor Timeline ──
function renderFloorTimeline(floor, metrics) {
  if (!metrics || !metrics.byAgent || metrics.byAgent.length === 0) return '';

  // Gather per-agent timing for this floor from metrics
  var agents = [
    { key: 'Alba', cls: 'alba', label: 'Alba' },
    { key: 'Vex', cls: 'vex', label: 'Vex1' },
    { key: 'David', cls: 'david', label: 'David' },
    { key: 'Vex', cls: 'vex', label: 'Vex2' },
    { key: 'Elira', cls: 'elira', label: 'Elira' }
  ];

  // Find the max duration for scaling
  var maxMs = 1;
  var agentTimes = [];
  agents.forEach(function(a) {
    var match = metrics.byAgent.find(function(m) { return m.agent === a.key; });
    var ms = match ? (match.avg_duration_ms || 0) : 0;
    if (ms > maxMs) maxMs = ms;
    agentTimes.push({ label: a.label, cls: a.cls, ms: ms });
  });

  var barsHtml = agentTimes.map(function(t) {
    var pct = maxMs > 0 ? Math.round(t.ms / maxMs * 100) : 0;
    if (pct < 2 && t.ms > 0) pct = 2; // minimum visible width
    return '<div class="timeline-bar-row">' +
      '<span class="timeline-bar-label">' + t.label + '</span>' +
      '<div class="timeline-bar-track">' +
        '<div class="timeline-bar-fill ' + t.cls + '" style="width:' + pct + '%"></div>' +
      '</div>' +
      '<span class="timeline-bar-time">' + formatDuration(t.ms) + '</span>' +
    '</div>';
  }).join('');

  return '<div class="floor-timeline">' +
    '<h4>Agent Timeline (avg)</h4>' +
    '<div class="timeline-bars">' + barsHtml + '</div>' +
  '</div>';
}

// ── Tutorial ──
function showTutorialIfFirstVisit() {
  if (localStorage.getItem('askelira_tutorial_done')) return;
  var overlay = document.getElementById('tutorial-overlay');
  if (!overlay) return;
  overlay.style.display = '';

  // Dismiss button
  document.getElementById('tutorial-dismiss').addEventListener('click', function() {
    dismissTutorial();
  });

  // Click backdrop to dismiss
  overlay.addEventListener('click', function(e) {
    if (e.target === overlay) dismissTutorial();
  });

  // Example buttons fill the chat input and dismiss
  overlay.querySelectorAll('.tutorial-example').forEach(function(btn) {
    btn.addEventListener('click', function() {
      var text = btn.dataset.text;
      document.getElementById('chat-input').value = text;
      dismissTutorial();
      document.getElementById('chat-input').focus();
    });
  });
}

function dismissTutorial() {
  var overlay = document.getElementById('tutorial-overlay');
  if (overlay) overlay.style.display = 'none';
  localStorage.setItem('askelira_tutorial_done', '1');
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
