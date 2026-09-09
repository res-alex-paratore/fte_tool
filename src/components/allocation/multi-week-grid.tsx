
'use client';

import { useState, useMemo, Fragment, useEffect, useCallback } from 'react';
import { startOfWeek, format, isSameDay, isValid, addMonths, subMonths } from 'date-fns';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from '@/components/ui/command';
import { ChevronLeft, ChevronRight, PlusCircle, Trash2, Lock, Check, ChevronsUpDown, Loader2, X } from 'lucide-react';
import { useCurrentUser } from '@/hooks/use-current-user';
import type { TeamMember, WeeklyAllocation } from '@/types';
import { cn } from '@/lib/utils';
import { getFullName, getPersonId, normalizeHrRoster } from '@/lib/hr-roster';
import { Badge } from '../ui/badge';
import { useToast } from '@/hooks/use-toast';
import { Skeleton } from '../ui/skeleton';
import { getWeeksForMonth, getOwningMonth, type AllocationWeek } from '@/lib/fiscal-calendar';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '../ui/tooltip';
import { v4 as uuidv4 } from 'uuid';
import { writeLog } from '@/lib/logger';

type AiReportData = {
    Code: string;
    Name: string;
    DisplayName: string;
    RollsUpTo: string;
};

const formatDateKey = (date: Date) => format(startOfWeek(date, { weekStartsOn: 1 }), 'yyyy-MM-dd');

/** Months as a single comparable integer, so month arithmetic never crosses a year boundary wrong. */
const monthValue = (date: Date) => date.getFullYear() * 12 + date.getMonth();

/**
 * How many calendar months back stay open for editing, counting back from the current month.
 *
 * 1 was too tight while managers were still being onboarded: access arrived with too little of
 * July left to complete it, and the month closed before they could. Widened to 2 so the window
 * does not have to be nudged again during ramp-up.
 *
 * This is the only place the window is defined — isWeekEditable and the grid's description both
 * derive from it. A week's month is its owning month (the month containing its Friday), not the
 * month its Monday falls in, so a week can be open while the calendar month it starts in is not.
 */
// Typed as number, not the literal 2: this is meant to be retuned, and a literal type would
// make the singular branch of EDITABLE_WINDOW_LABEL a compile error.
const EDITABLE_MONTHS_BACK: number = 2;

const EDITABLE_WINDOW_LABEL = EDITABLE_MONTHS_BACK === 1
  ? 'the current and previous calendar month'
  : `the current month and the previous ${EDITABLE_MONTHS_BACK} calendar months`;

/**
 * A weekly cell's value.
 *
 * '' means the user explicitly emptied the cell; a missing key means nobody has
 * touched it. Both save as "no allocation", but 0 is a real value that persists,
 * because downstream reporting divides by the number of weeks that have rows.
 */
type WeeklyFteValue = number | '';

/** '' for an empty cell, a finite number otherwise. Never NaN, never undefined. */
const parseCell = (val: string): WeeklyFteValue => {
  const raw = (val ?? '').trim();
  if (raw === '') return '';
  const n = Number(raw);
  return Number.isFinite(n) ? n : '';
};

/**
 * A cell exactly as it was loaded from the collection.
 *
 * Kept alongside the edited values so a save can tell what actually changed, and so the
 * correction fields already on a document survive a PUT — see correctionFieldsFor.
 */
type LoadedCell = {
  amount: number;
  costCenterName: string;
  costCenterNumber: string;
  baselineFteValue: number | null;
  correctionMonth: string | null;
  correctionCount: number;
};

type AllocationRow = {
  id: string;
  clientId: string;
  clientName: string;
  weeklyFtes: { [weekKey: string]: WeeklyFteValue };
  docIds: { [weekKey: string]: string };
  loaded: { [weekKey: string]: LoadedCell };
};

/**
 * One pending write, carried alongside its request so a failure can be attributed.
 *
 * `fetch` only rejects on a network error, so a 403 or a 404 on a missing document resolves
 * normally and is invisible unless the response is matched back to the operation that caused it.
 */
type SaveOperation = {
  kind: 'DELETE' | 'PUT' | 'POST';
  docId?: string;
  weekKey?: string;
  promise: Promise<Response>;
};

/**
 * Hydrate one client row's cells from its documents, restricted to the week keys on screen.
 *
 * `loaded` is the snapshot the save path diffs against; it must be built everywhere a row is
 * built from the collection, or an edit to that row looks clean and is skipped.
 */
const hydrateCells = (docs: WeeklyAllocation[], validWeekKeys: string[]) => {
  const weeklyFtes: { [weekKey: string]: WeeklyFteValue } = {};
  const docIds: { [weekKey: string]: string } = {};
  const loaded: { [weekKey: string]: LoadedCell } = {};

  docs.filter(a => a?.content && validWeekKeys.includes(a.content.allocation_date)).forEach(a => {
    if (!a?.content) return;
    const amount = parseFloat(a.content.allocation_amount || '0');
    // The correction fields come back as strings, like allocation_amount. Parsing has to be
    // tolerant: a baseline that fails to parse would silently re-stamp on the next correction.
    const baseline = parseFloat(a.content.baseline_fte_value ?? '');
    const count = parseInt(a.content.correction_count ?? '', 10);

    weeklyFtes[a.content.allocation_date] = amount;
    docIds[a.content.allocation_date] = a.id;
    loaded[a.content.allocation_date] = {
      amount,
      costCenterName: String(a.content.cost_center_name || '').trim(),
      costCenterNumber: String(a.content.cost_center_number || '').trim(),
      baselineFteValue: Number.isFinite(baseline) ? baseline : null,
      correctionMonth: a.content.correction_month || null,
      correctionCount: Number.isFinite(count) ? count : 0,
    };
  });

  return { weeklyFtes, docIds, loaded };
};

