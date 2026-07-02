// Popup Logic for WeChat Download Extension

// DOM elements
const statusBadge = document.getElementById('queue-status');
const selectFormat = document.getElementById('setting-format');
const inputMinDelay = document.getElementById('setting-min-delay');
const inputMaxDelay = document.getElementById('setting-max-delay');
const btnToggleQueue = document.getElementById('btn-toggle-queue');
const btnToggleText = document.getElementById('btn-toggle-text');
const btnClearQueue = document.getElementById('btn-clear-queue');
const progressCard = document.getElementById('progress-overview-container');
const currentTaskTitle = document.getElementById('current-task-title');
const currentTaskPercent = document.getElementById('current-task-percent');
const currentTaskBar = document.getElementById('current-task-bar');
const taskCountSpan = document.getElementById('task-count');
const taskListDiv = document.getElementById('task-list');
const tasksEmptyDiv = document.getElementById('tasks-empty');
const logConsole = document.getElementById('log-console');
const tabButtons = document.querySelectorAll('.tab-btn');
const tabPanels = document.querySelectorAll('.tab-panel');

let localState = {
  downloadQueue: [],
  activeIndex: -1,
  status: 'idle',
  settings: {},
  logHistory: []
};

// Initialize
document.addEventListener('DOMContentLoaded', () => {
  // 1. Initial State Load
  refreshState();
  
  // 2. Event Listeners
  btnToggleQueue.addEventListener('click', handleToggleQueue);
  btnClearQueue.addEventListener('click', handleClearQueue);
  
  // Settings changes listener
  [selectFormat, inputMinDelay, inputMaxDelay].forEach(el => {
    el.addEventListener('change', updateSettings);
  });
  
  // Tab toggling
  tabButtons.forEach(btn => {
    btn.addEventListener('click', () => {
      tabButtons.forEach(b => b.classList.remove('active'));
      tabPanels.forEach(p => p.classList.remove('active'));
      
      btn.classList.add('active');
      const tabId = btn.getAttribute('data-tab');
      document.getElementById(tabId).classList.add('active');
      
      if (tabId === 'tab-logs') {
        scrollToBottom(logConsole);
      }
    });
  });
  
  // 3. Listen for runtime messages from background
  chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === 'log_update') {
      appendLog(request.log);
    } 
    else if (request.action === 'progress_update') {
      updateActiveProgress(request.index, request.progress);
    }
    
    // Periodically refresh full state for list rendering consistency
    refreshState();
  });
  
  // Auto-refresh state every 1.5 seconds
  setInterval(refreshState, 1500);
});

// Fetch state from background worker
function refreshState() {
  chrome.runtime.sendMessage({ action: 'get_state' }, (state) => {
    if (!state) return;
    
    // Store locally
    const isFirstLoad = Object.keys(localState.settings).length === 0;
    localState = state;
    
    // 1. Load settings to UI on first load
    if (isFirstLoad && state.settings) {
      selectFormat.value = state.settings.format || 'zip_html';
      inputMinDelay.value = state.settings.minDelay || 3;
      inputMaxDelay.value = state.settings.maxDelay || 8;
    }
    
    // 2. Render UI components
    renderStatusBadge();
    renderQueueControls();
    renderProgressCard();
    renderTaskList();
    renderLogs();
  });
}

// Render status badge
function renderStatusBadge() {
  statusBadge.className = 'status-badge';
  let text = '闲置';
  
  if (localState.status === 'running') {
    statusBadge.classList.add('running');
    text = '下载中';
  } else if (localState.status === 'paused') {
    statusBadge.classList.add('paused');
    text = '已暂停';
  } else if (localState.status === 'completed') {
    statusBadge.classList.add('completed');
    text = '已完成';
  }
  
  statusBadge.textContent = text;
}

// Render play/pause button state
function renderQueueControls() {
  const playIconPath = 'M8 5v14l11-7z';
  const pauseIconPath = 'M6 19h4V5H6v14zm8-14v14h4V5h-4z';
  const playIcon = document.getElementById('play-icon');
  
  if (localState.status === 'running') {
    btnToggleText.textContent = '暂停下载';
    if (playIcon) playIcon.querySelector('path').setAttribute('d', pauseIconPath);
  } else {
    btnToggleText.textContent = '开始下载';
    if (playIcon) playIcon.querySelector('path').setAttribute('d', playIconPath);
  }
  
  // Disable toggle if queue is empty
  const pendingCount = localState.downloadQueue.filter(t => t.status === 'pending').length;
  const isRunning = localState.status === 'running';
  btnToggleQueue.disabled = pendingCount === 0 && !isRunning;
}

