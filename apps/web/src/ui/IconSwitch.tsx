import { Toggle } from '@base-ui/react/toggle';
import { ToggleGroup } from '@base-ui/react/toggle-group';
import { cn } from '@fishballapps/cn';
import type { Icon } from '@phosphor-icons/react';

/**
 * Base UI's Toggle Group, so the row is one labelled control with arrow-key movement. The
 * pressed cell takes the rail's active ground, not a list row's inversion. `cellClassName` sizes
 * the hit area per call site.
 */
export const IconSwitch = <T extends string>({
  label,
  options,
  value,
  onChange,
  cellClassName = 'size-7',
}: {
  label: string;
  options: readonly { id: T; Icon: Icon; label: string }[];
  value: T;
  onChange: (value: T) => void;
  cellClassName?: string;
}) => (
  <ToggleGroup
    aria-label={label}
    value={[value]}
    onValueChange={([next]) => {
      // Pressing the active cell again would empty the group.
      const chosen = options.find(option => option.id === next);
      if (chosen !== undefined) onChange(chosen.id);
    }}
    className="flex shrink-0 items-center"
  >
    {options.map(({ id, Icon, label: optionLabel }) => (
      <Toggle
        key={id}
        value={id}
        aria-label={optionLabel}
        title={optionLabel}
        className={cn(
          'flex items-center justify-center -outline-offset-2 transition-colors',
          'text-paper-faint hover:bg-ink-hover/60 hover:text-paper',
          'data-[pressed]:bg-ink-hover data-[pressed]:text-paper',
          cellClassName,
        )}
      >
        <Icon size={13} />
      </Toggle>
    ))}
  </ToggleGroup>
);
