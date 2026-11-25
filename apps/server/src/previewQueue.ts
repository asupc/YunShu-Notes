import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import mammoth from 'mammoth';
import * as XLSX from 'xlsx';
import { db } from './db';
import { resolveStoragePath, writeStorageFile } from './storage';

const execFileAsync = promisify(execFile);

interface PreviewTask {
  fileId: string;
  nodeId: string;
  storageKey: string;
  fileName: string;
}

const pendingQueue: PreviewTask[] = [];
let running = false;

async function extractPlainText(localPath: string, fileName: string): Promise<string> {
  const lower = fileName.toLowerCase();
  if (lower.endsWith('.docx')) {
    const res = await mammoth.extractRawText({ path: localPath });
    return res.value.replace(/\s+/g, ' ').trim();
  }
  if (lower.endsWith('.xlsx') || lower.endsWith('.xls')) {
    const wb = XLSX.readFile(localPath);
    const parts: string[] = [];
    for (const name of wb.SheetNames) {
      parts.push(name);
      parts.push(XLSX.utils.sheet_to_csv(wb.Sheets[name]));
    }
    return parts.join(' ').replace(/\s+/g, ' ').trim();
  }
  return '';
}

async function processTask(task: PreviewTask): Promise<void> {
  const localIn = resolveStoragePath(task.storageKey);
  const lower = task.fileName.toLowerCase();

  try {
    // 1. 抽取 Word / Excel 纯文本写入 nodes.plain_text，支持全局搜索
    const text = await extractPlainText(localIn, task.fileName);
    if (text) {
      db.prepare("UPDATE nodes SET plain_text = ?, updated_at = datetime('now') WHERE id = ?").run(
        text.slice(0, 200_000),
        task.nodeId
      );
    }

    if (lower.endsWith('.pdf')) {
      db.prepare("UPDATE node_files SET preview_pdf_key = storage_key, preview_status = 'ready' WHERE id = ?").run(
        task.fileId
      );
      return;
    }

    // 2. 若宿主机或容器安装了 LibreOffice，自动转为只读 PDF 预览缓存
    if (lower.endsWith('.docx') || lower.endsWith('.xlsx') || lower.endsWith('.doc') || lower.endsWith('.xls')) {
      const workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'yunshu-lo-'));
      const loProfile = path.join(workDir, 'profile');
      try {
        const bin = process.platform === 'win32' ? 'soffice' : 'libreoffice';
        await execFileAsync(
          bin,
          [
            '--headless',
            `-env:UserInstallation=file://${loProfile.replace(/\\/g, '/')}`,
            '--convert-to',
            'pdf',
            '--outdir',
            workDir,
            localIn,
          ],
          { timeout: 45_000 }
        );
        const pdfName = `${path.parse(localIn).name}.pdf`;
        const pdfBuf = await fs.readFile(path.join(workDir, pdfName));
        const previewKey = `previews/${task.fileId}.pdf`;
        await writeStorageFile(previewKey, pdfBuf);
        db.prepare("UPDATE node_files SET preview_pdf_key = ?, preview_status = 'ready' WHERE id = ?").run(
          previewKey,
          task.fileId
        );
      } catch {
        // 本机未安装 LibreOffice 时平滑降级，不影响上传与 PC 本机 Office 唤起
        db.prepare("UPDATE node_files SET preview_status = 'failed' WHERE id = ?").run(task.fileId);
      } finally {
        await fs.rm(workDir, { recursive: true, force: true });
      }
    }
  } catch (err) {
    console.error('[云树预览] 处理文件失败:', err);
    db.prepare("UPDATE node_files SET preview_status = 'failed' WHERE id = ?").run(task.fileId);
  }
}

async function drain(): Promise<void> {
  if (running) return;
  running = true;
  while (pendingQueue.length > 0) {
    const task = pendingQueue.shift();
    if (task) await processTask(task);
  }
  running = false;
}

export function enqueuePreviewTask(task: PreviewTask): void {
  pendingQueue.push(task);
  void drain();
}
