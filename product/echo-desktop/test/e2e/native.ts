import type { ElectronApplication } from '@playwright/test';
import type { Launched } from './launch.js';

interface Opened { echoTestOpened?: string[] }

/** Keeps main's real opener but captures its browser call; returns what was opened since. */
export async function captureOpenExternal(app: ElectronApplication): Promise<() => Promise<string[] | undefined>> {
  await app.evaluate(({ shell }) => {
    (globalThis as Opened).echoTestOpened = [];
    shell.openExternal = async url => { (globalThis as Opened).echoTestOpened!.push(url); };
  });
  return () => app.evaluate(() => (globalThis as Opened).echoTestOpened);
}

/** What quitting now asks, answered with Cancel. */
export function quitPrompts(run: Launched): Promise<string[]> {
  return run.app.evaluate(async ({ app: electronApp, dialog }) => {
    const prompts: string[] = [];
    dialog.showMessageBoxSync = ((options: Electron.MessageBoxSyncOptions) => { prompts.push(options.message); return 1; }) as never; // Cancel
    electronApp.quit();
    await new Promise(resolveWait => setTimeout(resolveWait, 300));
    return prompts;
  });
}
