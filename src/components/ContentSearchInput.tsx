import { memo, useEffect, useRef, useState, type InputHTMLAttributes, type Ref } from 'react';

// Keep the urgent keystroke render inside this small component. A search must
// not reconcile the history list or re-render a large document on every key.
export const ContentSearchInput = memo(function ContentSearchInput({
  value, onSearch, inputRef, onKeyDown, busy = false, ...props
}: Omit<InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange'> & {
  value: string;
  onSearch: (value: string) => void;
  inputRef: Ref<HTMLInputElement>;
  busy?: boolean;
}) {
  const [draft, setDraft] = useState(value);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  // Track in-flight queries emitted via `onSearch` in order so that when the
  // parent's async/transitioned `value` prop catches up to one of our own
  // earlier emissions while the user is typing ahead, we NEVER clobber `draft`
  // or cancel the newer pending debounce timer. External resets (clear button,
  // overlay reopen) still sync immediately because they are not in the queue.
  const valueRef = useRef(value);
  valueRef.current = value;
  const pendingEmissionsRef = useRef<string[]>([]);

  useEffect(() => {
    const pending = pendingEmissionsRef.current;
    const matchIdx = pending.indexOf(value);
    if (matchIdx !== -1) {
      pending.splice(0, matchIdx + 1);
      return;
    }
    pending.length = 0;
    clearTimeout(timer.current);
    setDraft(value);
  }, [value]);

  useEffect(() => () => clearTimeout(timer.current), []);

  const commitSearch = (next: string) => {
    if (pendingEmissionsRef.current.length > 0 || next !== valueRef.current) {
      pendingEmissionsRef.current.push(next);
    }
    onSearch(next);
  };

  return <input {...props} ref={inputRef} value={draft} data-search-pending={draft !== value || busy} onKeyDown={(event) => {
    if (event.key === 'Enter' && (draft !== value || busy)) {
      // A quick Enter must not paste the selection for the previous query.
      event.preventDefault();
      event.stopPropagation();
      clearTimeout(timer.current);
      if (draft !== value) commitSearch(draft);
      return;
    }
    onKeyDown?.(event);
  }} onChange={(event) => {
    const next = event.target.value;
    setDraft(next);
    clearTimeout(timer.current);
    if (!next) commitSearch(next);
    else timer.current = setTimeout(() => commitSearch(next), 115);
  }} />;
});
