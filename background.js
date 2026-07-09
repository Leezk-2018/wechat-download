// Background Service Worker for WeChat Download Extension
importScripts('libs/jszip.min.js');

// Global state
let downloadQueue = [];
let activeIndex = -1;
let status = 'idle'; // 'idle', 'running', 'paused', 'completed'
let settings = {
  format: 'txt', // 'zip_html', 'zip_md', 'single_html', 'txt'
  minDelay: 3,
  maxDelay: 8,
  concurrency: 1
};
let logHistory = [];

// Helper to log messages
function log(message, type = 'info') {
  const timestamp = new Date().toLocaleTimeString();
  const logEntry = { timestamp, message, type };
  logHistory.push(logEntry);
  // Keep last 200 logs
  if (logHistory.length > 200) logHistory.shift();
  
  // Broadcast to Popup
  chrome.runtime.sendMessage({ action: 'log_update', log: logEntry }).catch(() => {});
  saveState();
}

// Save state to chrome.storage.local
function saveState() {
  chrome.storage.local.set({
    downloadQueue,
    activeIndex,
    status,
    settings,
    logHistory
  });
}

// Load state from chrome.storage.local
chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.local.get(['downloadQueue', 'activeIndex', 'status', 'settings', 'logHistory'], (result) => {
    if (result.downloadQueue) downloadQueue = result.downloadQueue;
    if (result.activeIndex !== undefined) activeIndex = result.activeIndex;
    if (result.status) status = result.status;
    if (result.settings) settings = { ...settings, ...result.settings };
    if (result.logHistory) logHistory = result.logHistory;
    
    // If it was left running, reset to paused
    if (status === 'running') {
      status = 'paused';
      saveState();
    }
  });
});

// Message listener from popup or content scripts
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'add_tasks') {
    const newTasks = request.tasks.map(task => ({
      ...task,
      status: 'pending', // 'pending', 'downloading', 'completed', 'failed'
      progress: 0,
      error: null
    }));
    
    // Add unique tasks by URL
    const existingUrls = new Set(downloadQueue.map(t => t.url));
    const added = [];
    for (const task of newTasks) {
      if (!existingUrls.has(task.url)) {
        downloadQueue.push(task);
        added.push(task);
      }
    }
    
    log(`成功添加 ${added.length} 个下载任务。当前队列总数: ${downloadQueue.length}`, 'success');
    saveState();
    sendResponse({ success: true, count: added.length });
    
    // Auto-start if idle
    if (status === 'idle' || status === 'completed') {
      startQueue();
    }
  } 
  else if (request.action === 'start_queue') {
    startQueue();
    sendResponse({ success: true });
  } 
  else if (request.action === 'pause_queue') {
    status = 'paused';
    log('队列已暂停。', 'warning');
    saveState();
    sendResponse({ success: true });
  } 
  else if (request.action === 'clear_queue') {
    downloadQueue = [];
    activeIndex = -1;
    status = 'idle';
    logHistory = [];
    log('队列已清空。', 'info');
    saveState();
    sendResponse({ success: true });
  } 
  else if (request.action === 'update_settings') {
    settings = { ...settings, ...request.settings };
    log(`设置已更新: 格式=${settings.format}, 延迟=${settings.minDelay}-${settings.maxDelay}s`, 'success');
    saveState();
    sendResponse({ success: true });
  } 
  else if (request.action === 'get_state') {
    sendResponse({
      downloadQueue,
      activeIndex,
      status,
      settings,
      logHistory
    });
  }
  return true; // Keep message channel open for async response
});

// Queue controller
async function startQueue() {
  if (status === 'running') return;
  status = 'running';
  saveState();
  log('开始执行下载队列...', 'info');
  
  while (status === 'running') {
    // Find next pending task
    const nextIndex = downloadQueue.findIndex(t => t.status === 'pending');
    if (nextIndex === -1) {
      status = 'completed';
      log('所有下载任务已完成！', 'success');
      saveState();
      break;
    }
    
    activeIndex = nextIndex;
    downloadQueue[activeIndex].status = 'downloading';
    saveState();
    
    const task = downloadQueue[activeIndex];
    log(`正在下载 (${activeIndex + 1}/${downloadQueue.length}): ${task.title}`, 'info');
    
    try {
      await downloadArticle(task);
      downloadQueue[activeIndex].status = 'completed';
      downloadQueue[activeIndex].progress = 100;
      log(`下载完成: ${task.title}`, 'success');
    } catch (error) {
      console.error(error);
      downloadQueue[activeIndex].status = 'failed';
      downloadQueue[activeIndex].error = error.message || '未知错误';
      log(`下载失败: ${task.title} (原因: ${downloadQueue[activeIndex].error})`, 'danger');
    }
    
    saveState();
    
    // If there is another pending task and we are still running, wait before next task
    const hasMore = downloadQueue.some(t => t.status === 'pending');
    if (hasMore && status === 'running') {
      const delaySec = Math.floor(Math.random() * (settings.maxDelay - settings.minDelay + 1)) + settings.minDelay;
      log(`等待防封锁延迟，${delaySec} 秒后继续...`, 'info');
      await new Promise(resolve => setTimeout(resolve, delaySec * 1000));
    }
  }
}

// Helper to decode HTML Entities (e.g. &amp;, &nbsp;)
function decodeHTMLEntities(text) {
  if (!text) return '';
  return text
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (match, dec) => String.fromCharCode(dec));
}

