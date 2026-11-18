'use client';

import { Boxes, FolderGit2, Server as ServerIcon } from 'lucide-react';
import { useEffect, useRef } from 'react';
import type { Server } from '@/lib/domain';
import type {
  ChatMention,
  ChatReference,
  HubProject,
  HubService,
} from '@/lib/hub';
import { chatReferenceKey, isSshMachine } from '@/lib/chat-references.mjs';

type Option = ChatReference & {
  name: string;
  machineName?: string;
  ssh?: boolean;
};

const kinds = {
  machine: {
    label: 'Сервер',
    icon: ServerIcon,
    keywords: ['сервер', 'машина', 'server', 'machine', 'host'],
  },
  service: {
    label: 'Сервис',
    icon: Boxes,
    keywords: ['сервис', 'служба', 'service'],
  },
  project: {
    label: 'Проект',
    icon: FolderGit2,
    keywords: ['проект', 'папка', 'project'],
  },
} as const;

export function mentionOptions(
  machines: Server[],
  services: HubService[],
  projects: HubProject[],
  query: string,
  onHost: boolean,
) {
  const byId = new Map(machines.map((machine) => [machine.id, machine]));
  const groups: Option[][] = [
    machines.map(({ id, name }) => ({
      kind: 'machine',
      id,
      name,
      ssh: onHost && isSshMachine(byId.get(id)),
    })),
    services.map(({ id, name, machineId }) => ({
      kind: 'service',
      id,
      name,
      machineName: byId.get(machineId)?.name,
      ssh: onHost && isSshMachine(byId.get(machineId)),
    })),
    projects.map(({ id, name, machineId }) => ({
      kind: 'project',
      id,
      name,
      machineName: byId.get(machineId)?.name,
    })),
  ];
  const limit = 9;
  if (!query) {
    const visible = [];
    for (let index = 0; index < limit && visible.length < limit; index++)
      for (const group of groups)
        if (group[index] && visible.length < limit) visible.push(group[index]);
    return visible;
  }
  return groups
    .flat()
    .map((option) => {
      const name = option.name.toLowerCase();
      const score =
        name === query
          ? 4
          : name.startsWith(query)
            ? 3
            : name.includes(query)
              ? 2
              : kinds[option.kind].keywords.some((word) =>
                    word.startsWith(query),
                  ) || option.machineName?.toLowerCase().includes(query)
                ? 1
                : 0;
      return { option, score };
    })
    .filter(({ score }) => score)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(({ option }) => option);
}

/* oxlint-disable jsx-a11y/prefer-tag-over-role -- Native datalists cannot complete text at the caret in this editor. */
export function MentionPicker({
  id,
  options,
  active,
  onSelect,
}: {
  id: string;
  options: Option[];
  active: number;
  onSelect: (option: Option) => void;
}) {
  const selected = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    selected.current?.scrollIntoView({ block: 'nearest' });
  }, [active]);
  return (
    <div
      className="composer-command-picker composer-mention-picker"
      id={id}
      role="listbox"
      aria-label="Упомянуть объект"
    >
      {options.map((option, index) => {
        const { label, icon: Icon } = kinds[option.kind];
        return (
          <button
            key={chatReferenceKey(option)}
            id={`${id}-${index}`}
            ref={active === index ? selected : undefined}
            type="button"
            role="option"
            tabIndex={-1}
            aria-selected={active === index}
            className="composer-command-option mention-option"
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => onSelect(option)}
          >
            <Icon size={16} aria-hidden="true" />
            <span>
              <strong>{option.name}</strong>
              <small>
                {[label, option.machineName].filter(Boolean).join(' · ')}
              </small>
            </span>
            {option.ssh && <small className="mention-transport">SSH</small>}
          </button>
        );
      })}
      {!options.length && (
        <output className="mention-empty">
          Подходящих серверов, сервисов или проектов нет
        </output>
      )}
    </div>
  );
}
/* oxlint-enable jsx-a11y/prefer-tag-over-role */

export function mentionTitle({ kind, name, machineName }: ChatMention) {
  return [kinds[kind].label, name, machineName].filter(Boolean).join(' · ');
}

export function MentionTag({ mention }: { mention: ChatMention }) {
  return (
    <span className="chat-mention-tag" title={mentionTitle(mention)}>
      @{mention.name}
    </span>
  );
}
