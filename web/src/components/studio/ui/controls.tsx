import { studioKeys } from '../studio-env';
import React from 'react';
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectTrigger, SelectValue } from '@/components/ui/select';
import { cn } from '@/lib/utils';
import { Icon, type IconName } from './icons';

export function IconButton({ icon, label, ...props }: {icon: IconName; label: string} & React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return <button type="button" title={label} aria-label={label} {...props}><Icon name={icon}/></button>;
}
export function Slider({label, value, min = 0, max, step = 1, unit = '', resetValue, onChange}: {label: string; value: number; min?: number; max: number; step?: number; unit?: string; resetValue?:number; onChange: (n: number) => void}) {
  const inputId=React.useId(),reset=Math.min(max,Math.max(min,resetValue??min));
  return <div className="field"><label className="field-label" htmlFor={inputId}>{label}<output>{Math.round(value * 100) / 100}{unit}</output></label><div className="slider-row"><input id={inputId} type="range" aria-label={label} value={value} min={min} max={max} step={step} onKeyDown={e=>{if(['ArrowLeft','ArrowRight','ArrowUp','ArrowDown','Home','End','PageUp','PageDown'].includes(e.key))e.stopPropagation();}} onChange={(e) => onChange(Number(e.target.value))}/><button type="button" className="slider-reset" title={`Reset ${label}`} aria-label={`Reset ${label}`} disabled={value===reset} onClick={()=>onChange(reset)}><Icon name="undo" size={14}/></button></div></div>;
}
export function NumberField({label, value, min = 0, max, step = .1, onChange}: {label: string; value: number; min?: number; max: number; step?: number; onChange: (n: number) => void}) {
  return <label>{label}<input type="number" aria-label={label} min={min} max={max} step={step} value={Math.round(value * 1000) / 1000} onChange={(e) => { if (e.target.value !== '') { const n = Number(e.target.value); if (Number.isFinite(n)) onChange(Math.min(max, Math.max(min, n))); } }}/></label>;
}
export function Toggle({label, checked, onChange}: {label: string; checked: boolean; onChange: (v: boolean) => void}) {
  return <label className="toggle-row">{label}<input className="toggle" type="checkbox" aria-label={label} checked={checked} onChange={(e) => onChange(e.target.checked)}/></label>;
}
export function Modal({title, close, children, wide}: {title: string; close: () => void; children: React.ReactNode; wide?: boolean}) {
  const headingId = React.useId();
  const ref = React.useRef<HTMLDivElement>(null);
  React.useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    ref.current?.focus();
    const handle = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); close(); }
      if (e.key === 'Tab') { const els = Array.from(ref.current?.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),select:not(:disabled),a[href]') ?? []); const first = els[0], last = els.at(-1); if (!first || !last) return; if (e.shiftKey && (document.activeElement === first || document.activeElement === ref.current)) { e.preventDefault(); last.focus(); } else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); } }
    };
    studioKeys.addEventListener('keydown', handle); return () => { studioKeys.removeEventListener('keydown', handle); previous?.focus(); };
  }, [close]);
  return <div className="modal-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) close(); }}><div className={wide ? "modal modal-wide" : "modal"} ref={ref} role="dialog" aria-modal="true" aria-labelledby={headingId} tabIndex={-1}><div className="modal-heading"><h2 id={headingId}>{title}</h2><IconButton icon="close" label="Close dialog" onClick={close}/></div>{children}</div></div>;
}
export function Waveform({values}: {values: number[]}) {
  if (!values.length) return null;
  return <svg className="waveform" viewBox={`0 0 ${values.length} 32`} preserveAspectRatio="none" aria-label="Recorded audio waveform"><path d={`M0 32 ${values.map((v,i) => `L${i} ${32 - v * 29}`).join(' ')} L${values.length} 32Z`} fill="currentColor"/></svg>;
}

/*
 * The app's Select (src/components/ui/select), written like the system's: the options are plain <option> and <optgroup>
 * elements, read as data (never drawn), so a call site keeps its option list as it was. Its list opens in the app's
 * layer on the page, above the Studio's dialogs and popovers (z-index 1200 against their 60 and 1000) and never cut
 * by the Studio's card. `size`: 'compact' (28px, 12px text) in the editor's dense rows, 'normal' (the app's 36px) on
 * page-like screens and in dialogs; a compact one on a page-like screen grows to the page's field (studio.css), and its
 * list takes the size of the text it opened from. An option with `data-dot` shows a dot before its text; the attribute's value
 * says what the dot means to a screen reader (the automation pickers: "has automation").
 */