// Robust function to extract `#js_content` from WeChat article HTML without DOMParser
function extractJsContent(htmlText) {
  const idIdx = htmlText.indexOf('id="js_content"');
  if (idIdx === -1) return null;
  
  // Find the opening tag start '<' of the tag containing id="js_content"
  let tagStartIdx = htmlText.lastIndexOf('<', idIdx);
  if (tagStartIdx === -1) return null;
  
  // Find the closing '>' of that opening tag
  let tagEndIdx = htmlText.indexOf('>', tagStartIdx);
  if (tagEndIdx === -1) return null;
  
  let contentStartIdx = tagEndIdx + 1;
  
  // Trace nested tags to find matching </div>
  let openDivs = 1;
  let currentIdx = contentStartIdx;
  
  while (openDivs > 0 && currentIdx < htmlText.length) {
    const nextOpen = htmlText.indexOf('<div', currentIdx);
    const nextClose = htmlText.indexOf('</div>', currentIdx);
    
    if (nextClose === -1) {
      // If no matching closing div, grab till the end of the text
      return htmlText.substring(contentStartIdx);
    }
    
    if (nextOpen !== -1 && nextOpen < nextClose) {
      openDivs++;
      currentIdx = nextOpen + 4;
    } else {
      openDivs--;
      if (openDivs === 0) {
        return htmlText.substring(contentStartIdx, nextClose);
      }
      currentIdx = nextClose + 6;
    }
  }
  return null;
}

// Extract images elements using RegExp without DOMParser
function extractImagesFromHtml(htmlText) {
  const imgRegex = /<img\s+[^>]*>/gi;
  const images = [];
  let match;
  
  while ((match = imgRegex.exec(htmlText)) !== null) {
    const imgTag = match[0];
    
    // Extract data-src or src attribute
    const srcMatch = imgTag.match(/data-src\s*=\s*["']([^"']+)["']/i) || 
                     imgTag.match(/\bsrc\s*=\s*["']([^"']+)["']/i);
                     
    if (srcMatch && srcMatch[1] && srcMatch[1].startsWith('http')) {
      // Force HTTPS to bypass Mixed Content restrictions and match Extension host permissions
      const secureUrl = srcMatch[1].replace(/^http:/i, 'https:');
      images.push({
        tag: imgTag,
        url: secureUrl
      });
    }
  }
  return images;
}

// Convert HTML content to Markdown without DOMParser
function convertHtmlToMarkdown(htmlText, title, accountName, date, originalUrl) {
  let md = htmlText;
  
  // Replace Headings
  md = md.replace(/<h1[^>]*>([\s\S]*?)<\/h1>/gi, '\n# $1\n');
  md = md.replace(/<h2[^>]*>([\s\S]*?)<\/h2>/gi, '\n## $1\n');
  md = md.replace(/<h3[^>]*>([\s\S]*?)<\/h3>/gi, '\n### $1\n');
  md = md.replace(/<h4[^>]*>([\s\S]*?)<\/h4>/gi, '\n#### $1\n');
  md = md.replace(/<h5[^>]*>([\s\S]*?)<\/h5>/gi, '\n##### $1\n');
  md = md.replace(/<h6[^>]*>([\s\S]*?)<\/h6>/gi, '\n###### $1\n');
  
  // Replace Bold / Italic
  md = md.replace(/<strong[^>]*>([\s\S]*?)<\/strong>/gi, '**$1**');
  md = md.replace(/<b[^>]*>([\s\S]*?)<\/b>/gi, '**$1**');
  md = md.replace(/<em[^>]*>([\s\S]*?)<\/em>/gi, '*$1*');
  md = md.replace(/<i[^>]*>([\s\S]*?)<\/i>/gi, '*$1*');
  
  // Replace Paragraphs / Breaks
  md = md.replace(/<p[^>]*>([\s\S]*?)<\/p>/gi, '\n$1\n');
  md = md.replace(/<br\s*\/?>/gi, '\n');
  
  // Replace Blockquotes
  md = md.replace(/<blockquote[^>]*>([\s\S]*?)<\/blockquote>/gi, '\n> $1\n');
  
  // Replace Links
  md = md.replace(/<a[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, '[$2]($1)');
  
  // Replace Images (which were rewritten in the caller)
  md = md.replace(/<img[^>]*src=["']([^"']+)["'][^>]*>/gi, '\n![图片]($1)\n');
  
  // Strip all other HTML tags
  md = md.replace(/<[^>]+>/g, '');
  
  // Decode HTML entities
  md = decodeHTMLEntities(md);
  
  // Clean up excessive newlines
  md = md.replace(/\n{3,}/g, '\n\n');
  
  // Append Frontmatter
  const finalMd = `# ${title}\n\n` +
    `- **公众号**: ${accountName}\n` +
    `- **发表时间**: ${date}\n` +
    `- **原文链接**: [阅读原文](${originalUrl})\n\n` +
    `---\n\n` +
    md.trim();
    
  return finalMd;
}

// Convert HTML content to plain TXT without DOMParser
function convertHtmlToTxt(htmlText, title, accountName, date, originalUrl) {
  let txt = htmlText;
  
  // Replace headings and paragraphs to ensure newlines/separations
  txt = txt.replace(/<h[1-6][^>]*>([\s\S]*?)<\/h[1-6]>/gi, '\n$1\n');
  txt = txt.replace(/<p[^>]*>([\s\S]*?)<\/p>/gi, '\n$1\n');
  txt = txt.replace(/<br\s*\/?>/gi, '\n');
  txt = txt.replace(/<blockquote[^>]*>([\s\S]*?)<\/blockquote>/gi, '\n$1\n');
  txt = txt.replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, '\n- $1');
  
  // Strip all other HTML tags
  txt = txt.replace(/<[^>]+>/g, '');
  
  // Decode HTML entities
  txt = decodeHTMLEntities(txt);
  
  // Clean up excessive newlines
  txt = txt.replace(/\n{3,}/g, '\n\n');
  
  // Format layout
  const finalTxt = `${title}\n` +
    `公众号: ${accountName}\n` +
    `发表时间: ${date}\n` +
    `原文链接: ${originalUrl}\n` +
    `========================================\n\n` +
    txt.trim();
    
  return finalTxt;
}

// Recursive helper to find note data in state object or API response
function findNoteDataInState(obj) {
  if (!obj || typeof obj !== 'object') return null;
  
  // A note object typically has (title or desc/content) AND (id/noteId)
  const hasTitleOrDesc = (obj.title !== undefined || obj.desc !== undefined || obj.content !== undefined);
  const hasId = (obj.id !== undefined || obj.noteId !== undefined || obj.note_id !== undefined);
  
  if (hasTitleOrDesc && hasId) {
    return obj;
  }
  
  // Recursively search
  for (const key in obj) {
    if (Object.prototype.hasOwnProperty.call(obj, key)) {
      const res = findNoteDataInState(obj[key]);
      if (res) return res;
    }
  }
  return null;
}