/**
 * The correction fields to write on a PUT.
 *
 * An AppDB PUT replaces the whole content object, so anything already on the document has
 * to be written back explicitly or it is erased — which is why the carry-forward below runs
 * even for edits that are not corrections.
 *
 * A week owned by a closed month is a retroactive edit, i.e. a correction. `baseline_fte_value`
 * is the amount as it stood before the *first* correction of a cycle, so a second edit in the
 * same month preserves it rather than recomputing. Recomputing would make the corrections card
 * report the delta between the last two edits instead of the delta from what was reported for
 * that month.
 */
const correctionFieldsFor = (
  loaded: LoadedCell | undefined,
  change: { weekStart: Date; today: Date; amountChanged: boolean; costCentreChanged: boolean }
) => {
  const fields: { baseline_fte_value?: string; correction_month?: string; correction_count?: string } = {};
  if (!loaded) return fields;

  // Changing the client moves this document to a different reporting key, and the corrections
  // card groups by cost centre. Carrying the record across would attribute the old cost centre's
  // previous value to the new one, so drop it and treat the row as a fresh allocation.
  if (change.costCentreChanged) return fields;

  if (loaded.baselineFteValue !== null) fields.baseline_fte_value = loaded.baselineFteValue.toString();
  if (loaded.correctionMonth !== null) fields.correction_month = loaded.correctionMonth;
  if (loaded.correctionCount > 0) fields.correction_count = loaded.correctionCount.toString();

  // Only an FTE change is a correction, but existing fields are still carried through above:
  // a PUT replaces the whole content object.
  if (!change.amountChanged) return fields;
  if (monthValue(getOwningMonth(change.weekStart)) >= monthValue(change.today)) return fields;

  const currentMonthKey = format(change.today, 'yyyy-MM');
  if (loaded.correctionMonth === currentMonthKey) {
    fields.correction_count = (loaded.correctionCount + 1).toString();
  } else {
    fields.baseline_fte_value = loaded.amount.toString();
    fields.correction_month = currentMonthKey;
    fields.correction_count = '1';
  }
  return fields;
};

type EmployeeAllocation = {
  employee: TeamMember;
  allocations: AllocationRow[];
};

type MultiWeekGridProps = {
  currentDate: Date | null;
  setCurrentDate: (date: Date) => void;
  // Optional: the grid refetches itself after a save. Only pages with a companion table to
  // refresh need to pass this.
  onSaveSuccess?: () => void;
  initialLoading: boolean;
};

