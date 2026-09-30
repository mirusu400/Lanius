const plugin = 'lanius.request-marker';
let nextId = 1;
const pending = new Map();

function request(method, params = {}) {
  const id = `request-marker-${nextId++}`;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    parent.postMessage({ type: 'lanius.request', plugin, id, method, params }, '*');
  });
}

window.addEventListener('message', (event) => {
  const response = event.data;
  if (!response || response.type !== 'lanius.response') return;
  const handler = pending.get(response.id);
  if (!handler) return;
  pending.delete(response.id);
  if (response.error) handler.reject(new Error(response.error));
  else handler.resolve(response.result);
});

async function invoke(action) {
  return request('actions.invoke', {
    action: `${plugin}.${action}`,
    context: { location: 'global' },
  });
}

async function refresh() {
  const error = document.querySelector('#error');
  try {
    const stats = await invoke('stats');
    document.querySelector('#count').textContent = String(stats.count);
    document.querySelector('#header').textContent = `${stats.header}: ${stats.value}`;
    error.textContent = '';
  } catch (reason) {
    error.textContent = String(reason);
  }
}

document.querySelector('#refresh').addEventListener('click', refresh);
document.querySelector('#reset').addEventListener('click', async () => {
  await invoke('reset');
  await refresh();
});
void refresh();
