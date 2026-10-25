import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './ui/select';

export function ChoiceSelect({ id, value, options, onChange, disabled, label }: {
  id: string;
  value: string;
  options: readonly { value: string; label: string; disabled?: boolean }[];
  onChange: (value: string) => void;
  disabled?: boolean;
  label?: string;
}) {
  return <Select value={value} items={options} onValueChange={next => { if (next !== null) onChange(next); }} disabled={disabled}>
    <SelectTrigger id={id} aria-label={label}><SelectValue /></SelectTrigger>
    <SelectContent align="start" alignItemWithTrigger={false}>
      {options.map(option => <SelectItem key={option.value} value={option.value} disabled={option.disabled}>{option.label}</SelectItem>)}
    </SelectContent>
  </Select>;
}
