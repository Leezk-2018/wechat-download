// Interceptor script injected into the MAIN world of creator.xiaohongshu.com

(function() {
  const log = (msg) => console.log('[XHS INJECT] ' + msg);
  log('拦截脚本已加载至 MAIN 空间，监控 API 请求...');

  function checkAndSaveNotes(json) {
    try {
      const notes = [];
      const scan = (obj) => {
        if (!obj || typeof obj !== 'object') return;
        
        // Match any object that has a 24-character ID and some text (title, description, content or name)
        const id = obj.noteId || obj.id || obj.note_id || obj.idStr;
        const hasId = id && typeof id === 'string' && id.length === 24;
        const hasText = !!(obj.title || obj.desc || obj.content || obj.name);
                       
        if (hasId && hasText) {
          notes.push(obj);
          return; // Stop scanning deeper into this matched object
        }
        
        for (const k in obj) {
          if (Object.prototype.hasOwnProperty.call(obj, k)) {
            scan(obj[k]);
          }
        }
      };
      
      scan(json);
      
      if (notes.length > 0) {
        log('主页面拦截到 ' + notes.length + ' 篇符合特征的笔记数据，正在发送事件...');
        window.dispatchEvent(new CustomEvent('XHS_NOTES_INTERCEPTED', { detail: notes }));
      }
    } catch (e) {
      console.error('[XHS INJECT] 解析拦截数据失败:', e);
    }
  }

  // Intercept window.fetch
  const originalFetch = window.fetch;
  window.fetch = async function(...args) {
    const response = await originalFetch.apply(this, args);
    try {
      // Parse JSON for all fetch responses to check for note models
      const clone = response.clone();
      clone.json().then(json => {
        checkAndSaveNotes(json);
      }).catch(() => {});
    } catch (e) {}
    return response;
  };

  // Intercept XMLHttpRequest
  const originalOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function(method, url, ...args) {
    this._url = url;
    return originalOpen.apply(this, [method, url, ...args]);
  };

  const originalSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.send = function(...args) {
    this.addEventListener('load', function() {
      try {
        const json = JSON.parse(this.responseText);
        checkAndSaveNotes(json);
      } catch (e) {}
    });
    return originalSend.apply(this, args);
  };
})();
