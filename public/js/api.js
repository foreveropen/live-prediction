// 公共 API 层
const API = {
  token: localStorage.getItem('token') || null,
  user: null,

  async req(path, options = {}) {
    const headers = { 'Content-Type': 'application/json', ...(options.headers || {}) };
    if (this.token) headers['Authorization'] = 'Bearer ' + this.token;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    try {
      const res = await fetch(path, {
        method: options.method || 'GET',
        headers,
        body: options.body ? JSON.stringify(options.body) : undefined,
        signal: controller.signal
      });
      clearTimeout(timer);
      const json = await res.json().catch(() => ({ code: -1, message: '返回格式错误' }));
      if (json.code === 401) {
        this.token = null; this.user = null;
        localStorage.removeItem('token');
      }
      return json;
    } catch (e) {
      clearTimeout(timer);
      if (e.name === 'AbortError') throw new Error('请求超时');
      throw e;
    }
  },

  me() { return this.req('/api/auth/me'); },
  register(username, password) { return this.req('/api/auth/register', { method: 'POST', body: { username, password } }); },
  login(username, password) { return this.req('/api/auth/login', { method: 'POST', body: { username, password } }); },
  logout() { this.token = null; this.user = null; localStorage.removeItem('token'); },

  listPredictions() { return this.req('/api/predictions'); },
  createPrediction(data) { return this.req('/api/predictions', { method: 'POST', body: data }); },
  seal(id) { return this.req(`/api/predictions/${id}/seal`, { method: 'POST' }); },
  settle(id, side) { return this.req(`/api/predictions/${id}/settle`, { method: 'POST', body: { side } }); },
  voidPrediction(id) { return this.req(`/api/predictions/${id}/void`, { method: 'POST' }); },
  toggleTop(id) { return this.req(`/api/predictions/${id}/top`, { method: 'POST' }); },
  bet(id, side, amount) { return this.req(`/api/predictions/${id}/bet`, { method: 'POST', body: { side, amount } }); },
  history() { return this.req('/api/history'); },
};

function toast(msg) {
  let t = document.querySelector('.toast');
  if (!t) { t = document.createElement('div'); t.className = 'toast'; document.body.appendChild(t); }
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(t._timer);
  t._timer = setTimeout(() => t.classList.remove('show'), 2000);
}

function fmt(n) { return Number(n).toLocaleString(); }

// SSE 连接
function connectSSE(onEvent) {
  const es = new EventSource('/api/events');
  es.onmessage = (e) => {};
  ['prediction:new', 'prediction:updated', 'prediction:sealed', 'prediction:settled', 'prediction:voided'].forEach(ev => {
    es.addEventListener(ev, (e) => onEvent(ev, JSON.parse(e.data)));
  });
  es.onerror = () => { setTimeout(() => { try { es.close(); connectSSE(onEvent); } catch(e){} }, 3000); };
  return es;
}
