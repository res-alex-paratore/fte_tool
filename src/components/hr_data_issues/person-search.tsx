'use client';

import { useMemo, useState } from 'react';
import { ChevronsUpDown } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from '@/components/ui/command';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import type { PersonIdentity } from '@/lib/hr-issues';

export type SearchEntry = PersonIdentity & {
  key: string;
  inRaw: boolean;
  inRoster: boolean;
  inHistory: boolean;
  sourceLabel: string;
};

type PersonSearchProps = {
  entries: SearchEntry[];
  selected: SearchEntry | null;
  onSelect: (entry: SearchEntry) => void;
  disabled?: boolean;
};

const MAX_RESULTS = 50;

/**
 * Searches everyone in the raw feed, the roster and roster history, so people the ETL dropped
 * can still be found. Filtering is done here rather than by cmdk because the raw feed is large.
 */
export function PersonSearch({ entries, selected, onSelect, disabled }: PersonSearchProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');

  const results = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (q.length < 2) return [];
    const matches: SearchEntry[] = [];
    for (const entry of entries) {
      if (
        entry.name.toLowerCase().includes(q) ||
        entry.email.toLowerCase().includes(q) ||
        entry.personId.toLowerCase().includes(q)
      ) {
        matches.push(entry);
        if (matches.length >= MAX_RESULTS) break;
      }
    }
    return matches;
  }, [entries, query]);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="outline" role="combobox" aria-expanded={open} className="w-full justify-between" disabled={disabled}>
          <span className="truncate">{selected ? `${selected.name || selected.email} ${selected.personId ? `(${selected.personId})` : ''}` : 'Search by name, email or employee ID...'}</span>
          <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[--radix-popover-trigger-width] p-0" align="start">
        <Command shouldFilter={false}>
          <CommandInput placeholder="Type at least 2 characters..." value={query} onValueChange={setQuery} />
          <CommandList>
            <CommandEmpty>{query.trim().length < 2 ? 'Keep typing...' : 'Nobody found. Use "Not found anywhere" below.'}</CommandEmpty>
            <CommandGroup>
              {results.map(entry => (
                <CommandItem
                  key={entry.key}
                  value={entry.key}
                  onSelect={() => {
                    onSelect(entry);
                    setOpen(false);
                  }}
                  className="flex items-center justify-between gap-2"
                >
                  <div className="min-w-0">
                    <div className="truncate font-medium">{entry.name || '(no name)'}</div>
                    <div className="truncate text-xs text-muted-foreground">
                      {[entry.personId, entry.email, entry.sourceLabel].filter(Boolean).join(' · ')}
                    </div>
                  </div>
                  <Badge variant={entry.inRoster ? 'secondary' : 'destructive'} className="shrink-0">
                    {entry.inRoster ? 'In roster' : 'Not in roster'}
                  </Badge>
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
