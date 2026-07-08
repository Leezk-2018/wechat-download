// Content Script for Xiaohongshu Creator Platform (creator.xiaohongshu.com)

let noteElements = [];
let floatingBar = null;
let scanInterval = null;
let lastDetectedCount = 0;

// Initialize Content Script
function init() {
  log('小红书笔记批量下载器已激活');
  
  // Inject floating panel
  createFloatingBar();
  
  // Start periodic scanner (since Xiaohongshu creator dashboard is a dynamic React SPA)
  scanInterval = setInterval(scanArticles, 1500);
  
  // Initial scan
  scanArticles();
  
  // Listen for progress updates from background to show in floating bar
  chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === 'log_update' || request.action === 'progress_update') {
      updateFloatingBarProgress();
    }
  });
}

// Find nickname of the creator
function getCreatorName() {
  const selectors = [
    '.nickname',
    '.user-name',
    '.username',
    '.avatar-name',
    '.profile-name',
    '[class*="nickname"]',
    '[class*="username"]',
    '[class*="profile-name"]'
  ];
  for (const selector of selectors) {
    const el = document.querySelector(selector);
    if (el && el.textContent.trim()) {
      const name = el.textContent.trim();
      if (name && name.length < 40) return name;
    }
  }
  
  // Fallback to page title
  const title = document.title;
  const cleanTitle = title
    .replace('小红书创作者服务平台', '')
    .replace('创作者服务平台', '')
    .replace('笔记管理', '')
    .replace('-', '')
    .trim();
    
  return cleanTitle || '小红书创作者';
}

// Heuristics to find note title
function getNoteTitle(link, container) {
  // 1. Try link text first
  let text = link.textContent.trim();
  if (text && text.length > 2 && !['编辑', '数据', '复制', '删除', '详情', '查看'].some(w => text.includes(w))) {
    return text;
  }
  
  if (container) {
    // 2. Try image alt inside the container
    const img = container.querySelector('img');
    if (img && img.alt && img.alt.trim().length > 2) {
      return img.alt.trim();
    }
    
    // 3. Try selectors with "title", "name", "desc", "content"
    const titleEl = container.querySelector('[class*="title"], [class*="name"], [class*="desc"], [class*="content"]');
    if (titleEl && titleEl.textContent.trim().length > 2) {
      const txt = titleEl.textContent.trim();
      if (!['编辑', '数据', '复制', '删除', '详情', '查看'].some(w => txt.includes(w))) {
        return txt;
      }
    }
    
    // 4. Try h3, h4, h5 headings
    const heading = container.querySelector('h3, h4, h5');
    if (heading && heading.textContent.trim().length > 2) {
      return heading.textContent.trim();
    }
  }
  
  return '未命名笔记';
}

