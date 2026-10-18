import { useEffect, useState } from 'react';
import { convertFileSrc, invoke } from '@tauri-apps/api/core';
import type { ClipItem } from '../types';

function decodedImage(src: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = async () => {
      try {
        // Keep broken-image icons and alt text out of the visible preview,
        // including the frame between loading bytes and decoding pixels.
        if (image.decode) await image.decode();
        resolve(src);
      } catch (error) { reject(error); }
    };
    image.onerror = () => reject(new Error('Image unavailable'));
    image.src = src;
  });
}

export function ImagePreview({ item }: { item: ClipItem }) {
  const key = `${item.id}:${item.image_path || ''}`;
  const [ready, setReady] = useState<{ key: string; src?: string; failed?: boolean }>();
  useEffect(() => {
    let active = true;
    const path = item.image_path;
    if (!path) return;
    async function load() {
      try {
        let src: string;
        try {
          src = await decodedImage(convertFileSrc(path!));
        } catch {
          if (!active) return;
          // Use IPC only when the asset URL actually fails. Replacing every
          // successful asset URL with a data URL caused a second image load.
          const fallback = await invoke<string>('get_image_data_url', { filePath: path });
          if (!active) return;
          src = await decodedImage(fallback);
        }
        if (active) setReady({ key, src });
      } catch {
        if (active) setReady({ key, failed: true });
      }
    }
    void load();
    return () => { active = false; };
  }, [key, item.image_path]);

  // A previous selection must never paint during the next effect's startup.
  const current = ready?.key === key ? ready : undefined;
  return (
    <div className="preview-media" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div className="preview-image-simple" aria-busy={!current}>
        {current?.src ? (
          <img key={key} src={current.src} alt="Clipboard image preview" draggable={false} />
        ) : current?.failed ? (
          <div className="preview-media-placeholder">Image preview unavailable.</div>
        ) : null}
      </div>
    </div>
  );
}
