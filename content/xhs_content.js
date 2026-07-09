// Content Script for Xiaohongshu Creator Platform (creator.xiaohongshu.com)

console.log('[XHS DEBUG] xhs_content.js loaded successfully at: ' + window.location.href);
console.log('[XHS DEBUG] Window Details: parent is ' + (window.parent === window ? 'self' : 'parent') + ', top is ' + (window.top === window ? 'self' : 'top'));

let floatingBar = null;
let scanInterval = null;
let lastDetectedCount = 0;

// Detailed logger to inspect Vue properties on .note-card
function debugVueProperties() {
  try {
    const cards = document.querySelectorAll('.note-card');
    if (cards.length > 0) {
      const card = cards[0];
      const keys = Object.getOwnPropertyNames(card);
      console.log('[XHS DEBUG] Found note-card, DOM keys:', keys);
      
      keys.forEach(k => {
        if (k.includes('vue') || k.includes('react') || k.startsWith('__')) {
          const val = card[k];
          console.log(`[XHS DEBUG] Property "${k}" type: ${typeof val}`, val);
          
          if (val && typeof val === 'object') {
            console.log(`[XHS DEBUG] Property "${k}" keys:`, Object.keys(val));
            
            // Check potential note objects inside it
            if (val.props) {
              console.log(`[XHS DEBUG] Property "${k}".props:`, val.props);
              console.log(`[XHS DEBUG] Property "${k}".props keys:`, Object.keys(val.props));
            }
            if (val.setupState) {
              console.log(`[XHS DEBUG] Property "${k}".setupState:`, val.setupState);
            }
            if (val.ctx) {
              console.log(`[XHS DEBUG] Property "${k}".ctx keys:`, Object.keys(val.ctx));
            }
            if (val.memoizedProps) {
              console.log(`[XHS DEBUG] Property "${k}".memoizedProps:`, val.memoizedProps);
            }
          }
        }
      });
    } else {
      console.log('[XHS DEBUG] No elements with class .note-card found.');
    }
  } catch (e) {
    console.error('[XHS DEBUG] Error in debugVueProperties:', e);
  }
}

// Diagnostic reporter
function runDiagnosticReport() {
  try {
    const report = {
      url: window.location.href,
      readyState: document.readyState,
      iframesCount: document.querySelectorAll('iframe').length,
      allElementsCount: document.querySelectorAll('*').length,
      aTagsCount: document.querySelectorAll('a').length,
      buttonTagsCount: document.querySelectorAll('button').length,
      tableRowsCount: document.querySelectorAll('tr').length,
      potentialNoteCards: document.querySelectorAll('[class*="note"], [class*="card"], [class*="item"]').length
    };
    
    const buttons = Array.from(document.querySelectorAll('button, a, span, div'))
      .filter(el => el.children.length === 0 && el.textContent.trim().length > 0 && el.textContent.trim().length < 15)
      .map(el => el.textContent.trim());
    
    const uniqueButtons = Array.from(new Set(buttons)).slice(0, 30);
    
    console.log('[XHS DIAGNOSTIC REPORT]', report);
    console.log('[XHS DIAGNOSTIC BUTTON TEXT SAMPLE]', uniqueButtons);
  } catch (e) {
    console.error('[XHS DIAGNOSTIC ERROR]', e);
  }
}

