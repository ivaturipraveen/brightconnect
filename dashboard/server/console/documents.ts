/**
 * Document generation: PDF, Word and PowerPoint.
 *
 * These produce something for a person to read - a summary, a one-pager, a
 * deck - rather than a change to the product, so they run straight from the
 * console instead of going through a mission and its review gates.
 *
 * Content comes in as markdown because that is what a model writes well; the
 * structure that survives into each format is headings, paragraphs and bullets.
 */
import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { mkdirSync, createWriteStream } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { nanoid } from 'nanoid';
import { Document, HeadingLevel, Packer, Paragraph, TextRun } from 'docx';
import PptxGenJSDefault from 'pptxgenjs';
import PDFDocument from 'pdfkit';
import { config } from '../config.ts';

const text = (s: string) => ({ content: [{ type: 'text' as const, text: s }] });

export const DOCUMENTS_DIR = join(config.paths.data, 'documents');
mkdirSync(DOCUMENTS_DIR, { recursive: true });

/**
 * pptxgenjs ships CommonJS with an `exports.types` entry that NodeNext resolves
 * as a namespace rather than the class, so TypeScript refuses `new` on it even
 * though the default export is constructable at runtime (verified: typeof is
 * 'function'). The cast is to the shape the library actually has.
 */
const PptxGenJS = PptxGenJSDefault as unknown as {
  new (): {
    layout: string;
    addSlide(): any;
    write(opts: { outputType: 'nodebuffer' }): Promise<unknown>;
  };
};

/** A filename that is safe on disk and still recognisable to the reader. */
function safeName(title: string, extension: string): string {
  const stem = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 60) || 'document';
  return `${stem}-${nanoid(6)}.${extension}`;
}

type Block =
  | { kind: 'heading'; level: 1 | 2 | 3; text: string }
  | { kind: 'bullet'; text: string }
  | { kind: 'paragraph'; text: string };

/** Enough markdown for a readable document: headings, bullets, paragraphs. */
function parseMarkdown(markdown: string): Block[] {
  const blocks: Block[] = [];
  for (const line of markdown.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const heading = trimmed.match(/^(#{1,3})\s+(.*)$/);
    if (heading) {
      blocks.push({ kind: 'heading', level: heading[1].length as 1 | 2 | 3, text: strip(heading[2]) });
      continue;
    }
    const bullet = trimmed.match(/^[-*]\s+(.*)$/);
    if (bullet) {
      blocks.push({ kind: 'bullet', text: strip(bullet[1]) });
      continue;
    }
    blocks.push({ kind: 'paragraph', text: strip(trimmed) });
  }
  return blocks;
}

/** Inline markers are noise once the format carries the styling. */
const strip = (s: string) => s.replace(/\*\*(.+?)\*\*/g, '$1').replace(/`(.+?)`/g, '$1');

/** The URL the dashboard serves this document from. */
const urlFor = (file: string) => `/api/console/documents/${file}`;

export async function writePdf(title: string, markdown: string): Promise<string> {
  const file = safeName(title, 'pdf');
  const path = join(DOCUMENTS_DIR, file);

  await new Promise<void>((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 64, info: { Title: title } });
    const out = createWriteStream(path);
    doc.pipe(out);
    out.on('finish', resolve);
    out.on('error', reject);

    doc.fontSize(22).font('Helvetica-Bold').text(title, { align: 'left' });
    doc.moveDown(1);

    for (const block of parseMarkdown(markdown)) {
      if (block.kind === 'heading') {
        doc.moveDown(0.6);
        doc.fontSize(block.level === 1 ? 16 : block.level === 2 ? 14 : 12)
          .font('Helvetica-Bold')
          .text(block.text);
        doc.moveDown(0.3);
      } else if (block.kind === 'bullet') {
        doc.fontSize(11).font('Helvetica').text(`\u2022  ${block.text}`, { indent: 12, lineGap: 2 });
      } else {
        doc.fontSize(11).font('Helvetica').text(block.text, { lineGap: 2 });
        doc.moveDown(0.4);
      }
    }
    doc.end();
  });
  return file;
}

