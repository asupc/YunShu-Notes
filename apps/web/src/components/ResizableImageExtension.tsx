import React, { useRef, useState } from 'react';
import Image from '@tiptap/extension-image';
import { NodeViewWrapper, ReactNodeViewRenderer, type NodeViewProps } from '@tiptap/react';

const ResizableImageView: React.FC<NodeViewProps> = ({ node, updateAttributes, selected }) => {
  const imgRef = useRef<HTMLImageElement>(null);
  const [resizingWidth, setResizingWidth] = useState<number | null>(null);

  const rawWidth = node.attrs.width;
  const parsedWidth =
    typeof rawWidth === 'number'
      ? rawWidth
      : typeof rawWidth === 'string' && rawWidth.trim() !== ''
      ? Number.parseInt(rawWidth, 10)
      : null;
  const displayWidth = resizingWidth ?? (parsedWidth && Number.isFinite(parsedWidth) ? parsedWidth : null);

  const startResize = (e: React.PointerEvent, direction: 'right' | 'left') => {
    e.preventDefault();
    e.stopPropagation();
    const imgEl = imgRef.current;
    if (!imgEl) return;

    const startX = e.clientX;
    const startW = imgEl.getBoundingClientRect().width;
    let latestW = startW;

    const onMove = (ev: PointerEvent) => {
      if (ev.cancelable) ev.preventDefault();
      const deltaX = direction === 'right' ? ev.clientX - startX : startX - ev.clientX;
      latestW = Math.max(60, Math.min(1600, Math.round(startW + deltaX)));
      setResizingWidth(latestW);
    };

    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
      setResizingWidth(null);
      updateAttributes({ width: Math.round(latestW) });
    };

    window.addEventListener('pointermove', onMove, { passive: false });
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
  };

  const applyPresetPercent = (ratio: number | null) => {
    if (ratio === null) {
      updateAttributes({ width: null });
      return;
    }
    const imgEl = imgRef.current;
    const containerW = imgEl?.closest('.ProseMirror')?.getBoundingClientRect().width || 600;
    const targetW = Math.max(60, Math.round(containerW * ratio));
    updateAttributes({ width: targetW });
  };

  return (
    <NodeViewWrapper
      as="div"
      className="relative inline-block max-w-full my-2 align-top group select-none"
      data-drag-handle=""
    >
      <img
        ref={imgRef}
        src={node.attrs.src}
        alt={node.attrs.alt || ''}
        title={node.attrs.title || undefined}
        draggable={false}
        style={{
          width: displayWidth ? `${displayWidth}px` : undefined,
          maxWidth: '100%',
          height: 'auto',
          margin: 0,
        }}
        className={`block rounded-lg transition-shadow ${
          selected || resizingWidth !== null
            ? 'ring-2 ring-blue-500 ring-offset-1 dark:ring-offset-black'
            : 'group-hover:ring-1 group-hover:ring-blue-400/70'
        }`}
      />

      {/* 选中或缩放时显示快捷尺寸栏 */}
      {(selected || resizingWidth !== null) && (
        <div
          onPointerDown={(e) => e.stopPropagation()}
          className="absolute top-2 right-2 z-20 flex items-center gap-1 px-1.5 py-1 rounded-md bg-black/80 text-white text-[11px] shadow-lg backdrop-blur-sm"
        >
          <span className="font-mono px-1 text-slate-200">
            {displayWidth ? `${displayWidth}px` : '原始'}
          </span>
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              applyPresetPercent(0.25);
            }}
            className="px-1 py-0.5 rounded hover:bg-white/20"
            title="缩放到 25%"
          >
            25%
          </button>
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              applyPresetPercent(0.5);
            }}
            className="px-1 py-0.5 rounded hover:bg-white/20"
            title="缩放到 50%"
          >
            50%
          </button>
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              applyPresetPercent(1);
            }}
            className="px-1 py-0.5 rounded hover:bg-white/20"
            title="占满文本框宽度"
          >
            100%
          </button>
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              applyPresetPercent(null);
            }}
            className="px-1 py-0.5 rounded hover:bg-white/20 text-blue-300"
            title="恢复原始尺寸"
          >
            原图
          </button>
        </div>
      )}

      {/* 右侧边缘拖拽缩放手柄 */}
      <div
        onPointerDown={(e) => startResize(e, 'right')}
        style={{ touchAction: 'none' }}
        title="拖拽调整图片大小"
        className={`absolute top-1/2 -right-1.5 -translate-y-1/2 w-2.5 h-10 rounded-full bg-blue-500 border-2 border-white dark:border-black shadow cursor-ew-resize transition-opacity ${
          selected || resizingWidth !== null ? 'opacity-100' : 'opacity-0 group-hover:opacity-90'
        }`}
      />

      {/* 右下角拖拽缩放手柄 */}
      <div
        onPointerDown={(e) => startResize(e, 'right')}
        style={{ touchAction: 'none' }}
        title="拖拽调整图片大小"
        className={`absolute -right-1.5 -bottom-1.5 w-3.5 h-3.5 rounded-sm bg-blue-600 border-2 border-white dark:border-black shadow cursor-nwse-resize transition-opacity ${
          selected || resizingWidth !== null ? 'opacity-100' : 'opacity-0 group-hover:opacity-90'
        }`}
      />

      {/* 左下角拖拽缩放手柄 */}
      <div
        onPointerDown={(e) => startResize(e, 'left')}
        style={{ touchAction: 'none' }}
        title="拖拽调整图片大小"
        className={`absolute -left-1.5 -bottom-1.5 w-3.5 h-3.5 rounded-sm bg-blue-600 border-2 border-white dark:border-black shadow cursor-nesw-resize transition-opacity ${
          selected || resizingWidth !== null ? 'opacity-100' : 'opacity-0 group-hover:opacity-90'
        }`}
      />
    </NodeViewWrapper>
  );
};

export const ResizableImage = Image.extend({
  addAttributes() {
    return {
      ...this.parent?.(),
      width: {
        default: null,
        parseHTML: (element) => {
          const attr = element.getAttribute('width');
          if (attr) {
            const n = Number.parseInt(attr, 10);
            if (Number.isFinite(n) && n > 0) return n;
          }
          const styleW = element.style?.width;
          if (styleW && styleW.endsWith('px')) {
            const n = Number.parseInt(styleW, 10);
            if (Number.isFinite(n) && n > 0) return n;
          }
          return null;
        },
        renderHTML: (attributes) => {
          if (!attributes.width) return {};
          return {
            width: String(attributes.width),
            style: `width: ${attributes.width}px; height: auto;`,
          };
        },
      },
    };
  },

  addNodeView() {
    return ReactNodeViewRenderer(ResizableImageView);
  },
});
