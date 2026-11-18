'use client';

import { Fragment, type AriaAttributes } from 'react';
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from './ui/select';

export type WorkspaceOption = {
  value: string;
  label: string;
  description?: string;
  disabled?: boolean;
  group?: string;
};

type Props = Pick<
  AriaAttributes,
  'aria-label' | 'aria-labelledby' | 'aria-describedby'
> & {
  value: string;
  id?: string;
  options: WorkspaceOption[];
  onValueChange: (value: string) => void;
  disabled?: boolean;
  required?: boolean;
  placeholder?: string;
};

export function WorkspaceSelect({
  value,
  id,
  options,
  onValueChange,
  disabled,
  required,
  placeholder = 'Выберите значение',
  ...label
}: Props) {
  const selected = options.find((option) => option.value === value);
  const groups = [...new Set(options.map((option) => option.group || ''))];

  return (
    <Select
      id={id}
      items={options}
      value={selected?.value ?? null}
      disabled={disabled}
      required={required}
      onValueChange={(next) => {
        if (next !== null && next !== value) onValueChange(next);
      }}
    >
      <SelectTrigger
        {...label}
        className="workspace-select-trigger"
        title={selected?.description || selected?.label}
      >
        <SelectValue placeholder={placeholder}>
          {selected?.label || placeholder}
        </SelectValue>
      </SelectTrigger>
      <SelectContent
        align="start"
        sideOffset={5}
        alignItemWithTrigger={false}
        className="workspace-select-popup"
      >
        {groups.map((group) => {
          const rows = options
            .filter((option) => (option.group || '') === group)
            .map((choice) => (
              <SelectItem
                key={choice.value}
                value={choice.value}
                label={choice.label}
                disabled={choice.disabled}
              >
                <span className="workspace-option-label">{choice.label}</span>
                {choice.description && (
                  <small className="workspace-option-description">
                    {choice.description}
                  </small>
                )}
              </SelectItem>
            ));
          return group ? (
            <SelectGroup key={group}>
              <SelectLabel>{group}</SelectLabel>
              {rows}
            </SelectGroup>
          ) : (
            <Fragment key={group}>{rows}</Fragment>
          );
        })}
        {!options.length && (
          <p className="workspace-options-empty">Нет вариантов</p>
        )}
      </SelectContent>
    </Select>
  );
}
