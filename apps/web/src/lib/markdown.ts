/**
 * 轻量 Markdown ↔ HTML 转换器（支持标题、列表、代码块与 Markdown 管道表格）
 */
function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function isTableSeparator(line: string): boolean {
  return /^\s*\|?(\s*:?-{3,}:?\s*\|)+\s*:?-{3,}:?\s*\|?\s*$/.test(line);
}

function splitTableRow(line: string): string[] {
  const trimmed = line.trim().replace(/^\|/, '').replace(/\|$/, '');
  return trimmed.split('|').map((cell) => cell.trim());
}

export function markdownToHtml(md: string): string {
  const lines = md.replace(/\r\n/g, '\n').split('\n');
  const out: string[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // 代码块 ```
    if (line.trim().startsWith('```')) {
      const codeLines: string[] = [];
      i += 1;
      while (i < lines.length && !lines[i].trim().startsWith('```')) {
        codeLines.push(lines[i]);
        i += 1;
      }
      out.push(`<pre><code>${escapeHtml(codeLines.join('\n'))}</code></pre>`);
      i += 1;
      continue;
    }

    // Markdown 表格：表头行 + 分隔行
    if (line.includes('|') && i + 1 < lines.length && isTableSeparator(lines[i + 1])) {
      const headers = splitTableRow(line);
      i += 2;
      const bodyRows: string[][] = [];
      while (i < lines.length && lines[i].includes('|') && lines[i].trim() !== '') {
        bodyRows.push(splitTableRow(lines[i]));
        i += 1;
      }
      const thead = `<tr>${headers.map((h) => `<th><p>${escapeHtml(h)}</p></th>`).join('')}</tr>`;
      const tbody = bodyRows
        .map(
          (row) =>
            `<tr>${headers
              .map((_, idx) => `<td><p>${escapeHtml(row[idx] ?? '')}</p></td>`)
              .join('')}</tr>`
        )
        .join('');
      out.push(`<table><tbody>${thead}${tbody}</tbody></table>`);
      continue;
    }

    // 标题
    const hMatch = line.match(/^(#{1,3})\s+(.*)$/);
    if (hMatch) {
      const level = hMatch[1].length;
      out.push(`<h${level}>${escapeHtml(hMatch[2])}</h${level}>`);
      i += 1;
      continue;
    }

    // 无序列表
    if (/^\s*[-*]\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) {
        items.push(`<li><p>${escapeHtml(lines[i].replace(/^\s*[-*]\s+/, ''))}</p></li>`);
        i += 1;
      }
      out.push(`<ul>${items.join('')}</ul>`);
      continue;
    }

    if (line.trim() === '') {
      i += 1;
      continue;
    }

    out.push(`<p>${escapeHtml(line)}</p>`);
    i += 1;
  }

  return out.join('');
}

export function htmlToMarkdown(html: string): string {
  const parser = new DOMParser();
  const doc = parser.parseFromString(html, 'text/html');
  const lines: string[] = [];

  const walk = (node: ChildNode) => {
    if (node.nodeType === Node.TEXT_NODE) {
      const t = node.textContent?.trim();
      if (t) lines.push(t);
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    const el = node as HTMLElement;
    const tag = el.tagName.toLowerCase();

    if (tag === 'h1') {
      lines.push(`# ${el.textContent?.trim() ?? ''}`, '');
    } else if (tag === 'h2') {
      lines.push(`## ${el.textContent?.trim() ?? ''}`, '');
    } else if (tag === 'h3') {
      lines.push(`### ${el.textContent?.trim() ?? ''}`, '');
    } else if (tag === 'pre') {
      lines.push('```', el.textContent ?? '', '```', '');
    } else if (tag === 'ul') {
      el.querySelectorAll(':scope > li').forEach((li) => {
        const checked = li.getAttribute('data-checked');
        if (checked === 'true') lines.push(`- [x] ${li.textContent?.trim() ?? ''}`);
        else if (checked === 'false') lines.push(`- [ ] ${li.textContent?.trim() ?? ''}`);
        else lines.push(`- ${li.textContent?.trim() ?? ''}`);
      });
      lines.push('');
    } else if (tag === 'ol') {
      el.querySelectorAll(':scope > li').forEach((li, idx) => {
        lines.push(`${idx + 1}. ${li.textContent?.trim() ?? ''}`);
      });
      lines.push('');
    } else if (tag === 'table') {
      const rows = Array.from(el.querySelectorAll('tr'));
      if (rows.length > 0) {
        rows.forEach((tr, rowIdx) => {
          const cells = Array.from(tr.querySelectorAll('th, td')).map((c) =>
            (c.textContent ?? '').replace(/\s+/g, ' ').replace(/\|/g, '\\|').trim()
          );
          lines.push(`| ${cells.join(' | ')} |`);
          if (rowIdx === 0) {
            lines.push(`| ${cells.map(() => '---').join(' | ')} |`);
          }
        });
        lines.push('');
      }
    } else if (tag === 'p') {
      const t = el.textContent?.trim() ?? '';
      if (t) lines.push(t, '');
    } else {
      Array.from(el.childNodes).forEach(walk);
    }
  };

  Array.from(doc.body.childNodes).forEach(walk);
  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}
