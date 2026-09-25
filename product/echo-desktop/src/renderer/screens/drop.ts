import { useState } from 'preact/hooks';
import type { ProjectSummary } from '../../shared/protocol.js';
import { acceptDrop, canDrop } from '../store.js';

/**
 * Makes an element take a dropped file: a project row captures into its
 * project, the sheet attaches it. `over` lights the target while a file that
 * would be taken hovers over it.
 */
export function useDropTarget(on: ProjectSummary | 'sheet') {
  const [over, setOver] = useState(false);
  return {
    over,
    handlers: {
      onDragOver: (event: DragEvent) => {
        if (!canDrop(event)) return;
        event.preventDefault();
        event.stopPropagation();
        if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
        setOver(true);
      },
      onDragLeave: (event: DragEvent) => {
        if (!(event.currentTarget as Node).contains(event.relatedTarget as Node | null)) setOver(false);
      },
      onDrop: (event: DragEvent) => {
        setOver(false);
        // Text and links drop as usual, into the note or the bar.
        const files = event.dataTransfer?.files;
        if (!files || files.length === 0) return;
        event.preventDefault();
        event.stopPropagation();
        if (files.length === 1) void acceptDrop(files[0]!, on);
      },
    },
  };
}
