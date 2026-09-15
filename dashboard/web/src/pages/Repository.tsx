import { useEffect, useState } from 'react';
import {
  api, type CommitDetail, type DiffFile, type PullDetail, type RepoCommit, type RepoPull,
} from '../lib/api.ts';
import { Badge, Empty, Panel, relTime } from '../components/ui.tsx';
import Markdown from '../components/Markdown.tsx';

/**
 * What the fleet has actually landed: pull requests it opened and commits on
 * the branch. List on the left, the diff on the right - the same shape as
 * reading a change anywhere else, because that is what people already know.
 */
export default function Repository() {
  const [tab, setTab] = useState<'pulls' | 'commits'>('pulls');
  const [pulls, setPulls] = useState<RepoPull[]>([]);
  const [commits, setCommits] = useState<RepoCommit[]>([]);
  const [configured, setConfigured] = useState(true);
  const [selected, setSelected] = useState<string | null>(null);
  const [detail, setDetail] = useState<PullDetail | CommitDetail | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    void api.pulls().then((r) => { setPulls(r.pulls); setConfigured(r.configured); }).catch(() => {});
    void api.commits().then((r) => setCommits(r.commits)).catch(() => {});
  }, []);

  const open = async (key: string) => {
    setSelected(key);
    setDetail(null);
    setLoading(true);
    try {
      setDetail(
        tab === 'pulls' ? await api.pull(Number(key)) : await api.commit(key),
      );
    } catch {
      setDetail(null);
    } finally {
      setLoading(false);
    }
  };

  const switchTab = (t: 'pulls' | 'commits') => {
    setTab(t);
    setSelected(null);
    setDetail(null);
  };

  if (!configured) {
    return (
      <Panel title="Repository">
        <Empty>
          No GitHub token configured, so pull requests and commits cannot be read.
        </Empty>
      </Panel>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col gap-4">
      <div className="shrink-0">
        <h1 className="text-xl font-semibold text-ink-100">Repository</h1>
        <p className="mt-0.5 max-w-3xl text-[13px] text-ink-400">
          What the fleet has opened and what has landed. Select a pull request or a commit to
          read its diff, file by file.
        </p>
      </div>

      <Panel
        title={
          <div className="flex items-center gap-1">
            {([['pulls', `Pull requests${pulls.length ? ` (${pulls.length})` : ''}`],
               ['commits', `Commits${commits.length ? ` (${commits.length})` : ''}`]] as const).map(([id, label]) => (
              <button
                key={id}
                onClick={() => switchTab(id)}
                className={`rounded px-2 py-0.5 text-[12px] font-semibold uppercase tracking-wide transition-colors ${
                  tab === id ? 'bg-ink-800 text-ink-100' : 'text-ink-400 hover:text-ink-200'
                }`}
              >
                {label}
              </button>
            ))}
          </div>
        }
        dense
        className="min-h-0 flex-1"
        actions={<span className="text-[11px] text-ink-500">Select one to see the diff</span>}
      >
        <div className="grid min-h-0 flex-1 grid-cols-1 lg:grid-cols-[320px_minmax(0,1fr)]">
          <ul className="min-h-0 divide-y divide-ink-800 overflow-y-auto border-ink-700 lg:border-r">
            {(tab === 'pulls' ? pulls : commits).length === 0 ? (
              <li className="p-4"><Empty>Nothing yet.</Empty></li>
            ) : tab === 'pulls' ? (
              pulls.map((p) => (
                <li key={p.number}>
                  <button
                    onClick={() => void open(String(p.number))}
                    className={`w-full px-3 py-2.5 text-left transition-colors hover:bg-ink-850 ${
                      selected === String(p.number) ? 'border-l-2 border-signal-500 bg-ink-850' : ''
                    }`}
                  >
                    <div className="flex items-center gap-2">
                      <Badge tone={p.state === 'merged' ? 'think' : p.state === 'open' ? 'ok' : 'neutral'}>
                        {p.state}
                      </Badge>
                      <span className="font-mono text-[11px] text-ink-500">#{p.number}</span>
                      <span className="ml-auto text-[10px] text-ink-500">{relTime(p.createdAt)}</span>
                    </div>
                    <div className="mt-1 line-clamp-2 text-[12.5px] leading-snug text-ink-100">{p.title}</div>
                    <div className="mt-0.5 truncate font-mono text-[10px] text-ink-500">
                      {p.branch} → {p.base}
                    </div>
                  </button>
                </li>
              ))
            ) : (
              commits.map((c) => (
                <li key={c.sha}>
                  <button
                    onClick={() => void open(c.sha)}
                    className={`w-full px-3 py-2.5 text-left transition-colors hover:bg-ink-850 ${
                      selected === c.sha ? 'border-l-2 border-signal-500 bg-ink-850' : ''
                    }`}
                  >
                    <div className="line-clamp-2 text-[12.5px] leading-snug text-ink-100">{c.message}</div>
                    <div className="mt-1 flex items-center gap-2">
                      <code className="rounded bg-ink-800 px-1 py-px font-mono text-[10px] text-ink-400">
                        {c.sha.slice(0, 7)}
                      </code>
                      <span className="truncate text-[10px] text-ink-500">{c.author}</span>
                      <span className="ml-auto shrink-0 text-[10px] text-ink-500">
                        {c.date ? relTime(c.date) : ''}
                      </span>
                    </div>
                  </button>
                </li>
              ))
            )}
          </ul>

          <div className="min-h-0 overflow-y-auto">
            {!selected ? (
              <div className="grid h-full place-items-center p-6 text-center text-[12px] text-ink-500">
                Select {tab === 'pulls' ? 'a pull request' : 'a commit'} to see what changed.
              </div>
            ) : loading ? (
              <div className="grid h-full place-items-center text-[12px] text-ink-500">Loading…</div>
            ) : !detail ? (
              <div className="grid h-full place-items-center text-[12px] text-crit-400">
                Could not load that.
              </div>
            ) : (
              <DetailView detail={detail} />
            )}
          </div>
        </div>
      </Panel>
    </div>
  );
}

