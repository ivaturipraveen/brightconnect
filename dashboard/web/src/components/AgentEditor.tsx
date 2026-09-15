import { useEffect, useState } from 'react';
import { api } from '../lib/api.ts';
import { Badge, Button } from './ui.tsx';

/**
 * Editor for one agent's definition, and for the orchestrator's brief.
 *
 * Opens read-only. Changing a prompt changes how the fleet behaves on the next
 * mission, so it takes a deliberate second action rather than a stray click in
 * a textarea - people open these to read them far more often than to change
 * them.
 *
 * It edits the raw Claude Code agent file - YAML frontmatter plus the prompt
 * body - because that is the artifact, and hiding it behind form fields would
 * make the tool list impossible to change. Saves are validated server-side
 * first: a prompt editor that can leave the fleet broken is worse than none,
 * particularly shortly before a demo.
 */
export default function PromptEditor({
  agentId, onClose, onSaved,
}: { agentId: string; onClose: () => void; onSaved: () => void }) {
  const isOrchestrator = agentId === 'orchestrator';

  const [content, setContent] = useState('');
  const [original, setOriginal] = useState('');
  const [name, setName] = useState(agentId);
  const [placeholders, setPlaceholders] = useState<Array<{ token: string; describes: string }>>([]);
  const [status, setStatus] = useState<'loading' | 'ready' | 'saving'>('loading');
  const [editable, setEditable] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    let alive = true;
    const load = isOrchestrator
      ? api.orchestratorPrompt().then((f) => {
          if (!alive) return;
          setContent(f.content);
          setOriginal(f.content);
          setName(`${f.name} · ${f.title}`);
          setPlaceholders([...f.placeholders]);
        })
      : api.agentFile(agentId).then((f) => {
          if (!alive) return;
          setContent(f.content);
          setOriginal(f.content);
          setName(f.member.name);
        });
    void load.then(() => alive && setStatus('ready')).catch((e) => alive && setError(String(e)));
    return () => { alive = false; };
  }, [agentId, isOrchestrator]);

  // Validate as you pause, so a broken edit is visible before save.
  useEffect(() => {
    if (status !== 'ready' || !editable || content === original) return;
    const t = setTimeout(() => {
      const check = isOrchestrator
        ? api.validateOrchestrator(content)
        : api.validateAgent(agentId, content);
      void check.then((r) => setError(r.ok ? null : (r.error ?? 'Invalid'))).catch(() => {});
    }, 500);
    return () => clearTimeout(t);
  }, [content, original, agentId, status, editable, isOrchestrator]);

  const dirty = content !== original;

  const save = async () => {
    setStatus('saving');
    try {
      if (isOrchestrator) {
        await api.saveOrchestratorPrompt(content);
      } else {
        const res = await api.saveAgent(agentId, content);
        setName(res.name);
      }
      setOriginal(content);
      setError(null);
      setSaved(true);
      setEditable(false);
      setTimeout(() => setSaved(false), 2500);
      onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setStatus('ready');
    }
  };

  const discard = () => {
    setContent(original);
    setError(null);
    setEditable(false);
  };

  // Closing with unsaved work is the one thing worth interrupting for.
  const close = () => {
    if (dirty && !window.confirm('Discard your unsaved changes to this prompt?')) return;
    onClose();
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-stretch justify-end bg-ink-100/30 backdrop-blur-sm"
      onClick={close}
    >
      <div
        className="flex h-full w-full max-w-3xl flex-col border-l border-ink-700 bg-ink-900 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex flex-wrap items-center gap-2 border-b border-ink-700 px-4 py-3">
          <div className="min-w-0">
            <div className="text-[15px] font-semibold text-ink-100">{name}</div>
            <div className="font-mono text-[11px] text-ink-500">
              {isOrchestrator ? 'orchestrator/orchestrator.md' : `.claude/agents/${agentId}.md`}
            </div>
          </div>
          <div className="ml-auto flex items-center gap-2">
            {saved && <Badge tone="ok">saved</Badge>}
            {!editable && !saved && <Badge tone="info">read only</Badge>}
            {editable && dirty && <Badge tone="warn">unsaved</Badge>}
            {editable ? (
              <>
                <Button variant="ghost" onClick={discard}>Cancel</Button>
                <Button
                  variant="primary"
                  disabled={!dirty || !!error || status === 'saving'}
                  onClick={save}
                >
                  {status === 'saving' ? 'Saving…' : 'Save'}
                </Button>
              </>
            ) : (
              <>
                <Button variant="ghost" onClick={close}>Close</Button>
                <Button
                  variant="primary"
                  disabled={status !== 'ready'}
                  onClick={() => setEditable(true)}
                >
                  Edit prompt
                </Button>
              </>
            )}
          </div>
        </header>

        {error && (
          <div className="border-b border-crit-500/30 bg-crit-500/10 px-4 py-2 text-[12px] text-crit-400">
            {error}
          </div>
        )}

        {isOrchestrator && placeholders.length > 0 && (
          <div className="border-b border-ink-700 bg-ink-850/60 px-4 py-2">
            <div className="text-[11px] font-medium uppercase tracking-wide text-ink-400">
              Generated sections
            </div>
            <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1">
              {placeholders.map((p) => (
                <span key={p.token} className="text-[11px] text-ink-500">
                  <code className="rounded bg-ink-800 px-1 font-mono text-ink-300">{p.token}</code>{' '}
                  {p.describes}
                </span>
              ))}
            </div>
          </div>
        )}

        <textarea
          value={content}
          readOnly={!editable}
          onChange={(e) => { setContent(e.target.value); setSaved(false); }}
          spellCheck={false}
          className={`flex-1 resize-none px-4 py-3 font-mono text-[12px] leading-relaxed focus:outline-none ${
            editable ? 'bg-ink-850 text-ink-200' : 'bg-ink-900 text-ink-300'
          }`}
          placeholder={status === 'loading' ? 'Loading…' : ''}
        />

        <footer className="border-t border-ink-700 px-4 py-2 text-[11px] leading-relaxed text-ink-400">
          {isOrchestrator ? (
            <>
              The orchestrator's brief. The placeholders above are filled in from the live fleet,
              so a new agent appears in its roster without anyone editing this.
            </>
          ) : (
            <>
              Frontmatter sets the agent's tools; everything below the second
              <code className="mx-1 rounded bg-ink-800 px-1 font-mono">---</code> is its system
              prompt. The model is one setting for the whole platform, on the fleet page.
            </>
          )}{' '}
          Saved changes apply to the <strong className="text-ink-200">next mission</strong> — running
          missions keep the definitions they started with.
        </footer>
      </div>
    </div>
  );
}