export async function writeDocx(title: string, markdown: string): Promise<string> {
  const children: Paragraph[] = [new Paragraph({ text: title, heading: HeadingLevel.TITLE })];
  const levels = {
    1: HeadingLevel.HEADING_1,
    2: HeadingLevel.HEADING_2,
    3: HeadingLevel.HEADING_3,
  } as const;

  for (const block of parseMarkdown(markdown)) {
    if (block.kind === 'heading') {
      children.push(new Paragraph({ text: block.text, heading: levels[block.level] }));
    } else if (block.kind === 'bullet') {
      children.push(new Paragraph({ text: block.text, bullet: { level: 0 } }));
    } else {
      children.push(new Paragraph({ children: [new TextRun(block.text)], spacing: { after: 140 } }));
    }
  }

  const file = safeName(title, 'docx');
  await writeFile(
    join(DOCUMENTS_DIR, file),
    await Packer.toBuffer(new Document({ sections: [{ children }] })),
  );
  return file;
}

export async function writePptx(
  title: string,
  subtitle: string | undefined,
  slides: Array<{ title: string; bullets: string[] }>,
): Promise<string> {
  const deck = new PptxGenJS();
  deck.layout = 'LAYOUT_16x9';

  const cover = deck.addSlide();
  cover.background = { color: '0B0E14' };
  cover.addText(title, { x: 0.6, y: 2.1, w: 8.8, h: 1.0, fontSize: 36, bold: true, color: 'FFFFFF' });
  if (subtitle) {
    cover.addText(subtitle, { x: 0.6, y: 3.1, w: 8.8, h: 0.6, fontSize: 16, color: '9AA3AF' });
  }

  for (const s of slides) {
    const slide = deck.addSlide();
    slide.addText(s.title, { x: 0.6, y: 0.5, w: 8.8, h: 0.8, fontSize: 26, bold: true, color: '17191C' });
    if (s.bullets.length) {
      slide.addText(
        s.bullets.map((b) => ({ text: b, options: { bullet: true, breakLine: true } })),
        { x: 0.8, y: 1.5, w: 8.4, h: 3.6, fontSize: 15, color: '3C4658', lineSpacingMultiple: 1.3 },
      );
    }
  }

  const file = safeName(title, 'pptx');
  // pptxgenjs types its nodebuffer return loosely; it is a Buffer at runtime.
  const buffer = (await deck.write({ outputType: 'nodebuffer' })) as unknown as Buffer;
  await writeFile(join(DOCUMENTS_DIR, file), buffer);
  return file;
}

export function createDocumentServer(_scratchDir: string) {
  const generatePdf = tool(
    'generate_pdf',
    'Produce a PDF from markdown. Use for reports, summaries and one-pagers.',
    {
      title: z.string().describe('Document title, shown on the first page.'),
      markdown: z.string().describe('Body as markdown: # headings, - bullets, and paragraphs.'),
    },
    async ({ title, markdown }) => {
      const file = await writePdf(title, markdown);
      return text(`DOCUMENT_READY ${file} ${urlFor(file)}
PDF written: "${title}".`);
    },
  );

  const generateDocx = tool(
    'generate_docx',
    'Produce a Word document from markdown. Use when the reader will edit it.',
    {
      title: z.string().describe('Document title.'),
      markdown: z.string().describe('Body as markdown: # headings, - bullets, and paragraphs.'),
    },
    async ({ title, markdown }) => {
      const file = await writeDocx(title, markdown);
      return text(`DOCUMENT_READY ${file} ${urlFor(file)}
Word document written: "${title}".`);
    },
  );

  const generatePptx = tool(
    'generate_pptx',
    'Produce a PowerPoint deck. Give each slide a title and its bullet points.',
    {
      title: z.string().describe('Deck title, used for the opening slide.'),
      subtitle: z.string().optional().describe('Optional line under the deck title.'),
      slides: z.array(
        z.object({
          title: z.string(),
          bullets: z.array(z.string()).describe('Points on this slide. Keep them short - a slide is not a paragraph.'),
        }),
      ).min(1).describe('The content slides, in order.'),
    },
    async ({ title, subtitle, slides }) => {
      const file = await writePptx(title, subtitle, slides);
      return text(
        `DOCUMENT_READY ${file} ${urlFor(file)}
Deck written: "${title}" (${slides.length + 1} slides).`,
      );
    },
  );

  return createSdkMcpServer({
    name: 'documents',
    version: '1.0.0',
    instructions: 'Produce PDF, Word and PowerPoint files for a person to read.',
    tools: [generatePdf, generateDocx, generatePptx],
  });
}