function DetailView({ detail }: { detail: PullDetail | CommitDetail }) {
  const isPull = 'number' in detail;
  const files = detail.files ?? [];
  const adds = files.reduce((n, f) => n + f.additions, 0);
  const dels = files.reduce((n, f) => n + f.deletions, 0);

  return (
    <div>
      <header className="border-b border-ink-700 px-4 py-3">
        <h2 className="text-[15px] font-semibold text-ink-100">
          {isPull ? detail.title : detail.message.split('\n')[0]}
        </h2>
        <div className="mt-1.5 flex flex-wrap items-center gap-2 text-[11px] text-ink-400">
          {isPull ? (
            <>
              <Badge tone={detail.state === 'merged' ? 'think' : detail.state === 'open' ? 'ok' : 'neutral'}>
                {detail.state}
              </Badge>
              <span className="font-mono">#{detail.number}</span>
              <span className="font-mono">{detail.branch} → {detail.base}</span>
            </>
          ) : (
            <code className="rounded bg-ink-800 px-1.5 py-0.5 font-mono text-[11px] text-ink-300">
              {detail.sha.slice(0, 10)}
            </code>
          )}
          <span>{detail.author}</span>
          <span>{relTime(isPull ? detail.createdAt : detail.date)}</span>
          <span className="ml-auto font-mono">
            <span className="text-ok-400">+{adds}</span>{' '}
            <span className="text-crit-400">−{dels}</span>{' '}
            <span className="text-ink-500">· {files.length} file{files.length === 1 ? '' : 's'}</span>
          </span>
          <a href={detail.url} target="_blank" rel="noreferrer" className="text-signal-300 hover:underline">
            open on GitHub →
          </a>
        </div>
        {isPull && detail.body && (
          <div className="mt-2.5 max-h-40 overflow-y-auto">
            <Markdown className="text-[12px] text-ink-300">{detail.body}</Markdown>
          </div>
        )}
      </header>

      {files.length === 0 ? (
        <div className="p-6 text-center text-[12px] text-ink-500">No file changes recorded.</div>
      ) : (
        files.map((f) => <FileDiff key={f.filename} file={f} />)
      )}
    </div>
  );
}

function FileDiff({ file }: { file: DiffFile }) {
  const [open, setOpen] = useState(true);
  return (
    <section className="border-b border-ink-800">
      <button
        onClick={() => setOpen(!open)}
        className="flex w-full items-center gap-2 bg-ink-850 px-4 py-2 text-left hover:bg-ink-800"
      >
        <span className="text-[10px] text-ink-500">{open ? '▾' : '▸'}</span>
        <span className="truncate font-mono text-[11.5px] text-ink-200">{file.filename}</span>
        <Badge tone={file.status === 'added' ? 'ok' : file.status === 'removed' ? 'crit' : 'neutral'}>
          {file.status}
        </Badge>
        <span className="ml-auto shrink-0 font-mono text-[10px]">
          <span className="text-ok-400">+{file.additions}</span>{' '}
          <span className="text-crit-400">−{file.deletions}</span>
        </span>
      </button>
      {open && (
        file.patch ? (
          <pre className="overflow-x-auto px-0 py-1 font-mono text-[11px] leading-[1.55]">
            {file.patch.split('\n').map((line, i) => {
              const kind =
                line.startsWith('+') && !line.startsWith('+++') ? 'add'
                : line.startsWith('-') && !line.startsWith('---') ? 'del'
                : line.startsWith('@@') ? 'hunk'
                : 'ctx';
              return (
                <div
                  key={i}
                  className={`px-4 ${
                    kind === 'add' ? 'bg-ok-500/10 text-ok-400'
                    : kind === 'del' ? 'bg-crit-500/10 text-crit-400'
                    : kind === 'hunk' ? 'bg-signal-500/10 text-signal-300'
                    : 'text-ink-400'
                  }`}
                >
                  {line || ' '}
                </div>
              );
            })}
          </pre>
        ) : (
          <div className="px-4 py-3 text-[11px] text-ink-500">
            No inline diff available — the file is binary or too large.
          </div>
        )
      )}
    </section>
  );
}
