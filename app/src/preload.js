const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  getState: () => ipcRenderer.invoke('get-state'),
  onState: cb => ipcRenderer.on('state', (_e, s) => cb(s)),

  // freelancer
  setup: opts => ipcRenderer.invoke('setup', opts),
  addProject: opts => ipcRenderer.invoke('add-project', opts),
  removeProject: id => ipcRenderer.invoke('remove-project', id),
  reset: () => ipcRenderer.invoke('reset'),
  presenceConfirm: () => ipcRenderer.invoke('presence-confirm'),

  // client
  setThreshold: minutes => ipcRenderer.invoke('set-threshold', minutes),
  setMonitoring: (name, on) => ipcRenderer.invoke('set-monitoring', name, on),
  setClientName: name => ipcRenderer.invoke('set-client-name', name),
  joinProject: code => ipcRenderer.invoke('join-project', code),
  newProject: () => ipcRenderer.invoke('new-project'),
  removeFreelancer: name => ipcRenderer.invoke('remove-freelancer', name),
  testNotification: () => ipcRenderer.invoke('test-notification'),

  // window + popup
  winMinimize: () => ipcRenderer.invoke('win-minimize'),
  winClose: () => ipcRenderer.invoke('win-close'),
  popupClose: () => ipcRenderer.invoke('popup-close'),
  popupView: () => ipcRenderer.invoke('popup-view'),
});
