import { type ReactNode } from 'react';

/**
 * Render the markdown the agents actually write.
 *
 * Every agent, the orchestrator and the console all write markdown - headings,
 * bold names, bullet lists, fenced code. All of it was being dumped into
 * `whitespace-pre-wrap`, so the most-read text in the platform showed up as
 * `## **Who Did What**` and `- **Alex (frontend-engineer)**:`. The content was
 * right and it read like a broken terminal.
 *
 * Built out of React elements rather than by setting innerHTML: this text comes
 * from a model, and a model that has read a repository can be talked into
 * emitting markup. Nothing here can inject a node the renderer did not create.
 * Deliberately small - the subset the fleet uses, not a spec-complete parser.
 */

/** Inline: `code`, **bold**, *italic*, [text](url). Applied in that order. */
function inline(text: string, keyPrefix: string): ReactNode[] {
  const out: ReactNode[] = [];
  const pattern = /(`[^`]+`)|(\*\*[^*]+\*\*)|(\*[^*\n]+\*)|(\[[^\]]+\]\([^)\s]+\))/g;
  let last = 0;
  let match: RegExpExecArray | null;
  let i = 0;

  while ((match = pattern.exec(text)) !== null) {
    if (match.index > last) out.push(text.slice(last, match.index));
    const token = match[0];
    const key = `${keyPrefix}-i${i++}`;

    if (token.startsWith('`')) {
      out.push(
        <code key={key} className="rounded bg-ink-800 px-1 py-0.5 font-mono text-[0.92em] text-ink-100">
          {token.slice(1, -1)}
        </code>,
      );
    } else if (token.startsWith('**')) {
      out.push(<strong key={key} className="font-semibold text-ink-100">{token.slice(2, -2)}</strong>);
    } else if (token.startsWith('[')) {
      const split = token.indexOf('](');
      const label = token.slice(1, split);
      const href = token.slice(split + 2, -1);
      // Only http(s). A model-authored javascript: or data: URL is not a link.
      const safe = /^https?:\/\//i.test(href);
      out.push(
        safe ? (
          <a key={key} href={href} target="_blank" rel="noreferrer noopener" className="text-signal-300 hover:underline">
            {label}
          </a>
        ) : (
          <span key={key}>{label}</span>
        ),
      );
    } else {
      out.push(<em key={key}>{token.slice(1, -1)}</em>);
    }
    last = match.index + token.length;
  }

  if (last < text.length) out.push(text.slice(last));
  return out;
}

const HEADING_SIZE = ['text-[16px]', 'text-[15px]', 'text-[14px]', 'text-[13px]'];

export default function Markdown({ children, className = '' }: { children: string; className?: string }) {
  const lines = (children ?? '').replace(/\r\n/g, '\n').split('\n');
  const blocks: ReactNode[] = [];

  // A list is accumulated across lines and flushed when the run ends, so
  // consecutive bullets become one <ul> rather than one per line.
  let list: { ordered: boolean; items: string[] } | null = null;
  let para: string[] = [];
  let code: { lang: string; lines: string[] } | null = null;
  let key = 0;

  const flushList = () => {
    if (!list) return;
    const { ordered, items } = list;
    const Tag = ordered ? 'ol' : 'ul';
    blocks.push(
      <Tag
        key={`b${key++}`}
        className={`my-1.5 space-y-1 pl-5 ${ordered ? 'list-decimal' : 'list-disc'} marker:text-ink-500`}
      >
        {items.map((item, n) => (
          <li key={n} className="leading-relaxed">{inline(item, `l${key}-${n}`)}</li>
        ))}
      </Tag>,
    );
    list = null;
  };

  const flushPara = () => {
    if (para.length === 0) return;
    blocks.push(
      <p key={`b${key++}`} className="my-1.5 leading-relaxed">{inline(para.join(' '), `p${key}`)}</p>,
    );
    para = [];
  };

  const flushAll = () => { flushList(); flushPara(); };

  for (const raw of lines) {
    // Inside a fence, everything is literal until the closing fence.
    if (code) {
      if (raw.trimStart().startsWith('```')) {
        blocks.push(
          <pre
            key={`b${key++}`}
            className="my-2 overflow-x-auto rounded-lg border border-ink-700 bg-ink-850 px-3 py-2 font-mono text-[12px] leading-relaxed text-ink-200"
          >
            <code>{code.lines.join('\n')}</code>
          </pre>,
        );
        code = null;
      } else {
        code.lines.push(raw);
      }
      continue;
    }

    const line = raw.trimEnd();

    if (line.trimStart().startsWith('```')) {
      flushAll();
      code = { lang: line.trim().slice(3), lines: [] };
      continue;
    }

    if (line.trim() === '') { flushAll(); continue; }

    // A horizontal rule; the agents use --- between sections.
    if (/^\s*(---+|\*\*\*+|___+)\s*$/.test(line)) {
      flushAll();
      blocks.push(<hr key={`b${key++}`} className="my-3 border-ink-700" />);
      continue;
    }

    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      flushAll();
      const level = heading[1].length;
      blocks.push(
        <div
          key={`b${key++}`}
          className={`mt-3 mb-1 font-semibold text-ink-100 first:mt-0 ${HEADING_SIZE[Math.min(level, 4) - 1]}`}
        >
          {inline(heading[2], `h${key}`)}
        </div>,
      );
      continue;
    }

    const quote = /^>\s?(.*)$/.exec(line);
    if (quote) {
      flushAll();
      blocks.push(
        <blockquote key={`b${key++}`} className="my-1.5 border-l-2 border-ink-600 pl-3 text-ink-300">
          {inline(quote[1], `q${key}`)}
        </blockquote>,
      );
      continue;
    }

    const bullet = /^\s*[-*+]\s+(.*)$/.exec(line);
    if (bullet) {
      flushPara();
      if (!list || list.ordered) { flushList(); list = { ordered: false, items: [] }; }
      list.items.push(bullet[1]);
      continue;
    }

    const numbered = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    if (numbered) {
      flushPara();
      if (!list || !list.ordered) { flushList(); list = { ordered: true, items: [] }; }
      list.items.push(numbered[1]);
      continue;
    }

    // A continuation line of the item above keeps its bullet.
    if (list && /^\s{2,}\S/.test(raw)) {
      list.items[list.items.length - 1] += ` ${line.trim()}`;
      continue;
    }

    flushList();
    para.push(line.trim());
  }

  flushAll();
  if (code) {
    // An unterminated fence - a reply cut off mid-block. Show what arrived.
    blocks.push(
      <pre key={`b${key++}`} className="my-2 overflow-x-auto rounded-lg border border-ink-700 bg-ink-850 px-3 py-2 font-mono text-[12px] text-ink-200">
        <code>{code.lines.join('\n')}</code>
      </pre>,
    );
  }

  return <div className={`text-ink-200 [&>*:first-child]:mt-0 ${className}`}>{blocks}</div>;
}
