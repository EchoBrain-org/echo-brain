// The renderer's only door out: one rpc call, one event stream, and dropped
// files, whose paths go straight to main and are never exposed to page script.
import { contextBridge, ipcRenderer, webUtils } from 'electron';

contextBridge.exposeInMainWorld('echo', {
  rpc: (method: string, params?: unknown) => ipcRenderer.invoke('rpc', { method, params }),
  on: (name: string, listener: (payload: unknown) => void) => {
    const handler = (_event: unknown, message: { name?: unknown; payload?: unknown }) => {
      if (message?.name === name) listener(message.payload);
    };
    ipcRenderer.on('event', handler);
    return () => { ipcRenderer.removeListener('event', handler); };
  },
  // A path only ever comes from a real dropped File, on its own channel.
  dropFile: (file: File) => ipcRenderer.invoke('drop', webUtils.getPathForFile(file)),
});
