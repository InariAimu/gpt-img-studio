import { useEffect, useRef, useState, type PointerEvent } from 'react';
import { Folder, FolderOpen, Pencil, Plus } from 'lucide-react';
import type { Studio } from './useStudio';

type Drop = { rowId: string; edge: 'before' | 'after'; beforeId: string | null };
type Drag = { id: string; pointerId: number; startX: number; startY: number; x: number; y: number; active: boolean; source: HTMLButtonElement };
const DRAG_THRESHOLD = 8;

export default function WorkspaceTree({ studio, currentId, onOpen, onRename, onCreate }: {
  studio: Studio;
  currentId?: string;
  onOpen: (id: string) => void;
  onRename: (id: string) => void;
  onCreate: (id: string) => void;
}) {
  const workspaces = studio.document.workspaces;
  const tree = useRef<HTMLDivElement>(null);
  const drag = useRef<Drag | null>(null);
  const target = useRef<Drop | null>(null);
  const busy = useRef(false);
  const suppressClick = useRef(false);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [drop, setDrop] = useState<Drop | null>(null);
  const [saving, setSaving] = useState(false);

  function cancelDrag() {
    const current = drag.current;
    drag.current = null;
    target.current = null;
    setDraggingId(null);
    setDrop(null);
    if (current?.source.hasPointerCapture(current.pointerId)) current.source.releasePointerCapture(current.pointerId);
  }

  function locateDrop() {
    const current = drag.current;
    const container = tree.current;
    const scroller = container?.closest('.sidebar-top');
    if (!current?.active || !container || !scroller) return;
    const bounds = container.getBoundingClientRect();
    const viewport = scroller.getBoundingClientRect();
    let next: Drop | null = null;
    if (current.x >= bounds.left && current.x <= bounds.right &&
        current.y >= Math.max(bounds.top, viewport.top) && current.y <= Math.min(bounds.bottom + 12, viewport.bottom)) {
      const rows = [...container.querySelectorAll<HTMLElement>('[data-workspace-id]')]
        .filter(row => row.dataset.workspaceId !== current.id);
      const before = rows.find(row => {
        const rect = row.getBoundingClientRect();
        return current.y < rect.top + rect.height / 2;
      });
      const row = before || rows[rows.length - 1];
      if (row) next = { rowId: row.dataset.workspaceId!, edge: before ? 'before' : 'after', beforeId: before?.dataset.workspaceId || null };
    }
    if (next?.rowId !== target.current?.rowId || next?.edge !== target.current?.edge) {
      target.current = next;
      setDrop(next);
    }
  }

  // Pointer capture works inside the desktop WebView without interfering with file drops.
  // Keep scrolling while held near an edge, even if the mouse is stationary.
  useEffect(() => {
    if (!draggingId) return;
    let frame = 0;
    let last = performance.now();
    const tick = (time: number) => {
      const current = drag.current;
      const scroller = tree.current?.closest('.sidebar-top');
      if (current?.active && scroller) {
        const rect = scroller.getBoundingClientRect();
        if (current.x >= rect.left && current.x <= rect.right && current.y >= rect.top && current.y <= rect.bottom) {
          const speed = current.y < rect.top + 32 ? -1 : current.y > rect.bottom - 32 ? 1 : 0;
          scroller.scrollTop += speed * Math.min(time - last, 40) * 0.35;
        }
        locateDrop();
      }
      last = time;
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [draggingId]);

  useEffect(() => {
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') cancelDrag(); };
    window.addEventListener('keydown', escape);
    window.addEventListener('blur', cancelDrag);
    return () => { window.removeEventListener('keydown', escape); window.removeEventListener('blur', cancelDrag); };
  }, []);

  async function saveOrder(ids: string[]) {
    if (busy.current || ids.every((id, index) => workspaces[index]?.id === id)) return;
    busy.current = true;
    setSaving(true);
    try { await studio.mutate({ type: 'reorder_workspaces', ids }); }
    catch (error) { studio.report(error); }
    finally { busy.current = false; setSaving(false); }
  }

  function move(event: PointerEvent<HTMLButtonElement>) {
    const current = drag.current;
    if (!current || current.pointerId !== event.pointerId) return;
    current.x = event.clientX;
    current.y = event.clientY;
    if (!current.active && Math.hypot(current.x - current.startX, current.y - current.startY) >= DRAG_THRESHOLD) {
      current.active = true;
      suppressClick.current = true;
      setDraggingId(current.id);
    }
    locateDrop();
  }

  function finish(event: PointerEvent<HTMLButtonElement>) {
    if (drag.current?.pointerId !== event.pointerId) return;
    move(event);
    const current = drag.current;
    const destination = target.current;
    cancelDrag();
    if (!current?.active || !destination || !workspaces.some(w => w.id === current.id)) return;
    const ids = workspaces.map(w => w.id).filter(id => id !== current.id);
    const index = destination.beforeId === null ? ids.length : ids.indexOf(destination.beforeId);
    if (index < 0) return;
    ids.splice(index, 0, current.id);
    void saveOrder(ids);
  }

  return <div ref={tree} className={`workspace-tree ${draggingId ? 'is-dragging' : ''}`} aria-label="工作区列表" aria-busy={saving}
    onPointerDownCapture={() => { if (!drag.current) suppressClick.current = false; }}
    onClickCapture={event => {
      // A drag (including a cancelled drag) must not turn into navigation on release.
      // Keyboard activation has detail=0 and remains available after dragging.
      if (suppressClick.current && event.detail !== 0) { event.preventDefault(); event.stopPropagation(); }
    }}>
    {workspaces.map((workspace, index) => {
      const current = workspace.id === currentId;
      return <div key={workspace.id} data-workspace-id={workspace.id} className={`workspace-row ${current ? 'current' : ''} ${draggingId === workspace.id ? 'dragging' : ''} ${drop?.rowId === workspace.id ? `drop-${drop.edge}` : ''}`}>
        <button className="workspace-link" title={workspace.name} aria-current={current ? 'page' : undefined} aria-description="按住并移动可排序，也可用 Alt 加上下方向键调整" onClick={() => onOpen(workspace.id)}
          onPointerDown={event => {
            if (event.button !== 0 || !event.isPrimary || busy.current || drag.current || workspaces.length < 2) return;
            event.currentTarget.setPointerCapture(event.pointerId);
            drag.current = { id: workspace.id, pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, x: event.clientX, y: event.clientY, active: false, source: event.currentTarget };
          }}
          onPointerMove={move} onPointerUp={finish} onPointerCancel={cancelDrag} onLostPointerCapture={cancelDrag}
          onKeyDown={event => {
            if (!event.altKey || (event.key !== 'ArrowUp' && event.key !== 'ArrowDown')) return;
            event.preventDefault();
            if (drag.current || busy.current) return;
            const destination = index + (event.key === 'ArrowUp' ? -1 : 1);
            if (destination < 0 || destination >= workspaces.length) return;
            const ids = workspaces.map(w => w.id);
            [ids[index], ids[destination]] = [ids[destination], ids[index]];
            void saveOrder(ids);
          }}>{current ? <FolderOpen /> : <Folder />}<span>{workspace.name}</span></button>
        <button className="tree-rename icon-button" aria-label={`重命名工作区 ${workspace.name}`} title="重命名工作区" onClick={() => onRename(workspace.id)}><Pencil /></button>
        <button className="tree-add icon-button" aria-label={`在 ${workspace.name} 新建会话`} onClick={() => onCreate(workspace.id)}><Plus /></button>
      </div>;
    })}
  </div>;
}