// Recursive helper to find a key inside an object
function findKeyInObject(obj, targetKey) {
  if (!obj || typeof obj !== 'object') return null;
  if (obj[targetKey] !== undefined) return obj[targetKey];
  
  for (const key in obj) {
    if (Object.prototype.hasOwnProperty.call(obj, key)) {
      const res = findKeyInObject(obj[key], targetKey);
      if (res) return res;
    }
  }
  return null;
}

// Recursive helper to find any string starting with http and containing xhscdn or sns-img
function extractUrlsFromObject(obj, urls = []) {
  if (!obj) return urls;
  if (typeof obj === 'string') {
    if (obj.startsWith('http') && (obj.includes('xhscdn.com') || obj.includes('sns-img') || obj.includes('sns-web'))) {
      urls.push(obj);
    }
  } else if (typeof obj === 'object') {
    for (const key in obj) {
      if (Object.prototype.hasOwnProperty.call(obj, key)) {
        extractUrlsFromObject(obj[key], urls);
      }
    }
  }
  return urls;
}

// Recursive helper to find video stream URLs ending with .mp4 or containing sns-video
function findVideoUrlInObject(obj) {
  if (!obj) return null;
  if (typeof obj === 'string') {
    if (obj.startsWith('http') && (obj.includes('.mp4') || obj.includes('sns-video') || obj.includes('stream'))) {
      return obj;
    }
  } else if (typeof obj === 'object') {
    const priorityKeys = ['masterUrl', 'streamUrl', 'videoUrl', 'url', 'backupUrl'];
    for (const key of priorityKeys) {
      if (obj[key] && typeof obj[key] === 'string' && obj[key].startsWith('http') && (obj[key].includes('.mp4') || obj[key].includes('sns-video'))) {
        return obj[key];
      }
    }
    
    for (const key in obj) {
      if (Object.prototype.hasOwnProperty.call(obj, key)) {
        const res = findVideoUrlInObject(obj[key]);
        if (res) return res;
      }
    }
  }
  return null;
}

// Fetch note details from creator center APIs using current session cookies
async function fetchFromCreatorApi(noteId) {
  const endpoints = [
    `https://creator.xiaohongshu.com/api/sns/v1/note/publish/detail?noteId=${noteId}`,
    `https://creator.xiaohongshu.com/api/sns/v1/note/info?noteId=${noteId}`,
    `https://creator.xiaohongshu.com/api/sns/v1/note/detail?noteId=${noteId}`
  ];
  
  for (const url of endpoints) {
    try {
      log(`尝试从创作者后台 API 获取笔记内容: ${url}`, 'info');
      const res = await fetch(url, {
        credentials: 'include',
        headers: {
          'Accept': 'application/json, text/plain, */*',
          'Accept-Language': 'zh-CN,zh;q=0.9',
          'Referer': 'https://creator.xiaohongshu.com/new/note-manager'
        }
      });
      if (res.ok) {
        const json = await res.json();
        log(`API 响应成功，正在解析 JSON 数据...`, 'success');
        
        const noteData = findNoteDataInState(json);
        if (noteData) {
          log(`成功从 API 解析出笔记数据!`, 'success');
          return noteData;
        }
      } else {
        log(`API 请求返回非200状态: HTTP ${res.status}`, 'warning');
      }
    } catch (err) {
      log(`API 请求异常: ${err.message}`, 'warning');
    }
  }
  return null;
}

// Download and parse Xiaohongshu note
// Scrape public note page by opening a temporary tab
async function scrapeNoteViaTab(url) {
  return new Promise((resolve, reject) => {
    let tabId = null;
    
    const cleanUp = () => {
      if (tabId) {
        chrome.tabs.remove(tabId).catch(() => {});
        tabId = null;
      }
    };
    
    // Set a timeout of 12 seconds
    const timer = setTimeout(() => {
      cleanUp();
      reject(new Error('页面加载超时'));
    }, 12000);
    
    chrome.tabs.create({ url, active: false }, (tab) => {
      if (!tab) {
        clearTimeout(timer);
        reject(new Error('无法创建标签页'));
        return;
      }
      tabId = tab.id;
      
      const checkTab = (updatedTabId, changeInfo) => {
        if (updatedTabId === tabId && changeInfo.status === 'complete') {
          chrome.tabs.onUpdated.removeListener(checkTab);
          
          // Wait 800ms for Vue/React to finish rendering
          setTimeout(async () => {
            try {
              const results = await chrome.scripting.executeScript({
                target: { tabId: tabId },
                func: () => {
                  const titleEl = document.querySelector('.title') || 
                                  document.querySelector('[class*="title"]') ||
                                  document.querySelector('h1');
                                  
                  const descEl = document.querySelector('.desc') || 
                                 document.querySelector('[class*="desc"]') || 
                                 document.querySelector('.note-text') || 
                                 document.querySelector('[class*="note-text"]') ||
                                 document.querySelector('.paragraph');
                                 
                  const images = [];
                  const imgEls = document.querySelectorAll('img');
                  imgEls.forEach(img => {
                    const src = img.src || img.getAttribute('src');
                    if (src && src.includes('xhscdn.com') && !src.includes('avatar') && !src.includes('logo') && !src.includes('fe-platform')) {
                      images.push(src);
                    }
                  });
                  
                  let state = null;
                  const scripts = Array.from(document.querySelectorAll('script'));
                  const stateScript = scripts.find(s => s.textContent.includes('__INITIAL_STATE__'));
                  if (stateScript) {
                    try {
                      const match = stateScript.textContent.match(/__INITIAL_STATE__\s*=\s*(\{[\s\S]*?\})(?:;|$)/);
                      if (match) state = JSON.parse(match[1]);
                    } catch (e) {}
                  }
                  
                  const authorEl = document.querySelector('.nickname') || 
                                   document.querySelector('.username') || 
                                   document.querySelector('[class*="nickname"]');
                                   
                  return {
                    title: titleEl?.textContent?.trim() || '',
                    desc: descEl?.textContent?.trim() || '',
                    images: images,
                    author: authorEl?.textContent?.trim() || '',
                    state: state
                  };
                }
              });
              
              clearTimeout(timer);
              cleanUp();
              
              if (results && results[0] && results[0].result) {
                resolve(results[0].result);
              } else {
                reject(new Error('脚本执行无返回结果'));
              }
            } catch (err) {
              clearTimeout(timer);
              cleanUp();
              reject(err);
            }
          }, 800);
        }
      };
      
      chrome.tabs.onUpdated.addListener(checkTab);
    });
  });
}

