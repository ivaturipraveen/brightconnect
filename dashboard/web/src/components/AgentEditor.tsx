import { useEffect, useState } from 'react';
import { api } from '../lib/api.ts';
import { Badge, Button } from './ui.tsx';

/**
 * Editor for one agent's definition file.
 *
 * Edits the raw Claude Code agent file - YAML frontmatter plus the prompt body -
 * because that is the artifact, and hiding it behind form fields would make the
 * tool list and model impossible to change. Saves are validated server-side
 * first: a prompt editor that can leave the fleet broken is worse than none,
 * particularly shortly before a demo.
 */
export default function AgentEditor({
  agentId, onClose, onSaved,
}: { agentId: string; onClose: () => void; onSaved: () => void }) {
  const [content, setContent] = useState('');
  const [original, setOriginal] = useState('');
  const [name, setName] = useState(agentId);
  const [status, setStatus] = useState<'loading' | 'ready' | 'saving'>('loading');
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    let alive = true;
    void api
      .agentFile(agentId)
      .then((f) => {
        if (!alive) return;
        setContent(f.content);
        setOriginal(f.content);
        setName(f.member.name);
        setStatus('ready');
      })
      .catch((e) => alive && setError(String(e)));
    return () => { alive = false; };
  }, [agentId]);

  // Validate as you pause, so a broken frontmatter block is visible before save.
  useEffect(() => {
    if (status !== 'ready' || content === original) return;
    const t = setTimeout(() => {
      void api
        .validateAgent(agentId, content)
        .then((r) => setError(r.ok ? null : (r.error ?? 'Invalid')))
        .catch(() => {});
    }, 500);
    return () => clearTimeout(t);
  }, [content, original, agentId, status]);

  const dirty = content !== original;

  const save = async () => {
    setStatus('saving');
    try {
      const res = await api.saveAgent(agentId, content);
      setOriginal(content);
      setName(res.name);
      setError(null);
      setSaved(true);
      setTimeout(() => setSaved(false), 2500);
      onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setStatus('ready');
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-stretch justify-end bg-black/60 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="flex h-full w-full max-w-3xl flex-col border-l border-ink-700 bg-ink-900 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex flex-wrap items-center gap-2 border-b border-ink-700 px-4 py-3">
          <div className="min-w-0">
            <div className="text-[15px] font-semibold text-ink-100">{name}</div>
            <div className="font-mono text-[11px] text-ink-500">.claude/agents/{agentId}.md</div>
          </div>
          <div className="ml-auto flex items-center gap-2">
            {saved && <Badge tone="ok">saved</Badge>}
            {dirty && !saved && <Badge tone="warn">unsaved</Badge>}
            <Button variant="ghost" onClick={onClose}>Close</Button>
            <Button
              variant="primary"
              disabled={!dirty || !!error || status === 'saving'}
              onClick={save}
            >
              {status === 'saving' ? 'Saving…' : 'Save'}
            </Button>
          </div>
        </header>

        {error && (
          <div className="border-b border-crit-500/30 bg-crit-500/10 px-4 py-2 text-[12px] text-crit-400">
            {error}
          </div>
        )}

        <textarea
          value={content}
          onChange={(e) => { setContent(e.target.value); setSaved(false); }}
          spellCheck={false}
          className="flex-1 resize-none bg-ink-950 px-4 py-3 font-mono text-[12px] leading-relaxed text-ink-200 focus:outline-none"
          placeholder={status === 'loading' ? 'Loading…' : ''}
        />

        <footer className="border-t border-ink-700 px-4 py-2 text-[11px] leading-relaxed text-ink-400">
          Frontmatter sets the agent's tools and model; everything below the second
          <code className="mx-1 rounded bg-ink-800 px-1 font-mono">---</code> is its system prompt.
          Saved changes apply to the <strong className="text-ink-200">next mission</strong> — running
          missions keep the definitions they started with.
        </footer>
      </div>
    </div>
  );
}
