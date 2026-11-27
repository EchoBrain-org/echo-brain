// Hiding the window, which closing it and the Open ECHO shortcut both do: ECHO stays in the tray. macOS keeps a
// full-screen window in a Space of its own, and a window hidden there leaves that Space black with nothing in it to
// close or quit (the founder, 2026-11-25: "i cannot quit the app when i make it full screen then exit. it will just turn
// black"). So a full-screen window leaves full screen first.
import { describe, expect, it } from 'vitest';
import { hideWindow, type HidableWindow } from '../../src/main/hide.js';

/** A window that records what it is asked, and leaves full screen only when the test says the system has finished. */
function fakeWindow(fullScreen: boolean) {
  const asked: string[] = [];
  const left: (() => void)[] = [];
  let destroyed = false;
  const window: HidableWindow = {
    isFullScreen: () => fullScreen,
    isDestroyed: () => destroyed,
    setFullScreen: flag => { asked.push(`fullScreen ${flag}`); },
    hide: () => { asked.push('hide'); },
    once: (_event, listener) => { left.push(listener); return window; },
  };
  return {
    window, asked,
    /** The system finishes taking the window out of full screen. */
    leave: () => { fullScreen = false; for (const listener of left.splice(0)) listener(); },
    destroy: () => { destroyed = true; },
  };
}

describe('hiding the window', () => {
  it('hides a window that is not full screen at once', () => {
    const { window, asked } = fakeWindow(false);
    hideWindow(window);
    expect(asked).toEqual(['hide']);
  });

  it('takes a full-screen window out of full screen first, and hides it only once it has left', () => {
    const { window, asked, leave } = fakeWindow(true);
    hideWindow(window);
    // Nothing is hidden while the Space is still the window's.
    expect(asked).toEqual(['fullScreen false']);
    leave();
    expect(asked).toEqual(['fullScreen false', 'hide']);
  });

  it('asks once, however many times the window is closed while it leaves full screen', () => {
    const { window, asked, leave } = fakeWindow(true);
    hideWindow(window);
    hideWindow(window);
    leave();
    expect(asked).toEqual(['fullScreen false', 'hide']);
  });

  it('hides nothing when the window is gone before it has left full screen, as when ECHO quits meanwhile', () => {
    const { window, asked, leave, destroy } = fakeWindow(true);
    hideWindow(window);
    destroy();
    leave();
    expect(asked).toEqual(['fullScreen false']);
  });
});
