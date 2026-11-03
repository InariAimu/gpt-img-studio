import { useEffect, useRef, useState, type InputHTMLAttributes } from 'react';

/** Match Harness Scope: commit complete text on blur/Enter, preserving IME input. */
export function AutoSaveInput({ value, onCommit, ...props }: Omit<InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange' | 'onBlur'> & {
  value: string;
  onCommit: (value: string) => Promise<unknown>;
}) {
  const [text, setText] = useState(value);
  const focused = useRef(false);
  useEffect(() => { if (!focused.current) setText(value); }, [value]);
  return <input {...props} value={text} onFocus={() => { focused.current = true; }}
    onChange={event => setText(event.target.value)}
    onBlur={() => {
      focused.current = false;
      if (text === value) return;
      void onCommit(text).then(() => { if (props.type === 'password') setText(''); }).catch(() => setText(value));
    }}
    onKeyDown={event => { if (event.key === 'Enter' && !event.nativeEvent.isComposing) { event.preventDefault(); event.currentTarget.blur(); } }} />;
}
