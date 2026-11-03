import { Children, Fragment, isValidElement, useCallback, useState, type ReactNode } from 'react';
import * as Select from '@radix-ui/react-select';
import { Check, ChevronDown, ChevronUp } from 'lucide-react';

type Option = { value: string; label: ReactNode; disabled?: boolean; group?: string };
function readOptions(children: ReactNode, group?: string): Option[] {
  const options: Option[] = [];
  Children.forEach(children, child => {
    if (!isValidElement<{ value?: string | number; children?: ReactNode; disabled?: boolean; label?: string }>(child)) return;
    if (child.type === Fragment || child.type === 'optgroup') {
      options.push(...readOptions(child.props.children, child.props.label || group));
    } else if (child.type === 'option') {
      options.push({ value: String(child.props.value ?? Children.toArray(child.props.children).join('')), label: child.props.children, disabled: child.props.disabled, group });
    }
  });
  return options;
}

/** Harness Scope's Radix dropdown, including empty values and option groups. */
export function OptionSelect({ children, value, onValueChange, className = '', disabled, required, ...props }: {
  children: ReactNode;
  value: string | number;
  onValueChange: (value: string) => void;
  className?: string;
  disabled?: boolean;
  required?: boolean;
  id?: string;
  title?: string;
  'aria-label'?: string;
  'aria-labelledby'?: string;
}) {
  const options = readOptions(children);
  const [container, setContainer] = useState<HTMLElement | null>(null);
  const triggerRef = useCallback((node: HTMLButtonElement | null) => { if (node) setContainer(node.closest('dialog')); }, []);
  const item = (option: Option) => <Select.Item className="select-item" key={option.value} value={`option:${option.value}`} disabled={option.disabled}>
    <span className="select-indicator"><Select.ItemIndicator><Check /></Select.ItemIndicator></span>
    <Select.ItemText>{option.label}</Select.ItemText>
  </Select.Item>;
  const groups = [...new Set(options.map(option => option.group))];
  return <Select.Root value={`option:${value}`} onValueChange={next => onValueChange(next.slice(7))} disabled={disabled} required={required}>
    <Select.Trigger {...props} className={`select-trigger ${className}`} ref={triggerRef}>
      <Select.Value /><Select.Icon asChild><ChevronDown /></Select.Icon>
    </Select.Trigger>
    <Select.Portal container={container}>
      <Select.Content className="select-content" position="popper" sideOffset={4} collisionPadding={8}>
        <Select.ScrollUpButton className="select-scroll"><ChevronUp /></Select.ScrollUpButton>
        <Select.Viewport className="select-viewport">{groups.map(group => group ? <Select.Group key={group}><Select.Label className="select-label">{group}</Select.Label>{options.filter(option => option.group === group).map(item)}</Select.Group> : <Fragment key="ungrouped">{options.filter(option => !option.group).map(item)}</Fragment>)}</Select.Viewport>
        <Select.ScrollDownButton className="select-scroll"><ChevronDown /></Select.ScrollDownButton>
      </Select.Content>
    </Select.Portal>
  </Select.Root>;
}
