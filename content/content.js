// Content Script for WeChat Official Account Admin Platform (mp.weixin.qq.com)

let articleElements = [];
let floatingBar = null;
let scanInterval = null;
let lastDetectedCount = 0;

// Initialize Content Script
function init() {
  log('微信文章批量下载器已激活');
  
  // Inject floating panel
  createFloatingBar();
  
  // Start periodic scanner (since WeChat admin page is dynamic SPA)
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

// Helper to query element from current document or parent/top window (handles iframes)
function querySelectorOrParent(selector) {
  let el = document.querySelector(selector);
  if (el) return el;
  try {
    if (window.top && window.top.document) {
      el = window.top.document.querySelector(selector);
      if (el) return el;
    }
  } catch (e) {}
  try {
    if (window.parent && window.parent !== window && window.parent.document) {
      el = window.parent.document.querySelector(selector);
      if (el) return el;
    }
  } catch (e) {}
  return null;
}

// Helper to query all elements from current document or parent window (handles iframes)
function querySelectorAllOrParent(selector) {
  let elements = Array.from(document.querySelectorAll(selector));
  try {
    if (window.top && window.top.document) {
      elements = elements.concat(Array.from(window.top.document.querySelectorAll(selector)));
    }
  } catch (e) {}
  try {
    if (window.parent && window.parent !== window && window.parent.document) {
      elements = elements.concat(Array.from(window.parent.document.querySelectorAll(selector)));
    }
  } catch (e) {}
  return elements;
}

// Find element containing exact text
function findElementByText(text) {
  const elements = querySelectorAllOrParent('a, button, span, div, strong');
  for (const el of elements) {
    if (el.textContent.trim() === text) {
      return el;
    }
  }
  return null;
}

// Find all text node values recursively under a parent node
function findTextNodes(node, list) {
  if (node.nodeType === 3) { // Text Node
    list.push(node.nodeValue);
  } else {
    for (const child of node.childNodes) {
      findTextNodes(child, list);
    }
  }
}

// Heuristic to find nickname using logout button coordinates/relationships
function findNicknameHeuristically() {
  const logoutBtn = findElementByText('退出');
  if (logoutBtn) {
    let parent = logoutBtn.parentElement;
    for (let i = 0; i < 4; i++) {
      if (!parent) break;
      const textNodes = [];
      findTextNodes(parent, textNodes);
      for (const text of textNodes) {
        const cleanText = text.trim();
        if (
          cleanText &&
          cleanText !== '退出' &&
          cleanText !== '▼' &&
          cleanText !== '▲' &&
          cleanText.length > 1 &&
          cleanText.length < 30 &&
          !['首页', '已发表', '发表记录', '草稿箱', '素材库', '通知', '系统通知'].includes(cleanText)
        ) {
          return cleanText;
        }
      }
      parent = parent.parentElement;
    }
  }
  return null;
}

// Scrapes the logged-in official account name
function getOfficialAccountName() {
  // 1. Try heuristic first
  const heuristicName = findNicknameHeuristically();
  if (heuristicName) return heuristicName;

  // 2. Try typical CSS selectors
  const selectors = [
    '.weui-desktop-account__info .weui-desktop-account__nickname',
    '.weui-desktop-account__nickname',
    '.weui-desktop-avatar-handler__name',
    '.weui-desktop-account__name',
    '#nickname',
    '.nickname',
    '.username',
    '.account-name'
  ];
  
  for (const selector of selectors) {
    const el = querySelectorOrParent(selector);
    if (el && el.textContent.trim()) {
      const name = el.textContent.trim();
      if (name && name !== '退出' && name.length < 40) return name;
    }
  }
  
  // 3. Fallback to window titles
  let title = document.title;
  try {
    if (window.top && window.top.document) {
      title = window.top.document.title || title;
    } else if (window.parent && window.parent !== window && window.parent.document) {
      title = window.parent.document.title || title;
    }
  } catch (e) {}
  
  // Clean generic portal words
  const cleanTitle = title
    .replace('微信公众平台', '')
    .replace('首页', '')
    .replace('发表记录', '')
    .replace('-', '')
    .trim();
    
  return cleanTitle || '微信公众号';
}

// Scan page for WeChat article links
function scanArticles() {
  // Wechat article URL patterns:
  // - https://mp.weixin.qq.com/s/...
  // - https://mp.weixin.qq.com/s?__biz=...
  // - /s?__biz=... (relative)
  // - /s/ (relative with routing)
  const links = document.querySelectorAll('a[href*="/s?__biz="], a[href*="mp.weixin.qq.com/s"], a[href^="/s/"]');
  
  let newArticlesFound = false;
  const currentUrls = new Set();
  
  links.forEach(link => {
    let url = link.getAttribute('href');
    if (!url) return;
    
    // Resolve relative URL
    if (url.startsWith('/')) {
      url = 'https://mp.weixin.qq.com' + url;
    }
    
    // Clean URL (remove some tracking params but keep essential auth/biz ones)
    try {
      const urlObj = new URL(url);
      // Keep only necessary query parameters for WeChat articles
      const cleanParams = ['__biz', 'mid', 'idx', 'sn', 'chksm'];
      const searchParams = new URLSearchParams();
      cleanParams.forEach(param => {
        if (urlObj.searchParams.has(param)) {
          searchParams.set(param, urlObj.searchParams.get(param));
        }
      });
      
      // If it's a short URL (mp.weixin.qq.com/s/xxxxx), it has no query parameters
      if (urlObj.pathname.startsWith('/s/')) {
        url = urlObj.origin + urlObj.pathname;
      } else {
        url = urlObj.origin + urlObj.pathname + (searchParams.toString() ? '?' + searchParams.toString() : '');
      }
    } catch (e) {
      // fallback to original if parsing fails
    }
    
    // Skip duplicate links on page
    if (currentUrls.has(url)) return;
    currentUrls.add(url);
    
    // Check if we already injected checkbox for this element
    if (link.dataset.wxDownloadInjected) return;
    
    // Title extraction
    let title = link.textContent.trim();
    if (!title || title.length < 2) {
      // If link text is short/empty (like a card wrapper), search parent container for title text
      const parentCard = link.closest('.weui-desktop-mass-appmsg') || link.closest('.weui-desktop-mass__item') || link.parentElement;
      if (parentCard) {
        const titleEl = parentCard.querySelector('.weui-desktop-mass-appmsg__title') || parentCard.querySelector('h4') || parentCard.querySelector('.title');
        if (titleEl) title = titleEl.textContent.trim();
      }
    }
    
    if (!title || title.length < 2) return; // Ignore links without readable title
    
    // Date extraction
    let date = '';
    // Look for YYYY-MM-DD or YYYY/MM/DD by ascending to parent containers
    const massGroup = link.closest('.weui-desktop-mass') || 
                      link.closest('.weui-desktop-mass-appmsg') || 
                      link.closest('.weui-desktop-mass__item') || 
                      link.closest('tr') || 
                      link.parentElement?.parentElement?.parentElement?.parentElement;
                      
    if (massGroup) {
      // WeChat Admin typically stores the post time in a specific element
      const timeEl = massGroup.querySelector('.weui-desktop-mass__time') || 
                     massGroup.querySelector('.time') || 
                     massGroup.querySelector('.date') ||
                     massGroup.querySelector('.weui-desktop-mass__head');
                     
      if (timeEl) {
        const text = timeEl.textContent;
        const dateMatch = text.match(/(\d{4}[-/]\d{2}[-/]\d{2})/);
        if (dateMatch) {
          date = dateMatch[1].replace(/\//g, '-');
        } else {
          // Handle relative dates common in WeChat dashboard
          if (text.includes('今天')) {
            date = new Date().toISOString().split('T')[0];
          } else if (text.includes('昨天')) {
            const yesterday = new Date(Date.now() - 86400000);
            date = yesterday.toISOString().split('T')[0];
          }
        }
      }
      
      // Fallback matching in block text content
      if (!date) {
        const dateMatch = massGroup.textContent.match(/(\d{4}[-/]\d{2}[-/]\d{2})/);
        if (dateMatch) {
          date = dateMatch[1].replace(/\//g, '-');
        }
      }
    }
    
    // Store article meta info on the link dataset
    link.dataset.wxDownloadInjected = 'true';
    link.dataset.wxTitle = title;
    link.dataset.wxUrl = url;
    link.dataset.wxDate = date;
    
    // Inject Checkbox
    injectCheckbox(link);
    newArticlesFound = true;
  });
  
  // Re-query all injected checkboxes to update count
  const allInjected = document.querySelectorAll('a[data-wx-download-injected="true"]');
  if (allInjected.length !== lastDetectedCount) {
    lastDetectedCount = allInjected.length;
    updateFloatingBarUI();
  }
}

// Injects the checkbox element next to the article link
function injectCheckbox(linkEl) {
  const wrapper = document.createElement('span');
  wrapper.className = 'wx-download-checkbox-wrapper';
  
  const checkbox = document.createElement('input');
  checkbox.type = 'checkbox';
  checkbox.className = 'wx-download-checkbox';
  
  // Prevent clicking checkbox from navigating the link
  checkbox.addEventListener('click', (e) => {
    e.stopPropagation();
    updateFloatingBarUI();
  });
  
  wrapper.appendChild(checkbox);
  
  // Find where to insert: before the link tag or inside parent element
  // Normally, putting it right before the link element works beautifully
  linkEl.parentNode.insertBefore(wrapper, linkEl);
  
  // Highlight the container on hover
  const container = linkEl.closest('.weui-desktop-mass-appmsg') || linkEl.closest('.weui-desktop-mass__item') || linkEl.closest('tr') || linkEl;
  container.classList.add('wx-download-article-highlight');
}

// Create the floating panel
function createFloatingBar() {
  if (document.getElementById('wx-download-floating-panel')) return;
  
  floatingBar = document.createElement('div');
  floatingBar.id = 'wx-download-floating-panel';
  floatingBar.className = 'wx-download-floating-bar';
  
  floatingBar.innerHTML = `
    <div class="wx-download-floating-bar-header">
      <div class="wx-download-floating-bar-title">
        <svg viewBox="0 0 24 24">
          <path d="M19.35 10.04C18.67 6.59 15.64 4 12 4 9.11 4 6.6 5.64 5.35 8.04 2.34 8.36 0 10.91 0 14c0 3.31 2.69 6 6 6h13c2.76 0 5-2.24 5-5 0-2.64-2.05-4.78-4.65-4.96zM17 13l-5 5-5-5h3V9h4v4h3z"/>
        </svg>
        <span>微信文章下载助手</span>
      </div>
      <button class="wx-download-floating-bar-close" title="隐藏 panel">×</button>
    </div>
    <div class="wx-download-floating-bar-info" id="wx-download-info">
      正在扫描页面上的已发表文章...
    </div>
    
    <!-- Progress display when running -->
    <div id="wx-download-progress-container" style="display:none; margin-bottom: 15px;">
      <div style="display:flex; justify-content:space-between; font-size:12px; margin-bottom:4px;">
        <span id="wx-progress-text" style="color:#555; text-overflow:ellipsis; overflow:hidden; white-space:nowrap; max-width:200px;">准备中...</span>
        <span id="wx-progress-percent" style="font-weight:bold; color:#07c160;">0%</span>
      </div>
      <div style="width:100%; height:6px; background-color:#eee; border-radius:3px; overflow:hidden;">
        <div id="wx-progress-bar" style="width:0%; height:100%; background-color:#07c160; transition: width 0.3s;"></div>
      </div>
      <div id="wx-progress-detail" style="font-size:11px; color:#999; margin-top:4px;">正在载入队列状态...</div>
    </div>

    <div class="wx-download-floating-bar-actions">
      <button class="wx-download-btn wx-download-btn-secondary" id="wx-btn-select-all">全选本页</button>
      <button class="wx-download-btn wx-download-btn-primary" id="wx-btn-download" disabled>批量下载 (0)</button>
    </div>
  `;
  
  document.body.appendChild(floatingBar);
  
  // Event listeners
  floatingBar.querySelector('.wx-download-floating-bar-close').addEventListener('click', () => {
    floatingBar.classList.add('hidden');
    clearInterval(scanInterval); // stop scanning if closed
  });
  
  document.getElementById('wx-btn-select-all').addEventListener('click', toggleSelectAll);
  document.getElementById('wx-btn-download').addEventListener('click', startBatchDownload);
  
  updateFloatingBarProgress();
}

// Updates floating bar when elements check/uncheck
function updateFloatingBarUI() {
  if (!floatingBar) return;
  
  const allInjected = document.querySelectorAll('a[data-wx-download-injected="true"]');
  const checked = document.querySelectorAll('.wx-download-checkbox:checked');
  const infoEl = document.getElementById('wx-download-info');
  const downloadBtn = document.getElementById('wx-btn-download');
  const selectAllBtn = document.getElementById('wx-btn-select-all');
  
  floatingBar.classList.remove('hidden');
  
  if (allInjected.length > 0) {
    infoEl.textContent = `已检测到本页 ${allInjected.length} 篇发表文章。已选中 ${checked.length} 篇。`;
    downloadBtn.disabled = checked.length === 0;
    downloadBtn.textContent = `批量下载 (${checked.length})`;
    
    if (checked.length === allInjected.length && allInjected.length > 0) {
      selectAllBtn.textContent = '取消全选';
    } else {
      selectAllBtn.textContent = '全选本页';
    }
  } else {
    infoEl.textContent = `正在扫描页面上的已发表文章... (未检测到可下载内容)`;
    downloadBtn.disabled = true;
    downloadBtn.textContent = `批量下载 (0)`;
    selectAllBtn.textContent = '全选本页';
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

// Sends selected articles to download queue in Background
async function startBatchDownload() {
  const checkedBoxes = document.querySelectorAll('.wx-download-checkbox:checked');
  const tasks = [];
  const accountName = getOfficialAccountName();
  
  checkedBoxes.forEach(cb => {
    // Find the associated link (the next sibling or child of the wrapper)
    const wrapper = cb.closest('.wx-download-checkbox-wrapper');
    if (!wrapper) return;
    const linkEl = wrapper.nextElementSibling;
    if (linkEl && linkEl.dataset.wxDownloadInjected === 'true') {
      tasks.push({
        url: linkEl.dataset.wxUrl,
        title: linkEl.dataset.wxTitle,
        date: linkEl.dataset.wxDate,
        accountName: accountName
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
      // Uncheck all after sending
      document.querySelectorAll('.wx-download-checkbox').forEach(cb => cb.checked = false);
      updateFloatingBarUI();
      
      // Flash success visual
      setTimeout(() => {
        updateFloatingBarUI();
      }, 2000);
    } else {
      downloadBtn.disabled = false;
      downloadBtn.textContent = '发送失败，重试';
    }
  });
}

// Fetch status from background and update progress display on floating bar
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

// Simple Logger helper
function log(msg) {
  console.log(`[WeChat Downloader] ${msg}`);
}

// Start execution
if (document.readyState === 'complete' || document.readyState === 'interactive') {
  init();
} else {
  document.addEventListener('DOMContentLoaded', init);
}
