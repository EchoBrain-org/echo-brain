// The renderer's only door out: one rpc call and one event stream.
import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('echo', {
  rpc: (method: string, params?: unknown) => ipcRenderer.invoke('rpc', { method, params }),
  on: (name: string, listener: (payload: unknown) => void) => {
    const handler = (_event: unknown, message: { name?: unknown; payload?: unknown }) => {
      if (message?.name === name) listener(message.payload);
    };
    ipcRenderer.on('event', handler);
    return () => { ipcRenderer.removeListener('event', handler); };
  },
});
