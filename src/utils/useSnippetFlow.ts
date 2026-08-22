import { useCallback } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { Snippet } from '../types';
import { expandSnippet, SnippetCancelledError, ArgumentSpec } from './snippets';

/**
 * Shared snippet use flow (copy / paste) for BOTH surfaces:
 *  - SnippetsView (enlarged window)
 *  - Quick Overlay snippets tab
 *
 * One implementation of: recent-clip/selection context, placeholder
 * expansion with argument prompting, clipboard/paste IPC, use-count
 * recording, and confirmation pills. UI surfaces only supply the prompt
 * modal and the confirmation callbacks.
 */
export function useSnippetFlow(opts: {
  snippets: Snippet[];
  promptArgument: (spec: ArgumentSpec & { resolvedDefault?: string }) => Promise<string | null>;
  onConfirm: (text: string) => void;
  onError: (text: string) => void;
  /** Called after a successful use (e.g. to refetch the list for recency ordering). */
  onUsed?: () => void;
}) {
  const { snippets, promptArgument, onConfirm, onError, onUsed } = opts;
  const isTauri =
    typeof window !== 'undefined' &&
    !!(window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;

  const useSnippet = useCallback(
    async (snippet: Snippet | null, mode: 'copy' | 'paste') => {
      if (!snippet) return;
      try {
        const [texts, selection] = await Promise.all([
          invoke<string[]>('get_recent_clip_texts', { limit: 50 }).catch(() => []),
          invoke<string | null>('get_selected_text_snapshot').catch(() => null),
        ]);
        const result = await expandSnippet(snippet, {
          snippets,
          recentClipTexts: texts,
          selection,
          promptArgument,
        });

        if (mode === 'copy') {
          if (isTauri) {
            await invoke('copy_snippet_text', { text: result.text });
          } else {
            // Browser dev-shell fallback (no Tauri IPC): use the Web Clipboard API.
            await navigator.clipboard.writeText(result.text);
          }
        } else {
          if (!isTauri) {
            onError('Paste needs the desktop app — run "npm run tauri dev" and use the hotkey');
            return;
          }
          const pre =
            result.cursorOffset == null ? result.text : result.text.slice(0, result.cursorOffset);
          const post = result.cursorOffset == null ? null : result.text.slice(result.cursorOffset);
          await invoke('paste_snippet_text', { pre, post });
        }

        // Only a successful (non-cancelled, non-failed) use counts + confirms.
        await invoke('record_snippet_use', { id: snippet.id }).catch(() => null);
        if (snippet.show_confirmation) {
          const label = snippet.name || snippet.keyword || 'Snippet';
          onConfirm(mode === 'copy' ? `Copied ${label} to clipboard` : 'text has been placed successfully');
        }
        onUsed?.();
      } catch (err) {
        if (err instanceof SnippetCancelledError) return; // cancelled → never confirm
        console.error('Snippet use failed:', err);
        onError(
          mode === 'paste'
            ? 'Paste failed — press the hotkey while your target app is focused, then try again'
            : 'Copy failed — could not write to the clipboard'
        );
      }
    },
    [snippets, promptArgument, onConfirm, onError, onUsed, isTauri]
  );

  return { useSnippet };
}