const ClientSelect = ({ 
  clients, 
  value, 
  onValueChange,
  disabled 
}: { 
  clients: AiReportData[], 
  value: string, 
  onValueChange: (displayName: string) => void,
  disabled?: boolean 
}) => {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');

  const sortedClients = useMemo(() => {
    const validClients = (clients || []).filter(c => c && c.DisplayName);
    return [...validClients].sort((a, b) => {
      const specialClients = ['PTO', 'Unallocated'];
      const aIsSpecial = specialClients.includes(a.DisplayName);
      const bIsSpecial = specialClients.includes(b.DisplayName);
      if (aIsSpecial && !bIsSpecial) return -1;
      if (!aIsSpecial && bIsSpecial) return 1;
      if (aIsSpecial && bIsSpecial) return a.DisplayName === 'Unallocated' ? -1 : 1;
      return (a.DisplayName || '').localeCompare(b.DisplayName || '');
    });
  }, [clients]);

  const filteredClients = useMemo(() => {
    const s = (search || '').toLowerCase().trim();
    if (!s) return sortedClients;
    return sortedClients.filter(c => 
      (c.DisplayName || '').toLowerCase().includes(s) || 
      (c.Code && c.Code.toLowerCase().includes(s))
    );
  }, [search, sortedClients]);

  const selectedClient = useMemo(() => {
    if (!value) return null;
    const trimmed = String(value).trim();
    return (clients || []).find(c => c && String(c.DisplayName || '').trim() === trimmed);
  }, [clients, value]);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          role="combobox"
          aria-expanded={open}
          className="w-full justify-between font-normal"
          disabled={disabled}
        >
          <span className="truncate">
            {selectedClient ? selectedClient.DisplayName : (value || "Select Client...")}
          </span>
          <Check className="ml-2 h-4 w-4 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[--radix-popover-trigger-width] p-0" align="start">
        <Command shouldFilter={false}>
          <CommandInput 
            placeholder="Search name or code..." 
            value={search}
            onValueChange={setSearch}
          />
          <CommandList className="max-h-64 overflow-y-auto">
            <CommandEmpty>No clients found.</CommandEmpty>
            <CommandGroup>
              {filteredClients.map((cc, idx) => (
                <CommandItem
                  key={`${cc.DisplayName}-${cc.Code || idx}`}
                  value={`${cc.DisplayName} ${cc.Code || ''}`}
                  onSelect={() => {
                    onValueChange(cc.DisplayName);
                    setOpen(false);
                    setSearch('');
                  }}
                >
                  <Check
                    className={cn(
                      "mr-2 h-4 w-4",
                      String(value || '').trim() === String(cc.DisplayName || '').trim() ? "opacity-100" : "opacity-0"
                    )}
                  />
                  <div className="flex flex-col">
                      <span>{cc.DisplayName}</span>
                      <span className="text-xs text-muted-foreground">{cc.Code || 'No Code'}</span>
                  </div>
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
};

const EmployeeSelect = ({ 
  employees, 
  onValueChange,
  value,
  disabled,
}: { 
  employees: TeamMember[], 
  onValueChange: (value: string) => void,
  value: string,
  disabled?: boolean,
}) => {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');

  const sortedEmployees = useMemo(() => {
    return [...(employees || [])].sort((a, b) => getFullName(a).localeCompare(getFullName(b)));
  }, [employees]);

  const filteredEmployees = useMemo(() => {
    if (!search) return sortedEmployees;
    const s = search.toLowerCase();
    return sortedEmployees.filter(e => getFullName(e).toLowerCase().includes(s));
  }, [search, sortedEmployees]);

  const selectedEmployee = useMemo(() => {
    return (employees || []).find(e => e && getPersonId(e) === value);
  }, [employees, value]);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          role="combobox"
          aria-expanded={open}
          className="w-[200px] justify-between font-normal"
          disabled={disabled}
        >
          <span className="truncate">
            {selectedEmployee ? getFullName(selectedEmployee) : "Load Employee..."}
          </span>
          <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[200px] p-0" align="start">
        <Command shouldFilter={false}>
          <CommandInput 
            placeholder="Search employee..." 
            value={search}
            onValueChange={setSearch}
          />
          <CommandList className="max-h-64 overflow-y-auto">
            <CommandEmpty>No employees found.</CommandEmpty>
            <CommandGroup>
              {filteredEmployees.map((e) => (
                <CommandItem
                  key={getPersonId(e)}
                  value={`${getFullName(e)}|${getPersonId(e)}`}
                  onSelect={() => {
                    onValueChange(getPersonId(e));
                    setOpen(false);
                    setSearch('');
                  }}
                >
                  <Check
                    className={cn(
                      "mr-2 h-4 w-4",
                      value === getPersonId(e) ? "opacity-100" : "opacity-0"
                    )}
                  />
                  <span>{getFullName(e)}</span>
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
};

const ManagerSelect = ({ 
  managers, 
  onValueChange,
  value,
  disabled
}: { 
  managers: {id: string, name: string}[]|null, 
  onValueChange: (value: string) => void,
  value?: string,
  disabled?: boolean
}) => {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');

  const sortedManagers = useMemo(() => {
      return [...(managers || [])].sort((a,b) => a.name.localeCompare(b.name));
  }, [managers]);

  const filteredManagers = useMemo(() => {
    const list = sortedManagers;
    if (!search) return list;
    const s = search.toLowerCase();
    return list.filter(m => m.name.toLowerCase().includes(s));
  }, [search, sortedManagers]);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          role="combobox"
          aria-expanded={open}
          className="w-[200px] justify-between font-normal"
          disabled={disabled}
        >
          <span className="truncate">
            {value || "Load Team..."}
          </span>
          <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[200px] p-0" align="start">
        <Command shouldFilter={false}>
          <CommandInput 
            placeholder="Search manager..." 
            value={search}
            onValueChange={setSearch}
          />
          <CommandList className="max-h-64 overflow-y-auto">
            <CommandEmpty>No managers found.</CommandEmpty>
            <CommandGroup>
              {filteredManagers.map((m) => (
                <CommandItem
                  key={m.id}
                  value={m.name}
                  onSelect={() => {
                    const newValue = m.name === value ? "" : m.name;
                    onValueChange(newValue);
                    setOpen(false);
                    setSearch('');
                  }}
                >
                  <Check
                    className={cn(
                      "mr-2 h-4 w-4",
                      value === m.name ? "opacity-100" : "opacity-0"
                    )}
                  />
                  <span>{m.name}</span>
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
};


export function MultiWeekGrid({ currentDate, setCurrentDate, onSaveSuccess, initialLoading }: MultiWeekGridProps) {
  const [activeAllocations, setActiveAllocations] = useState<EmployeeAllocation[]>([]);
  const [pendingDeletions, setPendingDeletions] = useState<string[]>([]);
  const [allEmployees, setAllEmployees] = useState<TeamMember[]>([]);
  const [managers, setManagers] = useState<{id: string, name: string}[]>([]);
  const [clients, setClients] = useState<AiReportData[]>([]);
  const [internalLoading, setInternalLoading] = useState(true);
  const [monthDataCache, setMonthDataCache] = useState<WeeklyAllocation[]>([]);
  const [startOfCurrentWeek, setStartOfCurrentWeek] = useState<Date | null>(null);
  const [todayRef, setTodayRef] = useState<Date | null>(null);
  const [selectedEmployeeToAdd, setSelectedEmployeeToAdd] = useState('');
  const [selectedManager, setSelectedManager] = useState<string>('');
  const [isSaving, setIsSaving] = useState(false);
  const [hasMounted, setHasMounted] = useState(false);
  
  const { toast } = useToast();
  
  const isLoading = initialLoading || internalLoading;

  useEffect(() => {
    setHasMounted(true);
    const now = new Date();
    setTodayRef(now);
    setStartOfCurrentWeek(startOfWeek(now, { weekStartsOn: 1 }));
  }, []);

  const { weeks, monthLabel } = useMemo(() => {
    if (!currentDate || !isValid(currentDate)) return { weeks: [], monthLabel: 'Loading...' };
    const monthWeeks: AllocationWeek[] = getWeeksForMonth(currentDate);
    return { weeks: monthWeeks, monthLabel: format(currentDate, 'MMM yyyy') };
  }, [currentDate]);

  const isWeekEditable = useCallback((weekStartDate: Date) => {
    if (!todayRef) return false;

    // Weeks whose owning month falls outside the EDITABLE_MONTHS_BACK window are closed.
    return monthValue(getOwningMonth(weekStartDate)) >= (monthValue(todayRef) - EDITABLE_MONTHS_BACK);
  }, [todayRef]);

  const isMonthLocked = useMemo(() => {
    if (weeks.length === 0 || !todayRef) return false;
    return weeks.every(w => !isWeekEditable(w.startDate));
  }, [weeks, isWeekEditable, todayRef]);

  // fetchMonthData loads the previous month's documents as well and groups them into the
  // same client rows, so deletion has to reach beyond the weeks currently rendered or
  // those documents survive and rebuild the row on the next load. Locked weeks stay out.
  const deletableWeekKeys = useMemo(() => {
    if (!currentDate || !isValid(currentDate)) return new Set<string>();
    const prevMonthWeeks = getWeeksForMonth(subMonths(currentDate, 1)) || [];
    return new Set(
      [...weeks, ...prevMonthWeeks]
        .filter(w => isWeekEditable(w.startDate))
        .map(w => formatDateKey(w.startDate))
    );
  }, [currentDate, weeks, isWeekEditable]);

  // Resolve every document behind a row from the fetched documents, not just from the row's
  // own docIds map, which hydrateCells fills for the visible month only. Rows are grouped by
  // cost_center_name, so this also catches documents differing only in cost_center_number,
  // which collide on the same docIds key and leave the loser undeletable.
  const collectRowDocIds = useCallback((employeeId: string, row: AllocationRow) => {
    const fromRow = Object.entries(row.docIds)
      .filter(([weekKey, id]) => id && deletableWeekKeys.has(weekKey))
      .map(([, id]) => id);

    const clientName = String(row.clientName || '').trim();
    const prefix = `[${employeeId}]`;
    const fromCache = !clientName ? [] : monthDataCache
      .filter(doc =>
        doc?.content &&
        String(doc.content.allocation_name || '').startsWith(prefix) &&
        String(doc.content.cost_center_name || '').trim() === clientName &&
        deletableWeekKeys.has(doc.content.allocation_date)
      )
      .map(doc => doc.id);

    return Array.from(new Set([...fromRow, ...fromCache].filter(Boolean)));
  }, [monthDataCache, deletableWeekKeys]);

  // pendingDeletions holds ids resolved against the month that was on screen when the row
  // was removed. Without this reset, navigating to another month and saving deletes the
  // previous month's documents with nothing on screen to explain it.
  useEffect(() => {
    setPendingDeletions([]);
  }, [currentDate]);

  const fetchMonthData = useCallback(async () => {
    if (!currentDate || !isValid(currentDate) || (weeks?.length || 0) === 0) return;
    setInternalLoading(true);
    try {
        const currentMonthWeekKeys = weeks.map(w => formatDateKey(w.startDate));
        const prevMonthWeeks = getWeeksForMonth(subMonths(currentDate, 1));
        const prevMonthWeekKeys = (prevMonthWeeks || []).map(w => formatDateKey(w.startDate));
        const allRelevantWeeks = Array.from(new Set([...currentMonthWeekKeys, ...prevMonthWeekKeys]));
        
        const weeklyDataPromises = allRelevantWeeks.map(weekKey => 
            fetch(`/domo/datastores/v1/collections/weekly_allocation/documents?q=content.allocation_date='${weekKey}'`).then(res => res.ok ? res.json() : [])
        );
        const nestedAllocations = await Promise.all(weeklyDataPromises);
        const allRelevantAllocations: WeeklyAllocation[] = nestedAllocations.flat().filter(a => a && a.content);
        setMonthDataCache(allRelevantAllocations);
        
        setActiveAllocations(prev => (prev || []).map(empAlloc => {
            if (!empAlloc?.employee) return empAlloc;
            const empId = empAlloc.employee.person_id || empAlloc.employee.Person_Number;
            const employeeIdString = `[${empId}]`;
            
            const empAllAllocs = allRelevantAllocations.filter(alloc =>
                alloc?.content?.allocation_name &&
                String(alloc.content.allocation_name).startsWith(employeeIdString) &&
                Number.isFinite(parseFloat(alloc.content?.allocation_amount || ''))
            );
            
            const clientNames = new Set<string>();
            empAllAllocs.forEach(a => { if (a?.content?.cost_center_name) clientNames.add(String(a.content.cost_center_name).trim()); });
            
            if (clientNames.size === 0) {
                return { ...empAlloc, allocations: [{ id: uuidv4(), clientId: '', clientName: '', weeklyFtes: {}, docIds: {}, loaded: {} }] };
            }
            
            const newAllocationRows: AllocationRow[] = Array.from(clientNames).map(clientName => {
                const clientSpecificAllocs = empAllAllocs.filter(a => String(a?.content?.cost_center_name || '').trim() === clientName);
                const masterClient = (clients || []).find(c => c && String(c.DisplayName || '').trim() === clientName);
                return {
                    id: uuidv4(),
                    clientId: (masterClient?.Code || clientSpecificAllocs[0]?.content?.cost_center_number || '').trim(),
                    clientName,
                    ...hydrateCells(clientSpecificAllocs, currentMonthWeekKeys)
                };
            });
            return { ...empAlloc, allocations: newAllocationRows };
        }));
    } catch (error) {
        writeLog('MultiWeekGrid', 'error', 'Error pre-fetching relevant month data', error);
    } finally {
        setInternalLoading(false);
    }
  }, [currentDate, weeks, clients]);

  useEffect(() => {
    if (hasMounted && currentDate && (clients?.length || 0) > 0) {
        fetchMonthData();
    }
  }, [currentDate, fetchMonthData, hasMounted, clients.length]);

  const fetchData = useCallback(async () => {
    setInternalLoading(true);
    try {
      const [empResponse, clientResponse] = await Promise.all([
        fetch(`/data/v1/consolidated_hr_fte_report_view`),
        fetch(`/data/v1/fte_tool_cost_center_guidance_view`),
      ]);
      const rawEmpData = empResponse.ok ? await empResponse.json() : [];
      const rawClientData = clientResponse.ok ? await clientResponse.json() : [];
      
      const empData: TeamMember[] = normalizeHrRoster(rawEmpData);

      const clientData: AiReportData[] = (Array.isArray(rawClientData) ? rawClientData : []).filter(c => c && c.DisplayName);
      setAllEmployees(empData);
      const staticClients: AiReportData[] = [
        { Code: 'UNALLOCATED', Name: 'Unallocated', DisplayName: 'Unallocated', RollsUpTo: '' },
        { Code: 'PTO', Name: 'PTO', DisplayName: 'PTO', RollsUpTo: '' },
      ];
      setClients([...staticClients, ...clientData]);
      
      const uniqueManagerNames = Array.from(
        new Set(
          empData
            .map(e => e?.manager || e?.First_Reviewer_Name)
            .filter(m => typeof m === 'string' && m)
        )
      ).sort().map(name => ({ id: name as string, name: name as string }));
      setManagers(uniqueManagerNames);

      setActiveAllocations([]);
    } catch (error) {
      writeLog('MultiWeekGrid', 'error', 'Failed to fetch metadata', error);
      toast({ variant: 'destructive', title: 'Failed to fetch metadata' });
    } finally {
      setInternalLoading(false);
    }
  }, [toast]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  const availableEmployees = useMemo(() => {
    const activeIds = new Set((activeAllocations || []).map(a => a?.employee?.person_id || a?.employee?.Person_Number).filter(Boolean));
    return (allEmployees || []).filter(e => {
        const id = e?.person_id || e?.Person_Number;
        return id && !activeIds.has(id);
    });
  }, [allEmployees, activeAllocations]);

  const handlePrevMonth = () => { if (currentDate && isValid(currentDate)) setCurrentDate(subMonths(currentDate, 1)); };
  const handleNextMonth = () => { if (currentDate && isValid(currentDate)) setCurrentDate(addMonths(currentDate, 1)); };

  const handleAddEmployee = (employeeId: string) => {
    if (!employeeId || !currentDate) return;
    setSelectedEmployeeToAdd(employeeId);
    setSelectedManager('');
    const employeeToAdd = allEmployees.find(e => e && (e.person_id === employeeId || e.Person_Number === employeeId));
    if (employeeToAdd) {
      const id = employeeToAdd.person_id || employeeToAdd.Person_Number;
      if (activeAllocations.some(a => (a.employee?.person_id || a.employee?.Person_Number) === id)) {
          toast({ variant: 'destructive', title: 'Employee already in grid' }); return;
      }
      const empIdStr = `[${id}]`;
      const currentKeys = weeks.map(w => formatDateKey(w.startDate));
      const empAllocs = monthDataCache.filter(a => a?.content?.allocation_name && String(a.content.allocation_name).startsWith(empIdStr) && Number.isFinite(parseFloat(a.content?.allocation_amount || '')));
      let initialRows: AllocationRow[] = [];
      if (empAllocs.length === 0) {
          initialRows = [{ id: uuidv4(), clientId: '', clientName: '', weeklyFtes: {}, docIds: {}, loaded: {} }];
      } else {
          const names = Array.from(new Set(empAllocs.map(a => String(a?.content?.cost_center_name || '').trim()).filter(Boolean)));
          initialRows = names.map(name => {
              const cAllocs = empAllocs.filter(a => String(a?.content?.cost_center_name || '').trim() === name);
              const master = (clients || []).find(c => c && String(c.DisplayName || '').trim() === name);
              return { id: uuidv4(), clientId: (master?.Code || cAllocs[0]?.content?.cost_center_number || '').trim(), clientName: name, ...hydrateCells(cAllocs, currentKeys) };
          });
      }
      setActiveAllocations(prev => [{ employee: employeeToAdd, allocations: initialRows }, ...prev]);
    }
    setTimeout(() => setSelectedEmployeeToAdd(''), 0);
  };

  const handleAddManagerTeam = (managerName: string) => {
    if (!currentDate) return;
    if (!managerName) {
        setSelectedManager('');
        setActiveAllocations([]);
        return;
    }
    setSelectedManager(managerName);
    setSelectedEmployeeToAdd('');
    const team = allEmployees.filter(e => e && (e.manager === managerName || e.First_Reviewer_Name === managerName));
    if (team.length === 0) { 
        toast({ title: 'No employees found for this manager.' }); 
        setActiveAllocations([]);
        return; 
    }
    const currentKeys = weeks.map(w => formatDateKey(w.startDate));
    const newAllocations = team.map(employee => {
        const id = employee.person_id || employee.Person_Number;
        const empIdStr = `[${id}]`;
        const empAllocs = monthDataCache.filter(a => a?.content?.allocation_name && String(a.content.allocation_name).startsWith(empIdStr) && Number.isFinite(parseFloat(a.content?.allocation_amount || '')));
        let rows: AllocationRow[] = [];
        if (empAllocs.length === 0) {
            rows = [{ id: uuidv4(), clientId: '', clientName: '', weeklyFtes: {}, docIds: {}, loaded: {} }];
        } else {
            const names = Array.from(new Set(empAllocs.map(a => String(a?.content?.cost_center_name || '').trim()).filter(Boolean)));
            rows = names.map(name => {
                const cAllocs = empAllocs.filter(a => String(a?.content?.cost_center_name || '').trim() === name);
                const master = (clients || []).find(c => c && String(c.DisplayName || '').trim() === name);
                return { id: uuidv4(), clientId: (master?.Code || cAllocs[0]?.content?.cost_center_number || '').trim(), clientName: name, ...hydrateCells(cAllocs, currentKeys) };
            });
        }
        return { employee, allocations: rows };
    });
    setActiveAllocations(newAllocations);
    toast({ title: 'Team Loaded', description: `Loaded ${newAllocations.length} members for ${managerName}.` });
  };

  /**
   * Take an employee off the grid without touching their documents.
   *
   * This must never delete. handleAddEmployee hydrates an added person's existing allocations out
   * of monthDataCache, which holds every document for the month regardless of manager, so a name
   * picked by accident arrives populated with allocations somebody else owns. Deleting here
   * destroyed another manager's data on a click that reads as tidying up the view.
   *
   * Un-allocating stays explicit: clear the cells, or delete the client row.
   */
  const handleRemoveEmployee = (employeeId: string) => {
      const empId = String(employeeId);
      setActiveAllocations(prev => prev.filter(a => String(a.employee?.person_id || a.employee?.Person_Number) !== empId));
      setSelectedManager('');
  };

  const handleFteChange = (employeeId: string, allocId: string, weekKey: string, val: string) => {
    // Set '' rather than deleting the key: the save loop iterates the keys it finds,
    // so a deleted key would leave an existing document untouched forever.
    const fte = parseCell(val);
    setActiveAllocations(prev => (prev || []).map(ea => (ea.employee?.person_id || ea.employee?.Person_Number) === employeeId ? { ...ea, allocations: ea.allocations.map(a => a.id === allocId ? { ...a, weeklyFtes: { ...a.weeklyFtes, [weekKey]: fte } } : a) } : ea));
  };

  const handleMonthlyFteChange = (employeeId: string, allocId: string, val: string) => {
    const monthlyFte = parseCell(val);
    setActiveAllocations(prev => (prev || []).map(ea => {
        if ((ea.employee?.person_id || ea.employee?.Person_Number) === employeeId) {
          return { ...ea, allocations: ea.allocations.map(a => {
            if (a.id === allocId) {
              const updated = { ...a.weeklyFtes };
              weeks.forEach(week => {
                const key = formatDateKey(week.startDate);
                if (isWeekEditable(week.startDate)) updated[key] = monthlyFte;
              });
              return { ...a, weeklyFtes: updated };
            }
            return a;
          })};
        }
        return ea;
    }));
  };
  
  const handleClientChange = (employeeId: string, allocId: string, name: string) => {
     setActiveAllocations(prev => (prev || []).map(ea => {
        if ((ea.employee?.person_id || ea.employee?.Person_Number) === employeeId) {
            return { ...ea, allocations: ea.allocations.map(a => {
                if (a.id === allocId) {
                    const trimmed = String(name || '').trim();
                    const master = (clients || []).find(cc => cc && String(cc.DisplayName || '').trim() === trimmed);
                    return { ...a, clientId: (master?.Code || '').trim(), clientName: trimmed };
                }
                return a;
            })};
        }
        return ea;
    }));
  };

  const handleAddAllocationRow = (employeeId: string) => {
    setActiveAllocations(prev => (prev || []).map(ea => (ea.employee?.person_id || ea.employee?.Person_Number) === employeeId ? { ...ea, allocations: [...ea.allocations, { id: uuidv4(), clientId: '', clientName: '', weeklyFtes: {}, docIds: {}, loaded: {} }] } : ea));
  };

  const handleRemoveAllocationRow = (employeeId: string, allocId: string) => {
    const empId = String(employeeId);
    const empAlloc = activeAllocations.find(ea => String(ea.employee?.person_id || ea.employee?.Person_Number) === empId);
    const rowToRemove = empAlloc?.allocations.find(a => a.id === allocId);
    if (rowToRemove) {
        const ids = collectRowDocIds(empId, rowToRemove);

        // A row built from the collection that resolves to nothing deletable must not be
        // dropped from the grid: that reports a delete which cannot happen, and is the exact
        // failure users see as the entry coming back after a reload. The two causes need
        // different messages — a week whose owning month has closed is not a lookup failure.
        if (ids.length === 0 && Object.keys(rowToRemove.loaded).length > 0) {
            const weekKeys = Object.keys(rowToRemove.docIds);
            const lockedOnly = weekKeys.length > 0 && weekKeys.every(k => !deletableWeekKeys.has(k));
            toast({
                variant: 'destructive',
                title: 'Cannot Delete Row',
                description: lockedOnly
                    ? 'This row only has allocations in weeks that are closed for editing.'
                    : 'This row could not be matched to its saved records. Reload the page and try again.',
            });
            return;
        }
        setPendingDeletions(prev => Array.from(new Set([...prev, ...ids])));
    }
    setActiveAllocations(prev => (prev || []).map(ea => {
        if (String(ea.employee?.person_id || ea.employee?.Person_Number) !== empId) return ea;
        const remaining = ea.allocations.filter(a => a.id !== allocId);
        // Every employee renders at least one row, so removing the last one collapses to a fresh
        // blank row rather than an empty array — the same shape handleAddEmployee and
        // handleAddManagerTeam use for an employee with no documents. Its documents are still
        // queued for deletion above.
        return {
            ...ea,
            allocations: remaining.length > 0
                ? remaining
                : [{ id: uuidv4(), clientId: '', clientName: '', weeklyFtes: {}, docIds: {}, loaded: {} }],
        };
    }));
  };

  const handleSave = async () => {
    if (!todayRef) return;
    setIsSaving(true);
    // Labelled rather than bare promises: Promise.all resolves for a 4xx, so the status has
    // to be read back per operation or the real cause never reaches the log.
    const operations: SaveOperation[] = [];
    let invalid = false;

    // Keyed by week so the save can recover each cell's start date, which decides whether an
    // edit is retroactive (and therefore a correction).
    const editableWeeks = new Map<string, Date>(
      weeks.filter(w => isWeekEditable(w.startDate)).map(w => [formatDateKey(w.startDate), w.startDate])
    );

    // Execute pending deletions first
    pendingDeletions.forEach(id => {
        operations.push({
            kind: 'DELETE',
            docId: id,
            promise: fetch(`/domo/datastores/v1/collections/weekly_allocation/documents/${id}`, { method: 'DELETE' }),
        });
    });

    activeAllocations.forEach(ea => {
      if (!ea?.employee) return;
      const empId = ea.employee.person_id || ea.employee.Person_Number;
      const empName = ea.employee.full_name || ea.employee.Full_Name;

      ea.allocations.forEach(alloc => {
        Object.entries(alloc.weeklyFtes).forEach(([key, fte]) => {
          const weekStart = editableWeeks.get(key);
          if (weekStart) {
            const existingDocId = alloc.docIds[key];
            const loaded = alloc.loaded[key];
            const costCenterNumber = alloc.clientId || alloc.clientName;
            const content = {
                allocation_date: key,
                allocation_name: `[${empId}] ${empName}`,
                employee_id: empId,
                cost_center_name: alloc.clientName,
                cost_center_number: costCenterNumber,
                allocation_amount: (typeof fte === 'number' ? fte.toString() : '0')
            };

            // 0 is a real value and must persist — downstream reporting divides by the
            // number of weeks that have rows, so a missing row and a zero row differ.
            // The typeof guard is load-bearing: '' >= 0 is true in JS, which would write
            // blank cells as zeros and break clearing.
            if (typeof fte === 'number' && fte >= 0) {
                if (!alloc.clientName) {
                    invalid = true;
                    toast({ variant: 'destructive', title: 'Missing Client', description: `Please select a client for ${empName}.` });
                    return;
                }
                
                if (existingDocId) {
                    // Skip untouched cells. Without this every save rewrites every editable cell
                    // of every loaded employee, which bumps __modified__ on rows nobody edited
                    // and inflates correction_count.
                    const amountChanged = !loaded || loaded.amount !== fte;
                    const costCentreChanged = !loaded
                        || loaded.costCenterName !== alloc.clientName
                        || loaded.costCenterNumber !== costCenterNumber;
                    if (!amountChanged && !costCentreChanged) return;

                    const correction = correctionFieldsFor(loaded, { weekStart, today: todayRef, amountChanged, costCentreChanged });
                    operations.push({
                        kind: 'PUT',
                        docId: existingDocId,
                        weekKey: key,
                        promise: fetch(`/domo/datastores/v1/collections/weekly_allocation/documents/${existingDocId}`, {
                            method: 'PUT',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ content: { ...content, ...correction } })
                        }),
                    });
                } else {
                    operations.push({
                        kind: 'POST',
                        weekKey: key,
                        promise: fetch('/domo/datastores/v1/collections/weekly_allocation/documents/', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ content })
                        }),
                    });
                }
            } else if (existingDocId) {
                // Cleared cell (or a negative, which is rejected the same way as before).
                // Clearing remains the way to un-allocate.
                operations.push({
                    kind: 'DELETE',
                    docId: existingDocId,
                    weekKey: key,
                    promise: fetch(`/domo/datastores/v1/collections/weekly_allocation/documents/${existingDocId}`, { method: 'DELETE' }),
                });
            }
          }
        });
      });
    });

    if (invalid) { setIsSaving(false); return; }
    if (operations.length === 0 && pendingDeletions.length === 0) { toast({ title: 'No changes to save.' }); setIsSaving(false); return; }
    
    try {
        const results = await Promise.all(operations.map(op => op.promise));
        const failures = operations
            .map((op, i) => ({ op, res: results[i] }))
            .filter(({ res }) => !res.ok);

        if (failures.length > 0) {
            writeLog('MultiWeekGrid', 'error', 'Save operations failed', {
                failures: failures.map(({ op, res }) => ({
                    kind: op.kind,
                    docId: op.docId,
                    weekKey: op.weekKey,
                    status: res.status,
                })),
            });
            const statuses = Array.from(new Set(failures.map(({ res }) => res.status))).join(', ');
            throw new Error(
                `${failures.length} of ${operations.length} changes failed (HTTP ${statuses}). ` +
                'Some changes may have been applied — reload the page before retrying.'
            );
        }

        toast({ title: 'Allocations Saved', description: 'Your changes have been synced successfully.' });
        // Re-read the collection so docIds and loaded match what is actually stored. Without
        // this, a document created by the POST above is never given an id in state, and the
        // delete that follows resolves to nothing and silently does nothing.
        setPendingDeletions([]);
        await fetchMonthData();
        onSaveSuccess?.();
    } catch (error: any) { 
        writeLog('MultiWeekGrid', 'error', 'Save failed', error); 
        toast({ variant: 'destructive', title: 'Save Failed', description: error.message }); 
    } finally { 
        setIsSaving(false); 
    }
  };

  const sortedAllocations = useMemo(() => {
    return [...activeAllocations].sort((a, b) => {
      const nameA = a.employee?.full_name || a.employee?.Full_Name || '';
      const nameB = b.employee?.full_name || b.employee?.Full_Name || '';
      return nameA.localeCompare(nameB);
    });
  }, [activeAllocations]);

  return (
    <TooltipProvider>
      <Card>
        <CardHeader>
          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
            <div>
              <div className="flex items-center gap-3">
                <CardTitle>Monthly Allocation Grid</CardTitle>
                {isMonthLocked && (
                    <Badge variant="outline" className="bg-muted text-muted-foreground border-muted-foreground/30 px-3 py-1">
                        <Lock className="h-3.5 w-3.5 mr-2" /> Read Only
                    </Badge>
                )}
              </div>
              <CardDescription>
                Edits permitted for {EDITABLE_WINDOW_LABEL} only. Sorted by first name.
              </CardDescription>
            </div>
            <div className="flex items-center gap-2 flex-wrap">
              <EmployeeSelect employees={availableEmployees} onValueChange={handleAddEmployee} value={selectedEmployeeToAdd} disabled={isLoading || isSaving} />
              <ManagerSelect managers={managers} onValueChange={handleAddManagerTeam} value={selectedManager} disabled={isLoading || isSaving} />
              <Button variant="outline" size="icon" onClick={handlePrevMonth} disabled={isLoading || isSaving}><ChevronLeft className="h-4 w-4" /></Button>
              <span className="text-sm font-medium w-32 text-center">{isLoading ? <Skeleton className="h-5 w-24 mx-auto" /> : monthLabel}</span>
              <Button variant="outline" size="icon" onClick={handleNextMonth} disabled={isLoading || isSaving}><ChevronRight className="h-4 w-4" /></Button>
              <Button onClick={handleSave} disabled={isLoading || isSaving || (activeAllocations?.length || 0) === 0 || isMonthLocked}>
                {isSaving ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : null}
                {isSaving ? 'Saving...' : 'Save All'}
              </Button>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="min-w-[180px] sticky left-0 bg-card z-10">Employee</TableHead>
                  <TableHead className="min-w-[200px]">Client Name</TableHead>
                  <TableHead className="p-2 w-28">Client Code</TableHead>
                  <TableHead className="text-center min-w-[120px]">Bulk Entry</TableHead>
                  {(weeks || []).map(week => {
                    const isCurrent = startOfCurrentWeek && isSameDay(startOfWeek(week.startDate, { weekStartsOn: 1 }), startOfCurrentWeek);
                    const locked = !isWeekEditable(week.startDate);
                    return (
                      <TableHead key={week.startDate.toISOString()} className={cn("text-center min-w-[120px] transition-colors", { "bg-muted/40": locked, "bg-primary/10": isCurrent })}>
                        <div className='flex items-center justify-center gap-2'>
                          {locked && <Lock className="h-3.5 w-3.5 text-muted-foreground" />}
                          <span>{week.label}</span>
                        </div>
                        {isCurrent && <Badge variant="default" className="w-fit mx-auto mt-1">Current</Badge>}
                      </TableHead>
                    )
                  })}
                  <TableHead className="w-[80px]"> </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {!hasMounted || isLoading ? (
                  <TableRow><TableCell colSpan={(weeks?.length || 0) + 5}><div className="space-y-4 py-8"><Skeleton className="h-10 w-full" /><Skeleton className="h-10 w-full" /></div></TableCell></TableRow>
                ) : (sortedAllocations?.length || 0) === 0 ? (
                  <TableRow><TableCell colSpan={(weeks?.length || 0) + 5} className="text-center h-24 text-muted-foreground">Select an employee or manager to begin.</TableCell></TableRow>
                ) : sortedAllocations.map(({ employee, allocations }) => {
                  if (!employee) return null;
                  const weeklyTotals = (weeks || []).map(week => {
                    const weekKey = formatDateKey(week.startDate);
                    return (allocations || []).reduce((t, a) => t + (a.weeklyFtes[weekKey] || 0), 0);
                  });
                  return (
                    <Fragment key={employee.person_id || employee.Person_Number}>
                      <TableRow className="bg-muted/50 hover:bg-muted">
                        <TableCell className="sticky left-0 bg-muted/50 z-10 flex items-center gap-2">
                          <div>
                            <div className="flex items-center gap-2">
                                <span className="font-semibold">{employee.full_name || employee.Full_Name || ''}</span>
                                {(employee.fte || employee.FTE) && <Badge variant="secondary">FTE: {employee.fte || employee.FTE}</Badge>}
                            </div>
                            <div className="text-xs text-muted-foreground font-normal">{employee.title || employee.Market_Facing_Title || ''}</div>
                          </div>
                        </TableCell>
                        <TableCell colSpan={3}></TableCell>
                        {weeklyTotals.map((total, index) => {
                            const empType = (employee.employment_type || employee.Employment_Type || '').toLowerCase();
                            const isPartTime = empType.includes('part');
                            const isOver = total > 1.0;
                            const isPTW = isPartTime && total >= 0.6 && total <= 1.0;
                            let msg = '';
                            if (isOver) msg = 'Allocated over 1.0 FTE.'; else if (isPTW) msg = 'Part-time employee allocated at/above 0.6 FTE.';
                            return (
                              <TableCell key={index} className="text-center font-semibold" colSpan={1}>
                                  <Tooltip>
                                      <TooltipTrigger asChild>
                                          <span className={cn("text-muted-foreground", isPTW && "text-warning", isOver && "text-destructive")}>
                                              {total > 0 ? (Number.isNaN(total) ? '0.00' : total.toFixed(2)) : '-'}
                                          </span>
                                      </TooltipTrigger>
                                      {msg && <TooltipContent><p>{msg}</p></TooltipContent>}
                                  </Tooltip>
                              </TableCell>
                            )
                        })}
                        <TableCell className='text-right'>
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <Button variant="ghost" size="icon" onClick={() => handleRemoveEmployee(employee.person_id || employee.Person_Number)} disabled={isSaving || isMonthLocked}>
                                <X className="h-4 w-4 text-muted-foreground" />
                              </Button>
                            </TooltipTrigger>
                            <TooltipContent><p>Remove from grid (does not delete allocations)</p></TooltipContent>
                          </Tooltip>
                        </TableCell>
                      </TableRow>
                      {(allocations || []).map((alloc) => {
                        const weekKey0 = (weeks?.length || 0) > 0 ? formatDateKey(weeks[0].startDate) : '';
                        const bulkFteValue = weekKey0 ? alloc.weeklyFtes[weekKey0] : undefined;
                        // typeof, not truthiness: a bulk-entered 0 must display as 0.00, not blank.
                        const displayBulkFte = typeof bulkFteValue === 'number' ? bulkFteValue.toFixed(2) : '';

                        return (
                        <TableRow key={alloc.id}>
                          <TableCell className="sticky left-0 bg-card z-10"></TableCell>
                          <TableCell><ClientSelect clients={clients} value={alloc.clientName} onValueChange={(name) => handleClientChange(employee.person_id || employee.Person_Number, alloc.id, name)} disabled={isMonthLocked || isSaving} /></TableCell>
                          <TableCell className="p-2"><Input value={alloc.clientId} readOnly className="bg-muted w-24" placeholder="Code" /></TableCell>
                          <TableCell className="text-center"><Input type="number" step="0.05" min="0" placeholder="0.00" className="w-20 text-center mx-auto" value={displayBulkFte} onChange={(e) => handleMonthlyFteChange(employee.person_id || employee.Person_Number, alloc.id, e.target.value)} disabled={isMonthLocked || isSaving} /></TableCell>
                          {(weeks || []).map(week => {
                            const weekKey = formatDateKey(week.startDate);
                            const locked = !isWeekEditable(week.startDate);
                            const isCurrent = startOfCurrentWeek && isSameDay(startOfWeek(week.startDate, { weekStartsOn: 1 }), startOfCurrentWeek);
                            return (
                              <TableCell key={week.startDate.toISOString()} className={cn("text-center", {"bg-muted/40": locked, "bg-primary/10": isCurrent})}>
                                  <Input type="number" step="0.05" min="0" placeholder="0.00" className={cn("w-20 text-center mx-auto", { "bg-muted/50 cursor-not-allowed": locked })} value={alloc.weeklyFtes[weekKey] ?? ''} onChange={(e) => handleFteChange(employee.person_id || employee.Person_Number, alloc.id, weekKey, e.target.value)} disabled={locked || isSaving} readOnly={locked} />
                              </TableCell>
                            )
                          })}
                          <TableCell className='text-right'><Button variant="ghost" size="icon" onClick={() => handleRemoveAllocationRow(employee.person_id || employee.Person_Number, alloc.id)} disabled={isMonthLocked || isSaving}><Trash2 className="h-4 w-4 text-destructive" /></Button></TableCell>
                        </TableRow>
                      )})}
                      <TableRow>
                        <TableCell className="sticky left-0 bg-card z-10 py-2" colSpan={3}><Button variant="outline" size="sm" className="w-full justify-start" onClick={() => handleAddAllocationRow(employee.person_id || employee.Person_Number)} disabled={isSaving || isMonthLocked}><PlusCircle className="mr-2 h-4 w-4" /> Add Allocation</Button></TableCell>
                        <TableCell colSpan={(weeks?.length || 0) + 2}></TableCell>
                      </TableRow>
                    </Fragment>
                  );
                })}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>
    </TooltipProvider>
  );
}