// Download and parse Xiaohongshu note
async function downloadXhsNote(task) {
  // Extract note ID from URL
  const urlMatch = task.url.match(/(?:explore|discovery\/item)\/([0-9a-zA-Z_-]{20,32})/i);
  if (!urlMatch) throw new Error('无法从任务中解析出笔记 ID');
  const noteId = urlMatch[1];
  
  let title = task.title || '未命名笔记';
  let desc = '';
  let imageUrls = [];
  let videoUrl = '';
  let creatorName = task.accountName || '小红书创作者';
  let publishTime = task.date || '';
  
  let fetchSuccess = false;
  
  // 0. Use pre-loaded data if available (fully populated by network interceptor in content script)
  if (task.isPreLoaded) {
    log(`检测到预载数据，直接使用已拦截的笔记详情`, 'success');
    title = task.title || title;
    desc = task.desc || '';
    imageUrls = task.imageUrls || [];
    videoUrl = task.videoUrl || '';
    creatorName = task.accountName || creatorName;
    publishTime = task.date || publishTime;
    fetchSuccess = true;
  }
  
  // 1. Try to fetch from creator APIs first (in case it works)
  const apiNoteData = !fetchSuccess ? await fetchFromCreatorApi(noteId) : null;
  if (apiNoteData) {
    title = apiNoteData.title || apiNoteData.content || apiNoteData.desc || title;
    desc = apiNoteData.desc || apiNoteData.content || apiNoteData.title || '';
    
    // Extract images recursively
    imageUrls = Array.from(new Set(extractUrlsFromObject(apiNoteData)));
    
    // Extract video
    const possibleVideo = findVideoUrlInObject(apiNoteData);
    if (possibleVideo) videoUrl = possibleVideo.replace(/^http:/i, 'https:');
    
    // Extract creator name
    if (apiNoteData.user) {
      creatorName = apiNoteData.user.nickname || creatorName;
    } else if (apiNoteData.author) {
      creatorName = apiNoteData.author.nickname || creatorName;
    }
    
    // Extract publish date
    const rawTime = apiNoteData.time || apiNoteData.publishTime || apiNoteData.createTime || apiNoteData.lastUpdateTime || apiNoteData.updateTime;
    if (rawTime) {
      if (typeof rawTime === 'number') {
        const ts = rawTime > 1e11 ? rawTime : rawTime * 1000;
        publishTime = new Date(ts).toISOString().split('T')[0];
      } else if (typeof rawTime === 'string') {
        publishTime = rawTime.split(' ')[0];
      }
    }
    
    fetchSuccess = true;
  }
  
  // 2. Try to scrape via temporary browser tab (super reliable, bypasses anti-crawler)
  if (!fetchSuccess || !desc) {
    try {
      log(`启动智能浏览器引擎，解析公开笔记页面: ${task.url}`, 'info');
      const result = await scrapeNoteViaTab(task.url);
      if (result) {
        const stateNoteData = result.state ? findNoteDataInState(result.state) : null;
        if (stateNoteData) {
          title = stateNoteData.title || result.title || title;
          desc = stateNoteData.desc || result.desc || '';
          imageUrls = Array.from(new Set(extractUrlsFromObject(stateNoteData)));
          const possibleVideo = findVideoUrlInObject(stateNoteData);
          if (possibleVideo) videoUrl = possibleVideo.replace(/^http:/i, 'https:');
          if (stateNoteData.user) {
            creatorName = stateNoteData.user.nickname || result.author || creatorName;
          } else if (stateNoteData.author) {
            creatorName = stateNoteData.author.nickname || result.author || creatorName;
          }
          const rawTime = stateNoteData.time || stateNoteData.publishTime || stateNoteData.createTime || stateNoteData.lastUpdateTime || stateNoteData.updateTime;
          if (rawTime) {
            if (typeof rawTime === 'number') {
              const ts = rawTime > 1e11 ? rawTime : rawTime * 1000;
              publishTime = new Date(ts).toISOString().split('T')[0];
            } else if (typeof rawTime === 'string') {
              publishTime = rawTime.split(' ')[0];
            }
          }
        } else {
          title = result.title || title;
          desc = result.desc || '';
          imageUrls = result.images || [];
          creatorName = result.author || creatorName;
        }
        fetchSuccess = true;
      }
    } catch (err) {
      log(`智能浏览器引擎解析失败: ${err.message}，正在尝试后台直接抓取降级...`, 'warning');
    }
  }
  
  // 3. Fallback to public explore page direct fetch if still failed
  if (!fetchSuccess || !desc) {
    log(`正在尝试通过公开笔记页面后台直接抓取...`, 'info');
    let htmlText = '';
    try {
      const res = await fetch(task.url, {
        credentials: 'include',
        headers: {
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,image/apng,*/*;q=0.8',
          'Accept-Language': 'zh-CN,zh;q=0.9',
          'Referer': 'https://www.xiaohongshu.com/'
        }
      });
      if (!res.ok) throw new Error(`HTTP 错误 ${res.status}`);
      htmlText = await res.text();
    } catch (err) {
      throw new Error(`无法获取公开笔记页面: ${err.message}`);
    }
    
    // Parse __INITIAL_STATE__
    const stateMatch = htmlText.match(/window\s*\.\s*__INITIAL_STATE__\s*=\s*(\{[\s\S]*?\})(?:;|<\/script>)/) ||
                       htmlText.match(/__INITIAL_STATE__\s*=\s*(\{[\s\S]*?\})(?:;|<\/script>)/);
                       
    let parsedStateSuccess = false;
    if (stateMatch) {
      try {
        let stateStr = stateMatch[1].trim();
        const stateObj = JSON.parse(stateStr);
        const noteData = findNoteDataInState(stateObj);
        if (noteData) {
          title = noteData.title || title;
          desc = noteData.desc || '';
          
          imageUrls = Array.from(new Set(extractUrlsFromObject(noteData)));
          
          const possibleVideo = findVideoUrlInObject(noteData);
          if (possibleVideo) videoUrl = possibleVideo.replace(/^http:/i, 'https:');
          
          if (noteData.user) {
            creatorName = noteData.user.nickname || creatorName;
          } else if (noteData.author) {
            creatorName = noteData.author.nickname || creatorName;
          }
          
          const rawTime = noteData.time || noteData.publishTime || noteData.createTime || noteData.lastUpdateTime || noteData.updateTime;
          if (rawTime) {
            if (typeof rawTime === 'number') {
              const ts = rawTime > 1e11 ? rawTime : rawTime * 1000;
              publishTime = new Date(ts).toISOString().split('T')[0];
            } else if (typeof rawTime === 'string') {
              publishTime = rawTime.split(' ')[0];
            }
          }
          parsedStateSuccess = true;
        }
      } catch (e) {
        console.error('Failed to parse XHS state JSON:', e);
      }
    }
    
    // HTML selectors parsing fallback
    if (!parsedStateSuccess || !desc) {
      const titleMatch = htmlText.match(/<meta\s+property=["']og:title["']\s+content=["']([^"']+)["']/i) ||
                         htmlText.match(/<meta\s+name=["']og:title["']\s+content=["']([^"']+)["']/i) ||
                         htmlText.match(/<title>([\s\S]*?)<\/title>/i);
      if (titleMatch) {
        title = decodeHTMLEntities(titleMatch[1].replace('- 小红书', '').replace('_小红书', '').trim());
      }
      
      const descMatch = htmlText.match(/<meta\s+name=["']description["']\s+content=["']([^"']+)["']/i) ||
                        htmlText.match(/<meta\s+property=["']og:description["']\s+content=["']([^"']+)["']/i);
      if (descMatch) {
        desc = decodeHTMLEntities(descMatch[1].trim());
      }
      
      if (imageUrls.length === 0) {
        const ogImgMatch = htmlText.match(/<meta\s+property=["']og:image["']\s+content=["']([^"']+)["']/i);
        if (ogImgMatch) {
          imageUrls.push(ogImgMatch[1].replace(/^http:/i, 'https:'));
        }
        
        const imgRegex = /<img\s+[^>]*src=["']([^"']+)["']/gi;
        let match;
        while ((match = imgRegex.exec(htmlText)) !== null) {
          const src = match[1];
          if (src.includes('xhscdn.com') && !src.includes('avatar') && !imageUrls.includes(src)) {
            imageUrls.push(src.replace(/^http:/i, 'https:'));
          }
        }
      }
    }
  }
  
  if (!creatorName) creatorName = '小红书创作者';
  if (!publishTime) publishTime = new Date().toISOString().split('T')[0];
  
  publishTime = publishTime.replace(/[\/\s:]/g, '-');
  
  // Update task info in queue
  if (downloadQueue[activeIndex]) {
    downloadQueue[activeIndex].title = title;
    downloadQueue[activeIndex].accountName = creatorName;
    downloadQueue[activeIndex].date = publishTime;
    saveState();
  }
  
  const safeFilename = sanitizeFilename(`${creatorName}-${title}-${publishTime}`);
  
  // 4. Download Images
  log(`笔记包含 ${imageUrls.length} 张图片，准备下载...`, 'info');
  const downloadedImages = [];
  let successImagesCount = 0;
  
  const concurrencyLimit = 4;
  for (let i = 0; i < imageUrls.length; i += concurrencyLimit) {
    const chunk = imageUrls.slice(i, i + concurrencyLimit);
    await Promise.all(chunk.map(async (imgUrl, offset) => {
      const idx = i + offset;
      try {
        const res = await fetch(imgUrl);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const blob = await res.blob();
        
        let ext = 'png';
        const contentType = res.headers.get('content-type');
        if (contentType) {
          if (contentType.includes('jpeg')) ext = 'jpg';
          else if (contentType.includes('gif')) ext = 'gif';
          else if (contentType.includes('webp')) ext = 'webp';
          else if (contentType.includes('png')) ext = 'png';
        }
        
        const filename = `image_${idx + 1}.${ext}`;
        const arrayBuffer = await blob.arrayBuffer();
        const base64Data = `data:${contentType || 'image/png'};base64,` + uint8ArrayToBase64(new Uint8Array(arrayBuffer));
        
        downloadedImages.push({
          originalUrl: imgUrl,
          filename,
          arrayBuffer,
          base64Data,
          contentType: contentType || `image/${ext}`
        });
        
        successImagesCount++;
        const percent = Math.round((successImagesCount / imageUrls.length) * 100);
        updateTaskProgress(activeIndex, percent);
      } catch (err) {
        log(`图片下载失败 (${imgUrl}): ${err.message}`, 'warning');
      }
    }));
  }
  
  log(`图片抓取完成: 成功 ${successImagesCount}/${imageUrls.length} 张`, 'success');
  
  // 5. Download Video (if videoUrl is present)
  let videoBlob = null;
  if (videoUrl) {
    try {
      log(`检测到视频内容，准备下载视频...`, 'info');
      const res = await fetch(videoUrl);
      if (res.ok) {
        videoBlob = await res.blob();
        log(`视频下载成功！`, 'success');
      } else {
        log(`视频下载失败: HTTP ${res.status}`, 'warning');
      }
    } catch (err) {
      log(`视频下载失败: ${err.message}`, 'warning');
    }
  }
  
  // 6. Generate formats
  let htmlContent = '';
  if (videoUrl && videoBlob) {
    if (settings.format === 'single_html') {
      const videoBuffer = await videoBlob.arrayBuffer();
      const videoBase64 = `data:${videoBlob.type || 'video/mp4'};base64,` + uint8ArrayToBase64(new Uint8Array(videoBuffer));
      htmlContent += `<div class="video-container" style="max-width: 100%; margin: 16px auto; text-align: center;">
        <video src="${videoBase64}" controls style="max-width: 100%; max-height: 500px; border-radius: 8px; box-shadow: 0 4px 10px rgba(0,0,0,0.1);"></video>
      </div>`;
    } else {
      htmlContent += `<div class="video-container" style="max-width: 100%; margin: 16px auto; text-align: center;">
        <video src="video.mp4" controls style="max-width: 100%; max-height: 500px; border-radius: 8px; box-shadow: 0 4px 10px rgba(0,0,0,0.1);"></video>
      </div>`;
    }
  }
  
  if (downloadedImages.length > 0) {
    htmlContent += `<div class="image-gallery" style="display: flex; flex-direction: column; gap: 16px; margin: 20px auto; max-width: 100%;">`;
    for (const img of downloadedImages) {
      const imgSrc = (settings.format === 'single_html') ? img.base64Data : `images/${img.filename}`;
      htmlContent += `<img src="${imgSrc}" style="max-width: 100%; height: auto; border-radius: 8px; box-shadow: 0 2px 8px rgba(0,0,0,0.06); display: block; margin: 0 auto;" />`;
    }
    htmlContent += `</div>`;
  }
  
  const formattedDesc = desc
    .split('\n')
    .map(line => `<p style="margin: 0 0 12px 0; font-size: 16px; color: #333; line-height: 1.6; white-space: pre-wrap;">${line}</p>`)
    .join('');
    
  htmlContent += `<div class="note-description" style="margin-top: 24px; padding-top: 20px; border-top: 1px dashed #eee;">${formattedDesc}</div>`;
  
  if (settings.format === 'zip_html') {
    const cleanedHtml = buildHtmlPage(title, creatorName, publishTime, task.url, htmlContent);
    const zip = new JSZip();
    zip.file('index.html', cleanedHtml);
    
    const imgFolder = zip.folder('images');
    for (const img of downloadedImages) {
      imgFolder.file(img.filename, img.arrayBuffer);
    }
    
    if (videoBlob && videoUrl) {
      const videoBuffer = await videoBlob.arrayBuffer();
      zip.file('video.mp4', videoBuffer);
    }
    
    const zipBlob = await zip.generateAsync({ type: 'blob' });
    await triggerDownload(zipBlob, `${safeFilename}.zip`);
  } 
  else if (settings.format === 'zip_md') {
    let md = '';
    for (const img of downloadedImages) {
      md += `![图片](images/${img.filename})\n\n`;
    }
    if (videoUrl) {
      md += `[视频链接](${videoUrl})\n\n`;
    }
    md += desc;
    
    const markdownContent = convertHtmlToMarkdown(md, title, creatorName, publishTime, task.url);
    
    const zip = new JSZip();
    zip.file(`${safeFilename}.md`, markdownContent);
    
    const imgFolder = zip.folder('images');
    for (const img of downloadedImages) {
      imgFolder.file(img.filename, img.arrayBuffer);
    }
    
    if (videoBlob && videoUrl) {
      const videoBuffer = await videoBlob.arrayBuffer();
      zip.file('video.mp4', videoBuffer);
    }
    
    const zipBlob = await zip.generateAsync({ type: 'blob' });
    await triggerDownload(zipBlob, `${safeFilename}.zip`);
  } 
  else if (settings.format === 'single_html') {
    const cleanedHtml = buildHtmlPage(title, creatorName, publishTime, task.url, htmlContent);
    const htmlBlob = new Blob([cleanedHtml], { type: 'text/html;charset=utf-8' });
    await triggerDownload(htmlBlob, `${safeFilename}.html`);
  } 
  else if (settings.format === 'txt') {
    const txtContent = `${title}\n` +
      `作者: ${creatorName}\n` +
      `发表时间: ${publishTime}\n` +
      `原文链接: ${task.url}\n` +
      `========================================\n\n` +
      (videoUrl ? `[视频链接] ${videoUrl}\n\n` : '') +
      desc.trim();
      
    const txtBlob = new Blob([txtContent], { type: 'text/plain;charset=utf-8' });
    await triggerDownload(txtBlob, `${safeFilename}.txt`);
  }
}

// Download and parse WeChat/Xiaohongshu article
async function downloadArticle(task) {
  if (task.url.includes('xiaohongshu.com') || task.type === 'xhs') {
    return downloadXhsNote(task);
  }

  // 1. Fetch Article HTML
  let htmlText = '';
  try {
    const res = await fetch(task.url);
    if (!res.ok) throw new Error(`HTTP 错误 ${res.status}`);
    htmlText = await res.text();
  } catch (err) {
    throw new Error(`无法获取文章内容: ${err.message}`);
  }
  
  // 2. Parse HTML elements without DOMParser
  const bodyHtml = extractJsContent(htmlText);
  if (!bodyHtml) {
    throw new Error('未找到文章正文内容 (#js_content)，可能链接无效或被限制访问');
  }
  
  // Extract or Fallback Metadata
  let title = task.title;
  if (!title) {
    const titleMatch = htmlText.match(/<h1[^>]*id="activity-name"[^>]*>([\s\S]*?)<\/h1>/i) ||
                       htmlText.match(/<h1[^>]*class="[^"]*rich_media_title[^"]*"[^>]*>([\s\S]*?)<\/h1>/i) ||
                       htmlText.match(/<h2[^>]*class="[^"]*rich_media_title[^"]*"[^>]*>([\s\S]*?)<\/h2>/i);
    title = titleMatch ? decodeHTMLEntities(titleMatch[1].replace(/<[^>]+>/g, '').trim()) : '未命名文章';
  }
  
  let accountName = task.accountName;
  if (!accountName || accountName === '微信公众号' || accountName === '公众号') {
    const accountMatch = htmlText.match(/<strong[^>]*class="[^"]*profile_nickname[^"]*"[^>]*>([\s\S]*?)<\/strong>/i) ||
                         htmlText.match(/id="js_name"[^>]*>([\s\S]*?)<\/a>/i) ||
                         htmlText.match(/nickname\s*=\s*['"]([^'"]+)['"]/i);
    accountName = accountMatch ? decodeHTMLEntities(accountMatch[1].replace(/<[^>]+>/g, '').trim()) : '微信公众号';
  }
  
  let date = task.date || '';
  if (!date) {
    const timeMatch = htmlText.match(/<em[^>]*id="publish_time"[^>]*>([\s\S]*?)<\/em>/i);
    if (timeMatch && timeMatch[1].replace(/<[^>]+>/g, '').trim()) {
      date = timeMatch[1].replace(/<[^>]+>/g, '').trim();
    } else {
      // Look in script variables for ct timestamp
      const ctMatch = htmlText.match(/ct\s*=\s*['"](\d+)['"]/i) || 
                      htmlText.match(/createTime\s*=\s*['"](\d+)['"]/i) ||
                      htmlText.match(/ori_create_time\s*=\s*['"](\d+)['"]/i);
                      
      if (ctMatch && ctMatch[1]) {
        const ts = parseInt(ctMatch[1]) * 1000;
        date = new Date(ts).toISOString().split('T')[0];
      } else {
        // Try to match date format in script blocks
        const dateMatch = htmlText.match(/publish_time\s*=\s*['"](\d{4}-\d{2}-\d{2})['"]/i) ||
                          htmlText.match(/['"](\d{4}-\d{2}-\d{2})['"]/);
        if (dateMatch) {
          date = dateMatch[1];
        } else {
          date = new Date().toISOString().split('T')[0];
        }
      }
    }
  }
  
  // Sanitize Date
  date = date.replace(/[\/\s:]/g, '-');
  
  // Update task metadata in the queue so the Popup list displays the correct name/date
  if (downloadQueue[activeIndex]) {
    downloadQueue[activeIndex].title = title;
    downloadQueue[activeIndex].accountName = accountName;
    downloadQueue[activeIndex].date = date;
    saveState();
  }
  
  // Sanitize Title for file name
  const safeFilename = sanitizeFilename(`${accountName}-${title}-${date}`);
  
  // 3. Find and Localize Images
  const images = extractImagesFromHtml(bodyHtml);
  log(`文章包含 ${images.length} 张图片，准备下载...`, 'info');
  
  const downloadedImages = [];
  let successImagesCount = 0;
  
  // Concurrently download images inside a single article (max 4 parallel fetches for assets)
  const concurrencyLimit = 4;
  for (let i = 0; i < images.length; i += concurrencyLimit) {
    const chunk = images.slice(i, i + concurrencyLimit);
    await Promise.all(chunk.map(async (imgInfo, offset) => {
      const idx = i + offset;
      const imgUrl = imgInfo.url;
      try {
        // Fetch image blob
        const res = await fetch(imgUrl);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const blob = await res.blob();
        
        // Determine file extension
        let ext = 'png';
        const contentType = res.headers.get('content-type');
        if (contentType) {
          if (contentType.includes('jpeg')) ext = 'jpg';
          else if (contentType.includes('gif')) ext = 'gif';
          else if (contentType.includes('webp')) ext = 'webp';
          else if (contentType.includes('png')) ext = 'png';
          else if (contentType.includes('svg')) ext = 'svg';
        } else {
          const urlObj = new URL(imgUrl);
          const wxFmt = urlObj.searchParams.get('wx_fmt');
          if (wxFmt) ext = wxFmt;
        }
        
        const filename = `image_${idx + 1}.${ext}`;
        const arrayBuffer = await blob.arrayBuffer();
        
        // Store download details
        const base64Data = `data:${contentType || 'image/png'};base64,` + uint8ArrayToBase64(new Uint8Array(arrayBuffer));
        
        downloadedImages.push({
          originalUrl: imgUrl,
          filename,
          arrayBuffer,
          base64Data,
          contentType: contentType || `image/${ext}`
        });
        
        successImagesCount++;
        const percent = Math.round((successImagesCount / images.length) * 100);
        updateTaskProgress(activeIndex, percent);
      } catch (err) {
        log(`图片下载失败 (${imgUrl}): ${err.message}`, 'warning');
      }
    }));
  }
  
  log(`图片抓取完成: 成功 ${successImagesCount}/${images.length} 张`, 'success');
  
  // 4. Reconstruct HTML with local images or Base64 images
  let finalBodyHtml = bodyHtml;
  for (const imgInfo of images) {
    const downloadedImg = downloadedImages.find(d => d.originalUrl === imgInfo.url);
    let newTag = '';
    if (downloadedImg) {
      if (settings.format === 'single_html') {
        newTag = `<img src="${downloadedImg.base64Data}" style="max-width: 100%; height: auto; display: block; margin: 16px auto; border-radius: 4px; box-shadow: 0 2px 6px rgba(0,0,0,0.05);" />`;
      } else {
        newTag = `<img src="images/${downloadedImg.filename}" style="max-width: 100%; height: auto; display: block; margin: 16px auto; border-radius: 4px; box-shadow: 0 2px 6px rgba(0,0,0,0.05);" />`;
      }
    } else {
      // Fallback to online image
      newTag = `<img src="${imgInfo.url}" style="max-width: 100%; height: auto; display: block; margin: 16px auto; border-radius: 4px; box-shadow: 0 2px 6px rgba(0,0,0,0.05);" />`;
    }
    
    // Replace the exact tag instance
    finalBodyHtml = finalBodyHtml.replace(imgInfo.tag, newTag);
  }
  
  // 5. Generate package based on target format
  if (settings.format === 'zip_html') {
    const cleanedHtml = buildHtmlPage(title, accountName, date, task.url, finalBodyHtml);
    
    // Create ZIP
    const zip = new JSZip();
    zip.file('index.html', cleanedHtml);
    
    const imgFolder = zip.folder('images');
    for (const img of downloadedImages) {
      imgFolder.file(img.filename, img.arrayBuffer);
    }
    
    const zipBlob = await zip.generateAsync({ type: 'blob' });
    await triggerDownload(zipBlob, `${safeFilename}.zip`);
  } 
  else if (settings.format === 'zip_md') {
    const markdownContent = convertHtmlToMarkdown(finalBodyHtml, title, accountName, date, task.url);
    
    const zip = new JSZip();
    zip.file(`${safeFilename}.md`, markdownContent);
    
    const imgFolder = zip.folder('images');
    for (const img of downloadedImages) {
      imgFolder.file(img.filename, img.arrayBuffer);
    }
    
    const zipBlob = await zip.generateAsync({ type: 'blob' });
    await triggerDownload(zipBlob, `${safeFilename}.zip`);
  } 
  else if (settings.format === 'single_html') {
    const cleanedHtml = buildHtmlPage(title, accountName, date, task.url, finalBodyHtml);
    const htmlBlob = new Blob([cleanedHtml], { type: 'text/html;charset=utf-8' });
    await triggerDownload(htmlBlob, `${safeFilename}.html`);
  } 
  else if (settings.format === 'txt') {
    const txtContent = convertHtmlToTxt(finalBodyHtml, title, accountName, date, task.url);
    const txtBlob = new Blob([txtContent], { type: 'text/plain;charset=utf-8' });
    await triggerDownload(txtBlob, `${safeFilename}.txt`);
  }
}

// Wrap content in beautiful template
function buildHtmlPage(title, accountName, date, originalUrl, bodyHtml) {
  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${title}</title>
  <style>
    body {
      font-family: -apple-system-font, BlinkMacSystemFont, "Helvetica Neue", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei UI", "Microsoft YaHei", Arial, sans-serif;
      background-color: #f9f9f9;
      color: #333;
      line-height: 1.6;
      padding: 0;
      margin: 0;
    }
    .container {
      background-color: #fff;
      padding: 32px 24px;
      max-width: 677px;
      margin: 0 auto;
      box-shadow: 0 4px 12px rgba(0, 0, 0, 0.05);
      min-height: 100vh;
      box-sizing: border-box;
    }
    .article-header {
      margin-bottom: 24px;
      border-bottom: 1px solid #eee;
      padding-bottom: 20px;
    }
    .article-title {
      font-size: 24px;
      font-weight: 700;
      line-height: 1.4;
      margin: 0 0 14px 0;
      color: #111;
    }
    .article-meta {
      font-size: 15px;
      color: #999;
      display: flex;
      flex-wrap: wrap;
      gap: 12px;
    }
    .account-name {
      color: #576b95;
      font-weight: 600;
    }
    .publish-date {
      color: #888;
    }
    .original-link a {
      color: #576b95;
      text-decoration: none;
    }
    .original-link a:hover {
      text-decoration: underline;
    }
    /* Content formatting */
    #js_content {
      visibility: visible !important;
      word-wrap: break-word;
      font-size: 16px;
    }
    img {
      max-width: 100% !important;
      height: auto !important;
      display: block;
      margin: 16px auto;
      border-radius: 4px;
      box-shadow: 0 2px 6px rgba(0, 0, 0, 0.05);
    }
    p {
      margin: 0 0 16px 0;
    }
    blockquote {
      margin: 16px 0;
      padding: 12px 16px;
      border-left: 4px solid #d3d3d3;
      background-color: #f6f6f6;
      color: #666;
      font-style: italic;
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="article-header">
      <h1 class="article-title">${title}</h1>
      <div class="article-meta">
        <span class="account-name">${accountName}</span>
        <span class="publish-date">${date}</span>
        <span class="original-link"><a href="${originalUrl}" target="_blank">阅读原文</a></span>
      </div>
    </div>
    <div id="js_content">
      ${bodyHtml}
    </div>
  </div>
</body>
</html>`;
}

// Convert blob to DataURL and trigger downloads
async function triggerDownload(blob, filename) {
  // Convert blob to ArrayBuffer, then Base64
  const arrayBuffer = await blob.arrayBuffer();
  const base64 = uint8ArrayToBase64(new Uint8Array(arrayBuffer));
  
  // Format DataURL based on extension
  let mimeType = 'application/octet-stream';
  if (filename.endsWith('.zip')) mimeType = 'application/zip';
  else if (filename.endsWith('.html')) mimeType = 'text/html';
  else if (filename.endsWith('.txt')) mimeType = 'text/plain';
  
  const dataUrl = `data:${mimeType};base64,${base64}`;
  
  return new Promise((resolve, reject) => {
    chrome.downloads.download({
      url: dataUrl,
      filename: filename,
      conflictAction: 'overwrite',
      saveAs: false
    }, (downloadId) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
      } else {
        // Monitor download completion
        const checkStatus = (delta) => {
          if (delta.id === downloadId && delta.state) {
            if (delta.state.current === 'complete') {
              chrome.downloads.onChanged.removeListener(checkStatus);
              resolve(downloadId);
            } else if (delta.state.current === 'interrupted') {
              chrome.downloads.onChanged.removeListener(checkStatus);
              reject(new Error('下载被中断'));
            }
          }
        };
        chrome.downloads.onChanged.addListener(checkStatus);
      }
    });
  });
}

// Helper to update progress in storage
function updateTaskProgress(idx, progress) {
  if (downloadQueue[idx]) {
    downloadQueue[idx].progress = progress;
    chrome.runtime.sendMessage({ action: 'progress_update', index: idx, progress }).catch(() => {});
  }
}

// File name sanitation
function sanitizeFilename(name) {
  return name
    .replace(/[\\/:*?"<>|]/g, '-') // Replace illegal characters with a hyphen
    .replace(/-+/g, '-')           // Collapse consecutive hyphens
    .replace(/_+/g, '_')           // Collapse consecutive underscores
    .trim()
    .substring(0, 120);
}

// Binary-to-base64 converter
function uint8ArrayToBase64(uint8Array) {
  const CHUNK_SIZE = 0x8000; // 32KB
  let index = 0;
  const length = uint8Array.length;
  let result = '';
  while (index < length) {
    const slice = uint8Array.subarray(index, Math.min(index + CHUNK_SIZE, length));
    result += String.fromCharCode.apply(null, slice);
    index += CHUNK_SIZE;
  }
  return btoa(result);
}