// Heuristics to find note publication date
function getNoteDate(container) {
  if (!container) return '';
  
  // 1. Look for specific classes containing time/date/publish
  const dateEl = container.querySelector('[class*="time"], [class*="date"], [class*="publish"]');
  if (dateEl) {
    const text = dateEl.textContent.trim();
    const dateMatch = text.match(/(\d{4}[-/]\d{2}[-/]\d{2})/);
    if (dateMatch) return dateMatch[1].replace(/\//g, '-');
    
    const shortDateMatch = text.match(/(\d{2}[-/]\d{2})/); // MM-DD
    if (shortDateMatch) {
      const year = new Date().getFullYear();
      return `${year}-${shortDateMatch[1].replace(/\//g, '-')}`;
    }
    
    if (text.includes('今天')) {
      return new Date().toISOString().split('T')[0];
    } else if (text.includes('昨天')) {
      const yesterday = new Date(Date.now() - 86400000);
      return yesterday.toISOString().split('T')[0];
    }
  }
  
  // 2. Traverse all text nodes for date patterns
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT, null, false);
  let node;
  while (node = walker.nextNode()) {
    const text = node.nodeValue.trim();
    const dateMatch = text.match(/(\d{4}[-/]\d{2}[-/]\d{2})/);
    if (dateMatch) return dateMatch[1].replace(/\//g, '-');
    
    const shortDateMatch = text.match(/(\d{2}[-/]\d{2})/);
    if (shortDateMatch) {
      const year = new Date().getFullYear();
      return `${year}-${shortDateMatch[1].replace(/\//g, '-')}`;
    }
    
    if (text.includes('今天')) {
      return new Date().toISOString().split('T')[0];
    } else if (text.includes('昨天')) {
      const yesterday = new Date(Date.now() - 86400000);
      return yesterday.toISOString().split('T')[0];
    }
  }
  
  return '';
}

// Scan the page DOM for Xiaohongshu note items
function scanArticles() {
  const links = document.querySelectorAll('a');
  let newArticlesFound = false;
  const currentUrls = new Set();
  
  links.forEach(link => {
    let url = link.getAttribute('href');
    if (!url) return;
    
    let noteId = null;
    
    // Check 1: Standard public explore/discovery URL
    const publicMatch = url.match(/(?:explore|discovery\/item)\/([0-9a-zA-Z_-]{20,32})/i);
    if (publicMatch) {
      noteId = publicMatch[1];
    } else {
      // Check 2: Creator edit / detail URL which includes ID parameter
      const creatorMatch = url.match(/[?&]id=([0-9a-zA-Z_-]{20,32})/i);
      const isNoteLink = url.includes('/publish/') || url.includes('/note-detail') || url.includes('/note-manager');
      if (creatorMatch && isNoteLink) {
        noteId = creatorMatch[1];
      }
    }
    
    if (!noteId) return;
    
    const cleanUrl = `https://www.xiaohongshu.com/explore/${noteId}`;
    
    // Avoid double-processing the same note item on the same page
    if (currentUrls.has(cleanUrl)) return;
    currentUrls.add(cleanUrl);
    
    if (link.dataset.xhsDownloadInjected) return;
    
    // Find container element
    const container = link.closest('.ant-table-row') || 
                      link.closest('tr') || 
                      link.closest('.note-item') || 
                      link.closest('.card') || 
                      link.closest('[class*="note"]') || 
                      link.closest('[class*="item"]') || 
                      link.parentElement?.parentElement;
                      
    // Extract metadata
    const title = getNoteTitle(link, container);
    const date = getNoteDate(container);
    
    link.dataset.xhsDownloadInjected = 'true';
    link.dataset.xhsTitle = title;
    link.dataset.xhsUrl = cleanUrl;
    link.dataset.xhsDate = date;
    
    // Inject Checkbox
    injectCheckbox(link, container);
    newArticlesFound = true;
  });
  
  // Update counts on panel
  const allInjected = document.querySelectorAll('a[data-xhs-download-injected="true"]');
  if (allInjected.length !== lastDetectedCount) {
    lastDetectedCount = allInjected.length;
    updateFloatingBarUI();
  }
}

// Inject checkbox next to link element
function injectCheckbox(linkEl, container) {
  if (linkEl.parentNode.classList.contains('xhs-download-checkbox-wrapper-parent')) return;
  
  const wrapper = document.createElement('span');
  wrapper.className = 'wx-download-checkbox-wrapper';
  
  const checkbox = document.createElement('input');
  checkbox.type = 'checkbox';
  checkbox.className = 'wx-download-checkbox';
  
  checkbox.addEventListener('click', (e) => {
    e.stopPropagation();
    updateFloatingBarUI();
  });
  
  wrapper.appendChild(checkbox);
  linkEl.parentNode.insertBefore(wrapper, linkEl);
  linkEl.parentNode.classList.add('xhs-download-checkbox-wrapper-parent');
  
  if (container) {
    container.classList.add('wx-download-article-highlight');
  }
}

// Create the floating panel
function createFloatingBar() {
  if (document.getElementById('wx-download-floating-panel')) return;
  
  floatingBar = document.createElement('div');
  floatingBar.id = 'wx-download-floating-panel';
  floatingBar.className = 'wx-download-floating-bar hidden';
  
  floatingBar.innerHTML = `
    <div class="wx-download-floating-bar-header">
      <div class="wx-download-floating-bar-title">
        <svg viewBox="0 0 24 24">
          <path d="M19.35 10.04C18.67 6.59 15.64 4 12 4 9.11 4 6.6 5.64 5.35 8.04 2.34 8.36 0 10.91 0 14c0 3.31 2.69 6 6 6h13c2.76 0 5-2.24 5-5 0-2.64-2.05-4.78-4.65-4.96zM17 13l-5 5-5-5h3V9h4v4h3z"/>
        </svg>
        <span>小红书笔记下载助手</span>
      </div>
      <button class="wx-download-floating-bar-close" title="隐藏 panel">×</button>
    </div>
    <div class="wx-download-floating-bar-info" id="wx-download-info">
      正在扫描页面上的笔记...
    </div>
    
    <!-- Progress display when running -->
    <div id="wx-download-progress-container" style="display:none; margin-bottom: 15px;">
      <div style="display:flex; justify-content:space-between; font-size:12px; margin-bottom:4px;">
        <span id="wx-progress-text" style="color:#555; text-overflow:ellipsis; overflow:hidden; white-space:nowrap; max-width:200px;">准备中...</span>
        <span id="wx-progress-percent" style="font-weight:bold; color:#ff2442;">0%</span>
      </div>
      <div style="width:100%; height:6px; background-color:#eee; border-radius:3px; overflow:hidden;">
        <div id="wx-progress-bar" style="width:0%; height:100%; background-color:#ff2442; transition: width 0.3s;"></div>
      </div>
      <div id="wx-progress-detail" style="font-size:11px; color:#999; margin-top:4px;">正在载入队列状态...</div>
    </div>

    <div class="wx-download-floating-bar-actions">
      <button class="wx-download-btn wx-download-btn-secondary" id="wx-btn-select-all">全选本页</button>
      <button class="wx-download-btn wx-download-btn-primary" id="wx-btn-download" style="background-color:#ff2442; box-shadow: 0 4px 10px rgba(255, 36, 66, 0.2);" disabled>批量下载 (0)</button>
    </div>
  `;
  
  // Custom styles for Xiaohongshu theme
  const style = document.createElement('style');
  style.textContent = `
    .wx-download-checkbox:checked {
      background-color: #ff2442 !important;
      border-color: #ff2442 !important;
    }
    .wx-download-checkbox:hover {
      border-color: #ff2442 !important;
      box-shadow: 0 0 4px rgba(255, 36, 66, 0.2) !important;
    }
    .wx-download-floating-bar-title {
      color: #ff2442 !important;
    }
    .wx-download-btn-primary:hover {
      background-color: #e11d38 !important;
      box-shadow: 0 4px 12px rgba(255, 36, 66, 0.3) !important;
    }
    .wx-download-article-highlight:hover {
      background-color: rgba(255, 36, 66, 0.02) !important;
    }
  `;
  document.head.appendChild(style);
  
  document.body.appendChild(floatingBar);
  
  // Event listeners
  floatingBar.querySelector('.wx-download-floating-bar-close').addEventListener('click', () => {
    floatingBar.classList.add('hidden');
    clearInterval(scanInterval);
  });
  
  document.getElementById('wx-btn-select-all').addEventListener('click', toggleSelectAll);
  document.getElementById('wx-btn-download').addEventListener('click', startBatchDownload);
  
  updateFloatingBarProgress();
}

// Updates floating bar UI
function updateFloatingBarUI() {
  if (!floatingBar) return;
  
  const allInjected = document.querySelectorAll('a[data-xhs-download-injected="true"]');
  const checked = document.querySelectorAll('.wx-download-checkbox:checked');
  const infoEl = document.getElementById('wx-download-info');
  const downloadBtn = document.getElementById('wx-btn-download');
  const selectAllBtn = document.getElementById('wx-btn-select-all');
  
  if (allInjected.length > 0) {
    floatingBar.classList.remove('hidden');
    infoEl.textContent = `已检测到本页 ${allInjected.length} 篇笔记。已选中 ${checked.length} 篇。`;
    downloadBtn.disabled = checked.length === 0;
    downloadBtn.textContent = `批量下载 (${checked.length})`;
    
    if (checked.length === allInjected.length && allInjected.length > 0) {
      selectAllBtn.textContent = '取消全选';
    } else {
      selectAllBtn.textContent = '全选本页';
    }
  } else {
    floatingBar.classList.add('hidden');
  }
}

// Select/Deselect all
function toggleSelectAll() {
  const checkboxes = document.querySelectorAll('.wx-download-checkbox');
  const checked = document.querySelectorAll('.wx-download-checkbox:checked');
  const shouldCheckAll = checked.length < checkboxes.length;
  
  checkboxes.forEach(cb => {
    cb.checked = shouldCheckAll;
  });
  
  updateFloatingBarUI();
}

// Send selected notes to background queue
async function startBatchDownload() {
  const checkedBoxes = document.querySelectorAll('.wx-download-checkbox:checked');
  const tasks = [];
  const creatorName = getCreatorName();
  
  checkedBoxes.forEach(cb => {
    const wrapper = cb.closest('.wx-download-checkbox-wrapper');
    if (!wrapper) return;
    const linkEl = wrapper.nextElementSibling;
    if (linkEl && linkEl.dataset.xhsDownloadInjected === 'true') {
      tasks.push({
        url: linkEl.dataset.xhsUrl,
        title: linkEl.dataset.xhsTitle,
        date: linkEl.dataset.xhsDate,
        accountName: creatorName,
        type: 'xhs'
      });
    }
  });
  
  if (tasks.length === 0) return;
  
  const downloadBtn = document.getElementById('wx-btn-download');
  downloadBtn.disabled = true;
  downloadBtn.textContent = '正在发送...';
  
  chrome.runtime.sendMessage({ action: 'add_tasks', tasks }, (response) => {
    if (response && response.success) {
      downloadBtn.textContent = '发送成功！';
      document.querySelectorAll('.wx-download-checkbox').forEach(cb => cb.checked = false);
      updateFloatingBarUI();
      
      setTimeout(() => {
        updateFloatingBarUI();
      }, 2000);
    } else {
      downloadBtn.disabled = false;
      downloadBtn.textContent = '发送失败，重试';
    }
  });
}

// Update downloading progress
function updateFloatingBarProgress() {
  chrome.runtime.sendMessage({ action: 'get_state' }, (state) => {
    if (!state) return;
    
    const progressContainer = document.getElementById('wx-download-progress-container');
    const progressText = document.getElementById('wx-progress-text');
    const progressPercent = document.getElementById('wx-progress-percent');
    const progressBar = document.getElementById('wx-progress-bar');
    const progressDetail = document.getElementById('wx-progress-detail');
    
    if (state.status === 'running' && state.activeIndex !== -1) {
      progressContainer.style.display = 'block';
      const activeTask = state.downloadQueue[state.activeIndex];
      if (activeTask) {
        progressText.textContent = activeTask.title;
        progressPercent.textContent = `${activeTask.progress}%`;
        progressBar.style.width = `${activeTask.progress}%`;
        
        const completedCount = state.downloadQueue.filter(t => t.status === 'completed').length;
        const failedCount = state.downloadQueue.filter(t => t.status === 'failed').length;
        progressDetail.textContent = `总队列进度: ${completedCount + failedCount}/${state.downloadQueue.length} (失败: ${failedCount})`;
      }
    } else {
      progressContainer.style.display = 'none';
    }
  });
}

function log(msg) {
  console.log(`[XHS Downloader] ${msg}`);
}

// Run
if (document.readyState === 'complete' || document.readyState === 'interactive') {
  init();
} else {
  document.addEventListener('DOMContentLoaded', init);
}
