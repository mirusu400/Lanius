import { useCallback, useEffect, useRef, useState } from 'react';

import { useT } from '../i18n';

const MIN_ZOOM = 0.25;
const MAX_ZOOM = 16;
const ZOOM_STEP = 1.25;

interface Position {
  zoom: number;
  x: number;
  y: number;
}

const FIT: Position = { zoom: 1, x: 0, y: 0 };

/** Zoom around the cursor and drag the captured image without changing it. */
export function ImagePreview({ mime, data }: { mime: string; data: string }) {
  const t = useT();
  const stage = useRef<HTMLDivElement>(null);
  const pointer = useRef<{ id: number; x: number; y: number } | null>(null);
  const [position, setPosition] = useState<Position>(FIT);
  const [dragging, setDragging] = useState(false);

  const zoomAt = useCallback((factor: number, x = 0, y = 0) => {
    setPosition((previous) => {
      const zoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, previous.zoom * factor));
      const ratio = zoom / previous.zoom;
      return {
        zoom,
        x: x - (x - previous.x) * ratio,
        y: y - (y - previous.y) * ratio,
      };
    });
  }, []);

  useEffect(() => {
    const element = stage.current;
    if (!element) return;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const box = element.getBoundingClientRect();
      zoomAt(
        event.deltaY < 0 ? ZOOM_STEP : 1 / ZOOM_STEP,
        event.clientX - box.left - box.width / 2,
        event.clientY - box.top - box.height / 2,
      );
    };
    element.addEventListener('wheel', onWheel, { passive: false });
    return () => element.removeEventListener('wheel', onWheel);
  }, [zoomAt]);

  const stopDragging = (event: React.PointerEvent<HTMLDivElement>) => {
    if (pointer.current?.id !== event.pointerId) return;
    pointer.current = null;
    setDragging(false);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };

  return <div className="image-preview">
    <div className="image-preview-toolbar">
      <button type="button" aria-label={t('detail.preview.zoomOut')} title={t('detail.preview.zoomOut')} disabled={position.zoom <= MIN_ZOOM} onClick={() => zoomAt(1 / ZOOM_STEP)}>−</button>
      <span className="mono" aria-live="polite">{Math.round(position.zoom * 100)}%</span>
      <button type="button" aria-label={t('detail.preview.zoomIn')} title={t('detail.preview.zoomIn')} disabled={position.zoom >= MAX_ZOOM} onClick={() => zoomAt(ZOOM_STEP)}>+</button>
      <button type="button" onClick={() => setPosition(FIT)}>{t('detail.preview.fit')}</button>
    </div>
    <div
      ref={stage}
      className={`response-preview-image${dragging ? ' dragging' : ''}`}
      role="img"
      aria-label={t('detail.preview.imageAlt')}
      tabIndex={0}
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        event.preventDefault();
        pointer.current = { id: event.pointerId, x: event.clientX, y: event.clientY };
        event.currentTarget.setPointerCapture(event.pointerId);
        setDragging(true);
      }}
      onPointerMove={(event) => {
        if (pointer.current?.id !== event.pointerId) return;
        const dx = event.clientX - pointer.current.x;
        const dy = event.clientY - pointer.current.y;
        pointer.current.x = event.clientX;
        pointer.current.y = event.clientY;
        setPosition((previous) => ({ ...previous, x: previous.x + dx, y: previous.y + dy }));
      }}
      onPointerUp={stopDragging}
      onPointerCancel={stopDragging}
      onLostPointerCapture={() => { pointer.current = null; setDragging(false); }}
      onDoubleClick={() => setPosition(FIT)}
      onKeyDown={(event) => {
        if (event.key === '+' || event.key === '=') zoomAt(ZOOM_STEP);
        else if (event.key === '-') zoomAt(1 / ZOOM_STEP);
        else if (event.key === '0' || event.key === 'Home') setPosition(FIT);
        else return;
        event.preventDefault();
      }}
    >
      <img
        alt=""
        draggable={false}
        src={`data:${mime};base64,${data}`}
        style={{ transform: `translate(-50%, -50%) translate(${position.x}px, ${position.y}px) scale(${position.zoom})` }}
      />
    </div>
  </div>;
}
