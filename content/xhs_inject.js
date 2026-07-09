// Interceptor script injected into the MAIN world of creator.xiaohongshu.com

(function() {
  const log = (msg) => console.log('[XHS INJECT] ' + msg);
  log('拦截脚本已加载至 MAIN 空间，监控 API 请求...');

  function checkAndSaveNotes(json, url) {
    try {
      // Direct diagnostic log for notes list API response
      if (url && url.includes('/posted')) {
        log('--- 发现列表 API 数据，打印前 2 个元素以诊断字段 ---');
        try {
          if (json && json.data && json.data.notes) {
            console.log('[XHS INJECT DIAGNOSTIC] json.data.notes sample:', json.data.notes.slice(0, 2));
          } else if (json && json.data && Array.isArray(json.data)) {
            console.log('[XHS INJECT DIAGNOSTIC] json.data array sample:', json.data.slice(0, 2));
          } else {
            console.log('[XHS INJECT DIAGNOSTIC] Raw json root keys:', Object.keys(json));
            console.log('[XHS INJECT DIAGNOSTIC] Raw json value:', json);
          }
        } catch (err) {
          console.error('[XHS INJECT DIAGNOSTIC ERROR]', err);
        }
      }

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
        log('从 URL: ' + url + ' 中拦截到 ' + notes.length + ' 篇符合特征的笔记数据，正在发送事件...');
        window.dispatchEvent(new CustomEvent('XHS_NOTES_INTERCEPTED', { detail: notes }));
      }
    } catch (e) {
      console.error('[XHS INJECT] 解析拦截数据失败:', e);
    }
  }

  // Intercept window.fetch
  const originalFetch = window.fetch;
  window.fetch = async function(...args) {
    const url = args[0];
    const urlStr = typeof url === 'string' ? url : (url instanceof URL ? url.href : '');
    
    const response = await originalFetch.apply(this, args);
    try {
      const clone = response.clone();
      clone.json().then(json => {
        checkAndSaveNotes(json, urlStr);
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
    const urlStr = this._url || '';
    
    this.addEventListener('load', function() {
      try {
        const json = JSON.parse(this.responseText);
        checkAndSaveNotes(json, urlStr);
      } catch (e) {}
    });
    return originalSend.apply(this, args);
  };
})();
