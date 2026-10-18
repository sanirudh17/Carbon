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
  useEffect(() => {
    clearTimeout(timer.current);
    setDraft(value);
  }, [value]);
  useEffect(() => () => clearTimeout(timer.current), []);
  return <input {...props} ref={inputRef} value={draft} data-search-pending={draft !== value || busy} onKeyDown={(event) => {
    if (event.key === 'Enter' && (draft !== value || busy)) {
      // A quick Enter must not paste the selection for the previous query.
      event.preventDefault();
      event.stopPropagation();
      clearTimeout(timer.current);
      if (draft !== value) onSearch(draft);
      return;
    }
    onKeyDown?.(event);
  }} onChange={(event) => {
    const next = event.target.value;
    setDraft(next);
    clearTimeout(timer.current);
    if (!next) onSearch(next);
    else timer.current = setTimeout(() => onSearch(next), 60);
  }} />;
});
