export type NodeType = 'folder' | 'note' | 'markdown' | 'docx' | 'xlsx' | 'pdf';

export type WorkspaceSection = 'notes' | 'docs';

export type PreviewStatus = 'pending' | 'ready' | 'failed';

export type OfficeSyncState = 'synced' | 'editing_local' | 'uploading' | 'conflict' | 'error';

export type ImportSourceType = 'graph_api' | 'onepkg_local';

export type ImportJobStatus = 'queued' | 'running' | 'paused' | 'done' | 'failed';

export interface UserProfile {
  id: string;
  email: string;
  displayName: string;
  createdAt: string;
}

export interface NodeMeta {
  id: string;
  parentId: string | null;
  path: string;
  rank: string;
  title: string;
  nodeType: NodeType;
  section: WorkspaceSection;
  icon?: string | null;
  currentFileId?: string | null;
  currentVersion: number;
  isPinned: boolean;
  isDeleted: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface NodeTreeItem extends NodeMeta {
  children: NodeTreeItem[];
}

export type NoteVersionChangeSource = 'auto' | 'manual' | 'before_restore';

export interface NoteVersionSummary {
  id: string;
  nodeId: string;
  version: number;
  title: string;
  plainTextPreview: string;
  charCount: number;
  changeSource: NoteVersionChangeSource;
  createdAt: string;
}

export interface NoteVersionDetail extends NoteVersionSummary {
  contentHtml: string;
  plainText: string;
}

export interface NodeFileVersion {
  id: string;
  nodeId: string;
  version: number;
  fileName: string;
  mimeType: string;
  fileSize: number;
  sha256: string;
  previewStatus: PreviewStatus;
  sourceDevice: string | null;
  createdAt: string;
}

export interface ExcelSheetPreview {
  name: string;
  rows: string[][];
  merges: Array<{ r: number; c: number; rowSpan: number; colSpan: number }>;
  totalRows: number;
  totalCols: number;
  truncated: boolean;
}

export type InlineOfficePreview =
  | { kind: 'excel'; fileName: string; sheets: ExcelSheetPreview[] }
  | { kind: 'docx'; fileName: string; html: string }
  | { kind: 'unsupported'; fileName: string; reason: string };

export interface OnlyOfficeConfigResponse {
  enabled: boolean;
  reason?: string;
  documentServerUrl?: string;
  config?: Record<string, unknown>;
}

export interface FileAccessUrls {
  nodeId: string;
  version: number;
  fileName: string;
  mimeType: string;
  fileSize: number;
  sha256: string;
  downloadUrl: string;
  previewPdfUrl: string | null;
  previewStatus: PreviewStatus;
}

export interface SearchHit {
  id: string;
  title: string;
  nodeType: NodeType;
  breadcrumb: string[];
  snippet: string;
  updatedAt: string;
}

export interface ImportJobState {
  id: string;
  sourceType: ImportSourceType;
  targetNodeId: string | null;
  status: ImportJobStatus;
  totalPages: number;
  importedPages: number;
  failedPages: number;
  errorLog: Array<{ pageTitle: string; reason: string; retryable: boolean }>;
  updatedAt: string;
}

/**
 * 将 UUID 转为 PostgreSQL ltree 合法标签（字母数字下划线）
 */
export function uuidToLtreeLabel(uuid: string): string {
  return 'n_' + uuid.replace(/-/g, '');
}

/**
 * 轻量 Fractional Indexing（LexoRank）排序键生成，支持 O(1) 无限拖拽插入
 */
const ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

export function rankBetween(prev: string | null | undefined, next: string | null | undefined): string {
  const a = prev ?? '';
  const b = next ?? '';
  let prefix = '';
  let i = 0;

  while (true) {
    const aIdx = i < a.length ? ALPHABET.indexOf(a[i]) : 0;
    const bIdx = i < b.length ? ALPHABET.indexOf(b[i]) : ALPHABET.length;

    if (bIdx - aIdx > 1) {
      const mid = Math.floor((aIdx + bIdx) / 2);
      return prefix + ALPHABET[mid];
    }

    prefix += i < a.length ? a[i] : ALPHABET[0];
    i += 1;
    if (i > 64) {
      return prefix + ALPHABET[Math.floor(ALPHABET.length / 2)];
    }
  }
}

/**
 * 将扁平 NodeMeta 列表构建为有序无限层级树
 */
export function buildNodeTree(items: NodeMeta[]): NodeTreeItem[] {
  const map = new Map<string, NodeTreeItem>();
  const roots: NodeTreeItem[] = [];

  for (const item of items) {
    if (!item.isDeleted) {
      map.set(item.id, { ...item, children: [] });
    }
  }

  for (const node of map.values()) {
    if (node.parentId && map.has(node.parentId)) {
      map.get(node.parentId)!.children.push(node);
    } else {
      roots.push(node);
    }
  }

  const sortRec = (list: NodeTreeItem[]) => {
    list.sort((x, y) => {
      if (x.isPinned !== y.isPinned) return x.isPinned ? -1 : 1;
      return x.rank < y.rank ? -1 : x.rank > y.rank ? 1 : 0;
    });
    for (const n of list) {
      if (n.children.length > 0) sortRec(n.children);
    }
  };

  sortRec(roots);
  return roots;
}