// Render current active progress card
function renderProgressCard() {
  const isRunning = localState.status === 'running';
  const activeTask = localState.downloadQueue[localState.activeIndex];
  
  if (isRunning && activeTask) {
    progressCard.style.display = 'block';
    currentTaskTitle.textContent = activeTask.title;
    currentTaskPercent.textContent = `${activeTask.progress}%`;
    currentTaskBar.style.width = `${activeTask.progress}%`;
  } else {
    progressCard.style.display = 'none';
  }
}

// Update settings in Background
function updateSettings() {
  const format = selectFormat.value;
  const minDelay = parseInt(inputMinDelay.value) || 3;
  const maxDelay = parseInt(inputMaxDelay.value) || 8;
  
  const settings = { format, minDelay, maxDelay };
  chrome.runtime.sendMessage({ action: 'update_settings', settings });
}

// Handle play/pause toggle
function handleToggleQueue() {
  const action = localState.status === 'running' ? 'pause_queue' : 'start_queue';
  chrome.runtime.sendMessage({ action }, (res) => {
    if (res && res.success) {
      refreshState();
    }
  });
}

// Handle clear queue
function handleClearQueue() {
  if (confirm('确认清空所有任务队列和日志吗？')) {
    chrome.runtime.sendMessage({ action: 'clear_queue' }, (res) => {
      if (res && res.success) {
        refreshState();
      }
    });
  }
}

// Updates only active progress percentage for efficiency
function updateActiveProgress(index, progress) {
  if (index === localState.activeIndex) {
    currentTaskPercent.textContent = `${progress}%`;
    currentTaskBar.style.width = `${progress}%`;
  }
}

// Render the task list scroll container
function renderTaskList() {
  const queue = localState.downloadQueue;
  taskCountSpan.textContent = queue.length;
  
  if (queue.length === 0) {
    tasksEmptyDiv.style.display = 'flex';
    taskListDiv.style.display = 'none';
    return;
  }
  
  tasksEmptyDiv.style.display = 'none';
  taskListDiv.style.display = 'flex';
  
  // Diff render or simply redraw (since list is small, up to 100-200 items, simple rebuild is fast enough)
  taskListDiv.innerHTML = '';
  
  queue.forEach((task, idx) => {
    const item = document.createElement('div');
    item.className = 'task-item';
    
    // Status text translation
    let statusText = '等待中';
    if (task.status === 'downloading') statusText = `下载 ${task.progress}%`;
    else if (task.status === 'completed') statusText = '完成';
    else if (task.status === 'failed') statusText = '失败';
    
    item.innerHTML = `
      <div class="task-item-info">
        <div class="task-item-title" title="${task.title}">${task.title}</div>
        <div class="task-item-meta">
          <span>${task.accountName}</span> • <span>${task.date || '无日期'}</span>
        </div>
      </div>
      <span class="task-item-status ${task.status}">${statusText}</span>
    `;
    
    taskListDiv.appendChild(item);
  });
}

// Render log history
function renderLogs() {
  // Redraw log panel if length changed
  const currentLogCount = logConsole.querySelectorAll('.log-entry').length;
  if (currentLogCount === localState.logHistory.length) return;
  
  logConsole.innerHTML = '';
  localState.logHistory.forEach(logEntry => {
    appendLogDOM(logEntry);
  });
  
  scrollToBottom(logConsole);
}

// Append a single log entry (used in live messaging)
function appendLog(logEntry) {
  appendLogDOM(logEntry);
  scrollToBottom(logConsole);
}

// Helper to render log line
function appendLogDOM(logEntry) {
  const entry = document.createElement('div');
  entry.className = `log-entry ${logEntry.type}`;
  entry.innerHTML = `<span class="log-time">[${logEntry.timestamp}]</span><span>${logEntry.message}</span>`;
  logConsole.appendChild(entry);
}

// Scroll console container to bottom
function scrollToBottom(element) {
  element.scrollTop = element.scrollHeight;
}
