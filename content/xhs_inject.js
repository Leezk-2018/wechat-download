// Interceptor script injected into the MAIN world of creator.xiaohongshu.com

(function() {
  const log = (msg) => console.log('[XHS INJECT] ' + msg);
  log('拦截脚本已加载至 MAIN 空间，监控 API 请求...');

  function checkAndSaveNotes(json) {
    try {
      const notes = [];
      const scan = (obj) => {
        if (!obj || typeof obj !== 'object') return;
        
        // A note item in the creator API list typically has noteId, title, etc.
        const isNote = (obj.noteId || obj.id || obj.note_id || obj.idStr) && 
                       (obj.title || obj.desc || obj.content) && 
                       (obj.imageList || obj.images || obj.image_list || obj.cover);
                       
        if (isNote) {
          const id = obj.noteId || obj.id || obj.note_id || obj.idStr;
          if (id && typeof id === 'string' && id.length === 24) {
            notes.push(obj);
            return;
          }
        }
        
        for (const k in obj) {
          if (Object.prototype.hasOwnProperty.call(obj, k)) {
            scan(obj[k]);
          }
        }
      };
      
      scan(json);
      
      if (notes.length > 0) {
        log('主页面拦截到 ' + notes.length + ' 篇笔记数据，正在通过 CustomEvent 发送...');
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
      const url = args[0];
      const urlStr = typeof url === 'string' ? url : (url instanceof URL ? url.href : '');
      
      if (urlStr && (urlStr.includes('/api/sns/') || urlStr.includes('/note/'))) {
        const clone = response.clone();
        clone.json().then(json => {
          checkAndSaveNotes(json);
        }).catch(() => {});
      }
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
        if (this._url && (this._url.includes('/api/sns/') || this._url.includes('/note/'))) {
          const json = JSON.parse(this.responseText);
          checkAndSaveNotes(json);
        }
      } catch (e) {}
    });
    return originalSend.apply(this, args);
  };
})();
