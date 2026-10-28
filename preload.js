const { contextBridge, ipcRenderer, webUtils } = require('electron');

// Every handler in main.js returns { ok, value } or { ok: false, error };
// unwrap it here so the renderer can just await and catch.
async function call(channel, ...args) {
  const res = await ipcRenderer.invoke(channel, ...args);
  if (!res.ok) throw Object.assign(new Error(res.error), { code: res.code });
  return res.value;
}

const EVENTS = ['server:status', 'server:log', 'server:stats', 'server:players', 'task:progress', 'task:busy', 'backups:changed', 'update:state', 'app:quitting'];

contextBridge.exposeInMainWorld('api', {
  call,
  on(channel, fn) {
    if (!EVENTS.includes(channel)) throw new Error(`Unknown event ${channel}`);
    const listener = (_e, payload) => fn(payload);
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.removeListener(channel, listener);
  },
  pathForFile: (file) => webUtils.getPathForFile(file),
});