// Initialize Content Script
function init() {
  log('小红书笔记批量下载器已激活');
  
  createFloatingBar();
  
  runDiagnosticReport();
  setInterval(runDiagnosticReport, 5000);
  
  // Debug Vue properties on note cards
  setInterval(debugVueProperties, 4000);
  setTimeout(debugVueProperties, 2000);
  
  scanInterval = setInterval(scanArticles, 1500);
  scanArticles();
  
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
function getNoteTitle(el, container) {
  if (el) {
    let text = el.textContent.trim();
    if (text && text.length > 2 && !['编辑', '数据', '复制', '删除', '详情', '查看'].some(w => text.includes(w))) {
      return text;
    }
  }
  
  if (container) {
    const img = container.querySelector('img');
    if (img && img.alt && img.alt.trim().length > 2) {
      return img.alt.trim();
    }
    
    const titleEl = container.querySelector('[class*="title"], [class*="name"], [class*="desc"], [class*="content"]');
    if (titleEl && titleEl.textContent.trim().length > 2) {
      const txt = titleEl.textContent.trim();
      if (!['编辑', '数据', '复制', '删除', '详情', '查看'].some(w => txt.includes(w))) {
        return txt;
      }
    }
    
    const heading = container.querySelector('h3, h4, h5');
    if (heading && heading.textContent.trim().length > 2) {
      return heading.textContent.trim();
    }
    
    const divs = container.querySelectorAll('div, span, p');
    for (const d of divs) {
      if (d.children.length === 0) {
        const txt = d.textContent.trim();
        if (txt.length > 4 && txt.length < 100 && !['编辑', '数据', '复制', '删除', '详情', '查看'].some(w => txt.includes(w))) {
          return txt;
        }
      }
    }
  }
  
  return '未命名笔记';
}

// Heuristics to find note publication date
function getNoteDate(container) {
  if (!container) return '';
  
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

// Helper to check if a props object contains note data
function checkPropsForNote(props) {
  if (!props || typeof props !== 'object') return null;
  
  let noteObj = null;
  if (props.noteInfo && typeof props.noteInfo === 'object') {
    noteObj = props.noteInfo;
  } else if (props['note-info'] && typeof props['note-info'] === 'object') {
    noteObj = props['note-info'];
  } else if (props.note && typeof props.note === 'object') {
    noteObj = props.note;
  } else if (props.record && typeof props.record === 'object') {
    noteObj = props.record;
  } else if (props.item && typeof props.item === 'object') {
    noteObj = props.item;
  } else if (props.data && typeof props.data === 'object') {
    noteObj = props.data;
  } else if (props.id && typeof props.id === 'string' && props.id.length === 24) {
    noteObj = props;
  } else if (props.noteId && typeof props.noteId === 'string' && props.noteId.length === 24) {
    noteObj = props;
  }
  
  if (noteObj) {
    const id = noteObj.id || noteObj.noteId || noteObj.note_id || noteObj.id_str;
    if (id && typeof id === 'string' && id.length === 24) {
      return noteObj;
    }
  }
  return null;
}

// Extract note props from DOM element using Vue or React properties (includes non-enumerable properties)
function getNotePropsFromElement(el) {
  const keys = Object.getOwnPropertyNames(el).concat(Object.keys(el));
  
  // 1. Check direct properties
  if (el.noteInfo || el.note || el.record || el.item || el.data) {
    const res = checkPropsForNote(el.noteInfo || el.note || el.record || el.item || el.data);
    if (res) return res;
  }
  
  // 2. Check Vue 3 Component Instance
  const vueParentKey = keys.find(k => k.startsWith('__vueParentComponent'));
  if (vueParentKey && el[vueParentKey]) {
    const comp = el[vueParentKey];
    if (comp.props) {
      const res = checkPropsForNote(comp.props);
      if (res) return res;
    }
    if (comp.setupState) {
      const res = checkPropsForNote(comp.setupState);
      if (res) return res;
    }
  }
  
  // 3. Check Vue 3 VNode
  const vnodeKey = keys.find(k => k.startsWith('__vnode'));
  if (vnodeKey && el[vnodeKey]) {
    const vnode = el[vnodeKey];
    if (vnode.props) {
      const res = checkPropsForNote(vnode.props);
      if (res) return res;
    }
  }
  
  // 4. Check Vue 2 VM Instance
  if (el.__vue__) {
    const vm = el.__vue__;
    const res = checkPropsForNote(vm);
    if (res) return res;
    if (vm.$props) {
      const res = checkPropsForNote(vm.$props);
      if (res) return res;
    }
  }
  
  // 5. Check React Props
  const reactPropsKey = keys.find(k => k.startsWith('__reactProps$'));
  if (reactPropsKey && el[reactPropsKey]) {
    const res = checkPropsForNote(el[reactPropsKey]);
    if (res) return res;
  }
  
  // 6. Check React Fiber / Internal Instance
  const fiberKey = keys.find(k => k.startsWith('__reactFiber$') || k.startsWith('__reactInternalInstance$'));
  if (fiberKey && el[fiberKey]) {
    let node = el[fiberKey];
    while (node) {
      const props = node.memoizedProps || node.pendingProps;
      if (props) {
        const res = checkPropsForNote(props);
        if (res) return res;
      }
      node = node.return;
    }
  }
  
  return null;
}

// Scan the page DOM for Xiaohongshu note items
function scanArticles() {
  const noteContainers = new Map(); // container -> { id, title, date, url }
  
  // Method 1: React/Vue internal properties scanning (primary method)
  const candidates = document.querySelectorAll('img, tr, td, div, span, p');
  candidates.forEach(el => {
    const noteObj = getNotePropsFromElement(el);
    if (noteObj) {
      const id = noteObj.id || noteObj.noteId || noteObj.note_id || noteObj.id_str;
      const container = el.closest('.note-card') ||
                        el.closest('.ant-table-row') || 
                        el.closest('tr') || 
                        el.closest('.note-item') || 
                        el.closest('.card') || 
                        el.closest('[class*="note"]') || 
                        el.closest('[class*="item"]') || 
                        el.parentElement?.parentElement || 
                        el;
                        
      if (noteContainers.has(container)) return;
      
      const title = noteObj.title || noteObj.desc || getNoteTitle(null, container);
      
      let date = '';
      const rawTime = noteObj.time || noteObj.publishTime || noteObj.createTime || noteObj.lastUpdateTime || noteObj.updateTime;
      if (rawTime) {
        if (typeof rawTime === 'number') {
          const ts = rawTime > 1e11 ? rawTime : rawTime * 1000;
          date = new Date(ts).toISOString().split('T')[0];
        } else if (typeof rawTime === 'string') {
          date = rawTime.split(' ')[0];
        }
      }
      if (!date) date = getNoteDate(container);
      
      noteContainers.set(container, {
        id,
        title,
        date,
        url: `https://www.xiaohongshu.com/explore/${id}`
      });
    }
  });
  
  // Method 2: Fallback scanning by action buttons (only if Vue/React scan found nothing)
  if (noteContainers.size === 0) {
    const allElements = document.querySelectorAll('*');
    const actionButtons = Array.from(allElements).filter(el => {
      const text = el.textContent.trim();
      return ['复制链接', '编辑', '数据分析', '数据', '删除', 'Copy Link', 'Edit', 'Analytics'].includes(text);
    });
    
    actionButtons.forEach(btn => {
      let container = btn;
      while (container.parentElement) {
        const parent = container.parentElement;
        const buttonsInParent = actionButtons.filter(b => parent.contains(b));
        if (buttonsInParent.length > 1) {
          break;
        }
        container = parent;
      }
      
      if (!noteContainers.has(container)) {
        const ids = findNoteIdInContainer(container);
        if (ids.length > 0) {
          const id = ids[0];
          const title = getNoteTitle(null, container);
          const date = getNoteDate(container);
          
          noteContainers.set(container, {
            id,
            title,
            date,
            url: `https://www.xiaohongshu.com/explore/${id}`
          });
        }
      }
    });
  }
  
  // Method 3: Fallback scanning by links
  if (noteContainers.size === 0) {
    const links = document.querySelectorAll('a');
    links.forEach(link => {
      let url = link.getAttribute('href');
      if (!url) return;
      
      let noteId = null;
      const publicMatch = url.match(/(?:explore|discovery\/item)\/([0-9a-zA-Z_-]{20,32})/i);
      if (publicMatch) {
        noteId = publicMatch[1];
      } else {
        const creatorMatch = url.match(/[?&]id=([0-9a-zA-Z_-]{20,32})/i);
        const isNoteLink = url.includes('/publish/') || url.includes('/note-detail') || url.includes('/note-manager');
        if (creatorMatch && isNoteLink) {
          noteId = creatorMatch[1];
        }
      }
      
      if (!noteId) return;
      
      const container = link.closest('.ant-table-row') || 
                        link.closest('tr') || 
                        link.closest('.note-item') || 
                        link.closest('.card') || 
                        link.closest('[class*="note"]') || 
                        link.closest('[class*="item"]') || 
                        link.parentElement?.parentElement || 
                        link;
                        
      if (!noteContainers.has(container)) {
        const title = getNoteTitle(link, container);
        const date = getNoteDate(container);
        
        noteContainers.set(container, {
          id: noteId,
          title,
          date,
          url: `https://www.xiaohongshu.com/explore/${noteId}`
        });
      }
    });
  }
  
  // Inject checkboxes
  let injectCount = 0;
  noteContainers.forEach((note, container) => {
    const { id, url, title, date } = note;
    
    if (container.dataset.xhsDownloadInjected) {
      const cb = container.querySelector('.wx-download-checkbox');
      if (cb) {
        cb.dataset.xhsUrl = url;
        cb.dataset.xhsTitle = title;
        cb.dataset.xhsDate = date;
      }
      return;
    }
    
    container.dataset.xhsDownloadInjected = 'true';
    injectCheckboxToContainer(container, container, url, title, date);
    injectCount++;
  });
  
  // Update counts
  const allCheckboxes = document.querySelectorAll('.wx-download-checkbox');
  if (allCheckboxes.length !== lastDetectedCount) {
    lastDetectedCount = allCheckboxes.length;
    updateFloatingBarUI();
    log(`扫描完成: 找到 ${noteContainers.size} 个唯一笔记容器, 新注入 ${injectCount} 个复选框, 当前总计 ${allCheckboxes.length} 个`);
  }
}

// Recursive helper to find and rank candidate note IDs in a note container
function findNoteIdInContainer(container) {
  const noteIdRegex = /\b[0-9a-f]{24}\b/gi;
  const candidates = [];
  
  const addCandidate = (id, priority) => {
    id = id.toLowerCase();
    const existing = candidates.find(c => c.id === id);
    if (existing) {
      if (priority > existing.priority) existing.priority = priority;
    } else {
      candidates.push({ id, priority });
    }
  };
  
  const checkStr = (str, priority) => {
    if (!str) return;
    let match;
    noteIdRegex.lastIndex = 0;
    while ((match = noteIdRegex.exec(str)) !== null) {
      addCandidate(match[0], priority);
    }
  };
  
  const priorityAttributes = ['data-row-key', 'data-id', 'data-note-id', 'key', 'id'];
  const elements = container.querySelectorAll('*');
  [container, ...Array.from(elements)].forEach(el => {
    if (el.attributes) {
      for (let i = 0; i < el.attributes.length; i++) {
        const attrName = el.attributes[i].name.toLowerCase();
        const attrVal = el.attributes[i].value;
        if (priorityAttributes.includes(attrName) || attrName.includes('key') || attrName.includes('id')) {
          checkStr(attrVal, 3);
        } else {
          checkStr(attrVal, 1);
        }
      }
    }
    if (el.href) {
      if (el.href.includes('explore') || el.href.includes('discovery')) {
        checkStr(el.href, 2);
      } else {
        checkStr(el.href, 1);
      }
    }
    if (el.src) checkStr(el.src, 1);
  });
  
  candidates.sort((a, b) => b.priority - a.priority);
  return candidates.map(c => c.id);
}

// Inject checkbox next to link element
function injectCheckbox(linkEl, container, url, title, date) {
  if (linkEl.parentNode.classList.contains('xhs-download-checkbox-wrapper-parent') ||
      linkEl.parentNode.querySelector('.wx-download-checkbox-wrapper')) return;
  
  const wrapper = document.createElement('span');
  wrapper.className = 'wx-download-checkbox-wrapper';
  
  const checkbox = document.createElement('input');
  checkbox.type = 'checkbox';
  checkbox.className = 'wx-download-checkbox';
  
  checkbox.dataset.xhsUrl = url;
  checkbox.dataset.xhsTitle = title;
  checkbox.dataset.xhsDate = date;
  
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

// Inject checkbox to table row or grid card
function injectCheckboxToContainer(el, container, url, title, date) {
  if (el.classList.contains('xhs-download-checkbox-wrapper-parent') || 
      el.querySelector('.wx-download-checkbox-wrapper')) return;
      
  const wrapper = document.createElement('span');
  wrapper.className = 'wx-download-checkbox-wrapper';
  wrapper.style.marginRight = '8px';
  wrapper.style.display = 'inline-flex';
  wrapper.style.alignItems = 'center';
  
  const checkbox = document.createElement('input');
  checkbox.type = 'checkbox';
  checkbox.className = 'wx-download-checkbox';
  
  checkbox.dataset.xhsUrl = url;
  checkbox.dataset.xhsTitle = title;
  checkbox.dataset.xhsDate = date;
  
  checkbox.addEventListener('click', (e) => {
    e.stopPropagation();
    updateFloatingBarUI();
  });
  
  wrapper.appendChild(checkbox);
  
  if (el.tagName.toLowerCase() === 'tr') {
    const firstCell = el.querySelector('td');
    if (firstCell) {
      firstCell.insertBefore(wrapper, firstCell.firstChild);
    } else {
      el.insertBefore(wrapper, el.firstChild);
    }
  } else {
    el.insertBefore(wrapper, el.firstChild);
  }
  
  el.classList.add('xhs-download-checkbox-wrapper-parent');
  if (container) {
    container.classList.add('wx-download-article-highlight');
  }
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
  
  const style = document.createElement('style');
  style.textContent = `
    .wx-download-checkbox {
      appearance: none !important;
      -webkit-appearance: none !important;
      width: 18px !important;
      height: 18px !important;
      border: 2px solid #ccc !important;
      border-radius: 4px !important;
      outline: none !important;
      transition: all 0.2s ease !important;
      cursor: pointer !important;
      display: inline-block !important;
      position: relative !important;
      background-color: #fff !important;
    }
    .wx-download-checkbox:checked {
      background-color: #ff2442 !important;
      border-color: #ff2442 !important;
    }
    .wx-download-checkbox:checked::after {
      content: '' !important;
      position: absolute !important;
      left: 5px !important;
      top: 1px !important;
      width: 5px !important;
      height: 9px !important;
      border: solid white !important;
      border-width: 0 2px 2px 0 !important;
      transform: rotate(45deg) !important;
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
  
  floatingBar.querySelector('.wx-download-floating-bar-close').addEventListener('click', () => {
    floatingBar.classList.add('hidden');
    clearInterval(scanInterval);
  });
  
  document.getElementById('wx-btn-select-all').addEventListener('click', toggleSelectAll);
  document.getElementById('wx-btn-download').addEventListener('click', startBatchDownload);
  
  updateFloatingBarUI();
}

// Updates floating bar UI
function updateFloatingBarUI() {
  if (!floatingBar) return;
  
  const allCheckboxes = document.querySelectorAll('.wx-download-checkbox');
  const checked = document.querySelectorAll('.wx-download-checkbox:checked');
  const infoEl = document.getElementById('wx-download-info');
  const downloadBtn = document.getElementById('wx-btn-download');
  const selectAllBtn = document.getElementById('wx-btn-select-all');
  
  floatingBar.classList.remove('hidden');
  
  if (allCheckboxes.length > 0) {
    infoEl.textContent = `已检测到本页 ${allCheckboxes.length} 篇笔记。已选中 ${checked.length} 篇。`;
    downloadBtn.disabled = checked.length === 0;
    downloadBtn.textContent = `批量下载 (${checked.length})`;
    
    if (checked.length === allCheckboxes.length && allCheckboxes.length > 0) {
      selectAllBtn.textContent = '取消全选';
    } else {
      selectAllBtn.textContent = '全选本页';
    }
  } else {
    infoEl.textContent = `正在扫描页面上的笔记... (未检测到可下载内容)`;
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

// Send selected notes to background queue
async function startBatchDownload() {
  const checkedBoxes = document.querySelectorAll('.wx-download-checkbox:checked');
  const tasks = [];
  const creatorName = getCreatorName();
  
  checkedBoxes.forEach(cb => {
    if (cb.dataset.xhsUrl) {
      tasks.push({
        url: cb.dataset.xhsUrl,
        title: cb.dataset.xhsTitle,
        date: cb.dataset.xhsDate || '',
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
