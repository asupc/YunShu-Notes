import { htmlToMarkdown } from './markdown';

export interface CanvasBlock {
  id: string;
  x: number;
  y: number;
  width: number;
  /** 0 表示高度随内容自动撑开；>0 表示手动调整后的最小高度 */
  minHeight: number;
  zIndex: number;
  html: string;
}

const CANVAS_MARKER = '<!--YUNSHU_CANVAS_V1-->';

export function createBlockId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `blk_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * 解析服务端保存的 contentHtml：
 * - 若包含云树画布标记，还原全部自由定位文本块；
 * - 若为旧版普通 HTML 或空笔记，自动无感迁移为画布上的第一个文本块。
 */
export function parseCanvasHtml(rawHtml: string, defaultWidth = 720): CanvasBlock[] {
  const safeDefaultW = Math.max(280, Math.round(defaultWidth));
  const trimmed = (rawHtml || '').trim();

  if (!trimmed) {
    return [
      {
        id: createBlockId(),
        x: 0,
        y: 0,
        width: safeDefaultW,
        minHeight: 0,
        zIndex: 1,
        html: '',
      },
    ];
  }

  try {
    const parser = new DOMParser();
    const doc = parser.parseFromString(trimmed, 'text/html');
    const canvasRoot = doc.querySelector('[data-yunshu-canvas="1"]');
    if (canvasRoot) {
      const sections = Array.from(canvasRoot.querySelectorAll(':scope > section[data-canvas-block="1"]'));
      if (sections.length > 0) {
        return sections.map((sec, idx) => {
          const x = Number.parseFloat(sec.getAttribute('data-x') || '0');
          const y = Number.parseFloat(sec.getAttribute('data-y') || '0');
          const w = Number.parseFloat(sec.getAttribute('data-w') || String(safeDefaultW));
          const h = Number.parseFloat(sec.getAttribute('data-h') || '0');
          const z = Number.parseInt(sec.getAttribute('data-z') || String(idx + 1), 10);
          return {
            id: sec.getAttribute('data-id') || createBlockId(),
            x: Number.isFinite(x) ? Math.max(0, Math.round(x)) : 0,
            y: Number.isFinite(y) ? Math.max(0, Math.round(y)) : 0,
            width: Number.isFinite(w) ? Math.max(180, Math.round(w)) : safeDefaultW,
            minHeight: Number.isFinite(h) ? Math.max(0, Math.round(h)) : 0,
            zIndex: Number.isFinite(z) ? z : idx + 1,
            html: sec.innerHTML,
          };
        });
      }
    }
  } catch {
    // fallback below
  }

  // 兼容已有普通笔记：作为首个全宽文本块无感承接
  return [
    {
      id: createBlockId(),
      x: 0,
      y: 0,
      width: safeDefaultW,
      minHeight: 0,
      zIndex: 1,
      html: trimmed,
    },
  ];
}

function escapeAttr(val: string): string {
  return val.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function sortBlocksReadingOrder(blocks: CanvasBlock[]): CanvasBlock[] {
  return [...blocks].sort((a, b) => {
    // 同一水平行（y 差值在 28px 以内）按从左到右排，否则按从上到下排
    if (Math.abs(a.y - b.y) > 28) return a.y - b.y;
    return a.x - b.x;
  });
}

function htmlToPlainText(html: string): string {
  if (!html) return '';
  try {
    const parser = new DOMParser();
    const doc = parser.parseFromString(html, 'text/html');
    return (doc.body.textContent || '').replace(/\s+\n/g, '\n').trim();
  } catch {
    return html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  }
}

export function serializeCanvasBlocks(blocks: CanvasBlock[]): {
  contentHtml: string;
  plainText: string;
} {
  const sections = blocks
    .map(
      (b) =>
        `<section data-canvas-block="1" data-id="${escapeAttr(b.id)}" data-x="${Math.round(b.x)}" data-y="${Math.round(b.y)}" data-w="${Math.round(b.width)}" data-h="${Math.round(b.minHeight)}" data-z="${Math.round(b.zIndex)}">${b.html}</section>`
    )
    .join('');

  const contentHtml = `${CANVAS_MARKER}<div data-yunshu-canvas="1">${sections}</div>`;
  const plainText = sortBlocksReadingOrder(blocks)
    .map((b) => htmlToPlainText(b.html))
    .filter(Boolean)
    .join('\n\n');

  return { contentHtml, plainText };
}

export function exportCanvasToMarkdown(title: string, blocks: CanvasBlock[]): string {
  const parts = sortBlocksReadingOrder(blocks)
    .map((b) => htmlToMarkdown(b.html).trim())
    .filter(Boolean);
  return `# ${title}\n\n${parts.join('\n\n')}\n`;
}
