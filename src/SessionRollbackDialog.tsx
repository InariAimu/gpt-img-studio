import { useEffect, useState } from 'react';
import { LoaderCircle, RotateCcw } from 'lucide-react';
import { Modal } from './components';
import type { SessionRollbackPreview } from './types';
import type { Studio } from './useStudio';

export default function SessionRollbackDialog({ studio, sessionId, assetId, round, onClose, onRolledBack }: {
  studio: Studio;
  sessionId: string;
  assetId: string;
  round: number;
  onClose: () => void;
  onRolledBack: () => void;
}) {
  const [preview, setPreview] = useState<SessionRollbackPreview>();
  const [attempt, setAttempt] = useState(0);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const { previewSessionRollback, rollbackSession } = studio;

  useEffect(() => {
    let active = true;
    queueMicrotask(() => {
      if (!active) return;
      void previewSessionRollback(sessionId, assetId).then(
        value => { if (active) setPreview(value); },
        error => { if (active) setError(String(error)); },
      );
    });
    return () => { active = false; };
  }, [sessionId, assetId, attempt, previewSessionRollback]);

  async function confirm() {
    if (!preview || saving) return;
    setSaving(true);
    try {
      await rollbackSession(sessionId, assetId, preview.token);
      onRolledBack();
    } catch (error) {
      setPreview(undefined);
      setError(String(error));
    } finally {
      setSaving(false);
    }
  }

  return <Modal title={`回退到第 ${round} 轮`} onClose={() => { if (!saving) onClose(); }}>
    <form onSubmit={event => { event.preventDefault(); void confirm(); }}>
      <div className="modal-content">
        {!preview && !error && <p role="status" className="delete-session-notice"><LoaderCircle size={14} className="spin" />正在检查轮次和图片引用…</p>}
        {preview && <>
          <p className="modal-description">保留第 {round} 轮及之前的内容，将之后 {preview.removedTurnCount} 轮的对话记录和 {preview.removedResultCount} 张生成图片移入系统回收站。</p>
          {preview.preservedResultCount > 0 && <p className="delete-session-notice">另有 {preview.preservedResultCount} 张仍在使用的图片会保留为参考素材。</p>}
          <p className="delete-session-notice">{preview.hasResponse ? '回退后可在原会话输入新 Prompt，接续保留的结果。' : '这一轮没有 Responses 上下文，可以选用保留的图片作为参考图继续创作。'}</p>
        </>}
        {error && <div role="alert"><p className="option-error">{error}</p><button type="button" className="button secondary small" onClick={() => { setError(''); setAttempt(value => value + 1); }}>重新检查</button></div>}
      </div>
      <footer className="modal-footer">
        <button type="button" className="button secondary" disabled={saving} onClick={onClose}>取消</button>
        <button type="submit" className="button danger" disabled={!preview || saving}>{saving ? <LoaderCircle className="spin" /> : <RotateCcw />}{saving ? '正在回退' : '确认回退'}</button>
      </footer>
    </form>
  </Modal>;
}
