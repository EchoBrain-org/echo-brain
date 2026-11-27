/** What hideWindow asks of a window: Electron's BrowserWindow answers all of it. */
export interface HidableWindow {
  isFullScreen(): boolean;
  isDestroyed(): boolean;
  setFullScreen(flag: boolean): void;
  hide(): void;
  once(event: 'leave-full-screen', listener: () => void): unknown;
}

/** The windows on their way out of full screen to be hidden: each is asked once, however often it is closed meanwhile. */
const leaving = new WeakSet<HidableWindow>();

/**
 * Hides a window, which is how ECHO's window closes: ECHO stays in the tray. macOS keeps a full-screen window in a
 * Space of its own, and a window hidden there leaves that Space black, with nothing in it to close or quit. So a
 * full-screen window leaves full screen first, and is hidden once it has; unless it is gone by then, as when ECHO quit
 * meanwhile.
 */
export function hideWindow(window: HidableWindow): void {
  if (!window.isFullScreen()) { window.hide(); return; }
  if (leaving.has(window)) return;
  leaving.add(window);
  window.once('leave-full-screen', () => {
    leaving.delete(window);
    if (!window.isDestroyed()) window.hide();
  });
  window.setFullScreen(false);
}