type StudioChoice = { value: string; label: React.ReactNode; text: string; disabled: boolean; dot?: string };
type StudioChoiceGroup = { label?: string; choices: StudioChoice[] };
type OptionProps = { value?: string | number; disabled?: boolean; children?: React.ReactNode; label?: string; 'data-dot'?: string | boolean };
/** Radix refuses an item whose value is the empty string, which the Studio uses for "none"; it travels as this instead. */
const EMPTY_CHOICE = '__studio-empty__';
const textOf = (node: React.ReactNode): string => typeof node === 'string' || typeof node === 'number' ? String(node) : Array.isArray(node) ? node.map(textOf).join('') : React.isValidElement<{ children?: React.ReactNode }>(node) ? textOf(node.props.children) : '';
export function readChoices(children: React.ReactNode): StudioChoiceGroup[] {
  const groups: StudioChoiceGroup[] = [];
  const add = (choice: StudioChoice) => { const last = groups.at(-1); if (last && last.label === undefined) last.choices.push(choice); else groups.push({ choices: [choice] }); };
  const visit = (nodes: React.ReactNode, into?: StudioChoiceGroup) => React.Children.forEach(nodes, node => {
    if (!React.isValidElement<OptionProps>(node)) return;
    if (node.type === React.Fragment) return visit(node.props.children, into);
    if (node.type === 'optgroup') { const group: StudioChoiceGroup = { label: node.props.label ?? '', choices: [] }; groups.push(group); visit(node.props.children, group); return; }
    if (node.type !== 'option') return;
    const { value, disabled, children: label, 'data-dot': dot } = node.props, text = textOf(label);
    const choice: StudioChoice = { value: String(value ?? text), label, text, disabled: !!disabled, ...(dot ? { dot: typeof dot === 'string' ? dot : 'marked' } : {}) };
    if (into) into.choices.push(choice); else add(choice);
  });
  visit(children);
  return groups;
}
function ChoiceLabel({ choice }: { choice: StudioChoice }) {
  return <>{choice.dot ? <><span aria-hidden="true" className="mr-1.5 inline-block size-1.5 shrink-0 rounded-full bg-current align-middle" /><span className="sr-only">{choice.dot}: </span></> : null}{choice.label}</>;
}
/** Whether one of these lists is open: a popover's outside-click closer leaves the pointer to it. */
export const studioSelectOpen = () => typeof document !== 'undefined' && !!document.querySelector('[data-studio-select-list][data-state="open"]');
export function StudioSelect({ value, onChange, children, size = 'compact', disabled, className, id, title, 'aria-label': ariaLabel, 'aria-labelledby': labelledBy }: {
  value: string | number; onChange: (value: string) => void; children: React.ReactNode; size?: 'compact' | 'normal'; disabled?: boolean; className?: string; id?: string; title?: string; 'aria-label'?: string; 'aria-labelledby'?: string;
}) {
  const groups = readChoices(children), all = groups.flatMap(group => group.choices);
  // As the system's select does, a value that is none of the options shows the first one.
  const chosen = all.find(choice => choice.value === String(value)) ?? all[0];
  const trigger = React.useRef<HTMLButtonElement>(null), [listSize, setListSize] = React.useState(size);
  const encode = (v: string) => v === '' ? EMPTY_CHOICE : v, compact = listSize === 'compact';
  const opening = (open: boolean) => { if (open && trigger.current) setListSize(parseFloat(getComputedStyle(trigger.current).fontSize) >= 14 ? 'normal' : 'compact'); };
  const item = (choice: StudioChoice, key: string) => <SelectItem key={key} value={encode(choice.value)} disabled={choice.disabled} textValue={choice.text} className={compact ? 'text-xs' : undefined}><ChoiceLabel choice={choice} /></SelectItem>;
  return <Select value={chosen ? encode(chosen.value) : undefined} disabled={disabled} onOpenChange={opening} onValueChange={next => onChange(next === EMPTY_CHOICE ? '' : next)}>
    <SelectTrigger ref={trigger} id={id} title={title} aria-label={ariaLabel} aria-labelledby={labelledBy} className={cn('st-select', size === 'compact' ? 'st-select-compact' : 'st-select-normal', className)}>
      <SelectValue>{chosen ? <ChoiceLabel choice={chosen} /> : null}</SelectValue>
    </SelectTrigger>
    <SelectContent data-studio-select-list="" className="z-[1200] max-h-[min(var(--radix-select-content-available-height),24rem)]">
      {groups.map((group, g) => group.label === undefined ? group.choices.map((choice, i) => item(choice, `${g}-${i}`))
        : <SelectGroup key={g}><SelectLabel className={compact ? 'text-xs' : undefined}>{group.label}</SelectLabel>{group.choices.map((choice, i) => item(choice, `${g}-${i}`))}</SelectGroup>)}
    </SelectContent>
  </Select>;
}
