
'use client';

import { useState, useMemo, Fragment, useEffect, useCallback } from 'react';
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
import { ChevronLeft, ChevronRight, PlusCircle, Trash2, Check, ChevronsUpDown, Loader2, X } from 'lucide-react';
import { useCurrentUser } from '@/hooks/use-current-user';
import type { TeamMember, WeeklyTarget } from '@/types';
import { cn } from '@/lib/utils';
import { useToast } from '@/hooks/use-toast';
import { Skeleton } from '../ui/skeleton';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { v4 as uuidv4 } from 'uuid';
import { writeLog } from '@/lib/logger';
import { getFullName, getPersonId, normalizeHrRoster } from '@/lib/hr-roster';

type AiReportData = {
    Code: string;
    Name: string;
    DisplayName: string;
    RollsUpTo: string;
};

const quarters = ['Q1', 'Q2', 'Q3', 'Q4'];

const getQuarterStartDate = (year: number, quarter: string) => {
    const quarterMonth = (parseInt(quarter.substring(1)) - 1) * 3 + 1;
    return `${year}-${quarterMonth.toString().padStart(2, '0')}-01`;
}

type TargetRow = {
  id: string;
  clientId: string;
  clientName: string;
  quarterlyTargets: { [quarterKey: string]: number };
  // The document behind each quarter's cell. Without these the save path can only POST, so
  // editing a target duplicated it and removing a row left the document in place.
  docIds: { [quarterKey: string]: string };
  // Snapshot to diff against, so an untouched quarter is not rewritten on every save.
  loaded: { [quarterKey: string]: number };
  loadedClientId?: string;
  loadedClientName?: string;
};

/**
 * One pending write, carried alongside its request so a failure can be attributed.
 *
 * `fetch` only rejects on a network error, so a 4xx resolves normally and is invisible unless the
 * response is matched back to the operation that caused it.
 */
type SaveOperation = {
  kind: 'DELETE' | 'PUT' | 'POST';
  docId?: string;
  quarter?: string;
  promise: Promise<Response>;
};

const blankTargetRow = (): TargetRow => ({
  id: uuidv4(), clientId: '', clientName: '', quarterlyTargets: {}, docIds: {}, loaded: {},
});

/**
 * Build one employee's target rows from their documents, grouped by cost centre.
 *
 * Shared by the year fetch and both add paths, which previously each carried their own copy of
 * this grouping and all three dropped the document ids on the floor.
 */
const hydrateTargetRows = (docs: WeeklyTarget[]): TargetRow[] => {
  if (docs.length === 0) return [blankTargetRow()];

  const byCostCentre = new Map<string, TargetRow>();
  docs.forEach(doc => {
    const clientKey = doc.content.targets_cost_center_number;
    if (!byCostCentre.has(clientKey)) {
      byCostCentre.set(clientKey, {
        id: uuidv4(),
        clientId: clientKey,
        clientName: doc.content.targets_cost_center_name,
        quarterlyTargets: {},
        docIds: {},
        loaded: {},
        loadedClientId: clientKey,
        loadedClientName: doc.content.targets_cost_center_name,
      });
    }
    const row = byCostCentre.get(clientKey)!;
    const date = new Date(doc.content.targets_allocation_date);
    const quarter = quarters[Math.floor(date.getUTCMonth() / 3)];
    const amount = parseInt(doc.content.targets_allocation_amount, 10) || 0;
    row.quarterlyTargets[quarter] = amount;
    row.docIds[quarter] = doc.id;
    row.loaded[quarter] = amount;
  });

  return Array.from(byCostCentre.values());
};

type EmployeeTarget = {
  employee: TeamMember;
  targets: TargetRow[];
};

type QuarterlyTargetGridProps = {
  currentYear: number;
  setCurrentYear: (year: number) => void;
  onSaveSuccess: () => void;
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
    if (!search) return sortedClients;
    const s = search.toLowerCase();
    return sortedClients.filter(c => 
      c.DisplayName.toLowerCase().includes(s) || 
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
          <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
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

  const filteredEmployees = useMemo(() => {
    if (!search) return employees || [];
    const s = search.toLowerCase();
    return (employees || []).filter(e => getFullName(e).toLowerCase().includes(s));
  }, [search, employees]);

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

  const filteredManagers = useMemo(() => {
    if (!search) return managers || [];
    const s = search.toLowerCase();
    return (managers || []).filter(m => m.name.toLowerCase().includes(s));
  }, [search, managers]);

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


export function QuarterlyTargetGrid({ currentYear, setCurrentYear, onSaveSuccess }: QuarterlyTargetGridProps) {
  const [activeTargets, setActiveTargets] = useState<EmployeeTarget[]>([]);
  const [allEmployees, setAllEmployees] = useState<TeamMember[]>([]);
  const [managers, setManagers] = useState<{id: string, name: string}[]>([]);
  const [clients, setClients] = useState<AiReportData[]>([]);
  const [internalLoading, setInternalLoading] = useState(true);
  const [yearDataCache, setYearDataCache] = useState<WeeklyTarget[]>([]);
  const [selectedEmployeeToAdd, setSelectedEmployeeToAdd] = useState('');
  const [selectedManager, setSelectedManager] = useState<string>('');
  const [isSaving, setIsSaving] = useState(false);
  const [pendingDeletions, setPendingDeletions] = useState<string[]>([]);
  const [hasMounted, setHasMounted] = useState(false);

  const { isAdmin, loading: userLoading } = useCurrentUser();
  const { toast } = useToast();

  useEffect(() => {
    setHasMounted(true);
  }, []);

  // Queued ids belong to the year that was on screen when the row was removed. Without this reset,
  // changing year and saving would delete that other year's documents unprompted.
  useEffect(() => {
    setPendingDeletions([]);
  }, [currentYear]);

  const fetchYearData = useCallback(async () => {
    if (!currentYear) return;
    setInternalLoading(true);
    try {
        const quarterDates = quarters.map(q => getQuarterStartDate(currentYear, q));
        const requests = quarterDates.map(date => fetch(`/domo/datastores/v1/collections/weekly_targets/documents?q=content.targets_allocation_date='${date}'`));
        const responses = await Promise.all(requests);
        const allYearlyTargets: WeeklyTarget[] = (await Promise.all(responses.map(res => res.ok ? res.json() : []))).flat();
        const safeTargets = allYearlyTargets.filter(t => t && t.content);
        setYearDataCache(safeTargets);

        setActiveTargets(prev => (prev || []).map(empTarget => {
            if (!empTarget?.employee) return empTarget;
            const empId = empTarget.employee.person_id || empTarget.employee.Person_Number;
            const employeeIdString = `[${empId}]`;
            const employeeTargets = safeTargets.filter(t => t.content.targets_allocation_name?.startsWith(employeeIdString));
            return { ...empTarget, targets: hydrateTargetRows(employeeTargets) };
        }));

    } catch (error) {
        writeLog('QuarterlyTargetGrid', 'error', 'Failed to fetch year targets cache', error);
    } finally {
        setInternalLoading(false);
    }
  }, [currentYear]);

  useEffect(() => {
    if (hasMounted) {
        fetchYearData();
    }
  }, [currentYear, fetchYearData, hasMounted]);

  const fetchBaseData = useCallback(async () => {
    setInternalLoading(true);
    try {
      const [empResponse, clientResponse] = await Promise.all([
        fetch(`/data/v1/consolidated_hr_fte_report_view`),
        fetch(`/data/v1/fte_tool_cost_center_guidance_view`),
      ]);

      const rawEmps = empResponse.ok ? await empResponse.json() : [];
      const rawClients = clientResponse.ok ? await clientResponse.json() : [];

      const empData: TeamMember[] = normalizeHrRoster(rawEmps);

      const clientData: AiReportData[] = (Array.isArray(rawClients) ? rawClients : [])
        .filter((c: AiReportData) => c && c.DisplayName);
      
      setAllEmployees(empData);
      setClients([...clientData]);
      
      const uniqueManagerNames = Array.from(
        new Set(
          empData
            .map(e => e?.manager || e?.First_Reviewer_Name)
            .filter(m => typeof m === 'string' && m)
        )
      ).sort().map(name => ({ id: name as string, name: name as string }));
      setManagers(uniqueManagerNames);

    } catch (error) {
      writeLog('QuarterlyTargetGrid', 'error', 'Failed to fetch base data', error);
      toast({ variant: 'destructive', title: 'Failed to fetch data' });
    } finally {
      setInternalLoading(false);
    }
  }, [toast]);
  
  useEffect(() => {
    if(!userLoading) fetchBaseData();
  }, [fetchBaseData, userLoading]);

  const availableEmployees = useMemo(() => {
    const activeEmployeeIds = new Set((activeTargets || []).map(a => a?.employee?.person_id || a?.employee?.Person_Number).filter(Boolean));
    return (allEmployees || []).filter(e => {
        const id = e?.person_id || e?.Person_Number;
        return id && !activeEmployeeIds.has(id);
    });
  }, [allEmployees, activeTargets]);

  const handleAddEmployee = (employeeId: string) => {
    if (!employeeId || !currentYear) return;
    setSelectedEmployeeToAdd(employeeId);
    setSelectedManager('');
    const employeeToAdd = (allEmployees || []).find(e => e && (e.person_id === employeeId || e.Person_Number === employeeId));
    if (employeeToAdd) {
      const id = employeeToAdd.person_id || employeeToAdd.Person_Number;
      if ((activeTargets || []).some(a => (a.employee?.person_id || a.employee?.Person_Number) === id)) {
          toast({ variant: 'destructive', title: 'Employee already in grid' }); return;
      }
      
      const employeeIdString = `[${id}]`;
      const employeeTargets = (yearDataCache || []).filter(t => t.content.targets_allocation_name?.startsWith(employeeIdString));
      
      setActiveTargets(prev => [{ employee: employeeToAdd, targets: hydrateTargetRows(employeeTargets) }, ...prev]);
    }
    setTimeout(() => setSelectedEmployeeToAdd(''), 0);
  };

  const handleAddManagerTeam = (managerName: string) => {
    if (!currentYear) return;
    if (!managerName) {
        setSelectedManager('');
        setActiveTargets([]);
        return;
    }
    setSelectedManager(managerName);
    setSelectedEmployeeToAdd('');
    const teamMembers = (allEmployees || []).filter(e => e && (e.manager === managerName || e.First_Reviewer_Name === managerName));
    if (teamMembers.length === 0) { 
        toast({ title: 'No employees found for this manager.' }); 
        setActiveTargets([]);
        return; 
    }
    
    const newEmployeeTargets = teamMembers.map(employee => {
        const empId = employee.person_id || employee.Person_Number;
        const employeeIdString = `[${empId}]`;
        const employeeTargets = (yearDataCache || []).filter(t => t.content.targets_allocation_name?.startsWith(employeeIdString));
        
        return { employee, targets: hydrateTargetRows(employeeTargets) };
    });

    setActiveTargets(newEmployeeTargets);
    toast({ title: 'Team Loaded', description: `Loaded ${newEmployeeTargets.length} members for ${managerName}.` });
  };

  /**
   * Take an employee off the grid without touching their documents.
   *
   * Removal here is a view action, matching the weekly allocation grid. Withdrawing a target is
   * done by clearing the quarter or deleting the client row, both of which reach the collection.
   */
  const handleRemoveEmployee = (employeeId: string) => {
      const empId = String(employeeId);
      setActiveTargets(prev => prev.filter(a => String(a.employee?.person_id || a.employee?.Person_Number) !== empId));
      setSelectedManager('');
  };
  
  const handleTargetChange = (employeeId: string, rowId: string, quarter: string, value: string) => {
    const newTarget = parseInt(value, 10) || 0;
    setActiveTargets(prev => prev.map(emp => (String(emp.employee.person_id || emp.employee.Person_Number) === String(employeeId) ? {
      ...emp, targets: emp.targets.map(row => (row.id === rowId ? {
        ...row, quarterlyTargets: { ...row.quarterlyTargets, [quarter]: newTarget }
      } : row))
    } : emp)));
  };
  
  const handleClientChange = (employeeId: string, rowId: string, newClientName: string) => {
     setActiveTargets(prev => prev.map(emp => (String(emp.employee.person_id || emp.employee.Person_Number) === String(employeeId) ? {
        ...emp, targets: emp.targets.map(row => (row.id === rowId ? {
            ...row, clientName: newClientName, clientId: (clients.find(c => c.DisplayName === newClientName)?.Code || '').trim()
        } : row))
     } : emp)));
  };

  const handleAddTargetRow = (employeeId: string) => {
    setActiveTargets(prev => prev.map(emp => (String(emp.employee.person_id || emp.employee.Person_Number) === String(employeeId) ? {
      ...emp, targets: [...emp.targets, blankTargetRow()]
    } : emp)));
  };

  const handleRemoveTargetRow = (employeeId: string, rowId: string) => {
    const emp = activeTargets.find(e => String(e.employee?.person_id || e.employee?.Person_Number) === String(employeeId));
    const rowToRemove = emp?.targets.find(r => r.id === rowId);
    if (rowToRemove) {
        const ids = Object.values(rowToRemove.docIds).filter(Boolean);
        setPendingDeletions(prev => Array.from(new Set([...prev, ...ids])));
    }
    setActiveTargets(prev => prev.map(e => {
      if (String(e.employee.person_id || e.employee.Person_Number) !== String(employeeId)) return e;
      const remaining = e.targets.filter(r => r.id !== rowId);
      // Every employee renders at least one row, so removing the last one collapses to a blank
      // row rather than an empty array. Its documents are still queued for deletion above.
      return { ...e, targets: remaining.length > 0 ? remaining : [blankTargetRow()] };
    }));
  };

  const handleSave = async () => {
    setIsSaving(true);
    // Labelled rather than bare promises: Promise.all resolves for a 4xx, so the status has to be
    // read back per operation or the real cause never reaches the log.
    const operations: SaveOperation[] = [];
    let hasInvalidTarget = false;

    const collectionUrl = '/domo/datastores/v1/collections/weekly_targets/documents/';

    pendingDeletions.forEach(id => {
        operations.push({
            kind: 'DELETE',
            docId: id,
            promise: fetch(`${collectionUrl}${id}`, { method: 'DELETE' }),
        });
    });

    activeTargets.forEach(emp => {
      emp.targets.forEach(row => {
        // Every quarter, not just the keys present: a quarter the user cleared has to be able to
        // reach its existing document and delete it.
        quarters.forEach(quarter => {
          const target = row.quarterlyTargets[quarter];
          const existingDocId = row.docIds[quarter];

          if (typeof target === 'number' && target > 0) {
             if (!row.clientId || !row.clientName) {
                hasInvalidTarget = true;
                toast({ variant: 'destructive', title: 'Missing Client', description: `Please select a client for ${emp.employee.full_name || emp.employee.Full_Name}.` });
                return;
            }
            const content = {
                targets_allocation_date: getQuarterStartDate(currentYear, quarter),
                targets_allocation_name: `[${emp.employee.person_id || emp.employee.Person_Number}] ${emp.employee.full_name || emp.employee.Full_Name}`,
                targets_cost_center_name: row.clientName,
                targets_cost_center_number: row.clientId,
                targets_allocation_amount: target.toString(),
            };

            if (existingDocId) {
                // Skip untouched quarters. Without this every save rewrites every loaded cell.
                const amountChanged = row.loaded[quarter] !== target;
                const costCentreChanged = row.loadedClientId !== row.clientId
                    || row.loadedClientName !== row.clientName;
                if (!amountChanged && !costCentreChanged) return;

                operations.push({
                    kind: 'PUT',
                    docId: existingDocId,
                    quarter,
                    promise: fetch(`${collectionUrl}${existingDocId}`, {
                        method: 'PUT',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ content }),
                    }),
                });
            } else {
                operations.push({
                    kind: 'POST',
                    quarter,
                    promise: fetch(collectionUrl, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ content }),
                    }),
                });
            }
          } else if (existingDocId) {
            // Cleared or zeroed: the target is being withdrawn, so the document goes.
            operations.push({
                kind: 'DELETE',
                docId: existingDocId,
                quarter,
                promise: fetch(`${collectionUrl}${existingDocId}`, { method: 'DELETE' }),
            });
          }
        });
      });
    });

    if (hasInvalidTarget) { setIsSaving(false); return; }
    if (operations.length === 0) { toast({ title: 'No changes to save.' }); setIsSaving(false); return; }

    try {
        const results = await Promise.all(operations.map(op => op.promise));
        const failures = operations
            .map((op, i) => ({ op, res: results[i] }))
            .filter(({ res }) => !res.ok);

        if (failures.length > 0) {
            writeLog('QuarterlyTargetGrid', 'error', 'Save operations failed', {
                year: currentYear,
                failures: failures.map(({ op, res }) => ({
                    kind: op.kind, docId: op.docId, quarter: op.quarter, status: res.status,
                })),
            });
            const statuses = Array.from(new Set(failures.map(({ res }) => res.status))).join(', ');
            throw new Error(
                `${failures.length} of ${operations.length} changes failed (HTTP ${statuses}). ` +
                'Some changes may have been applied — reload the page before retrying.'
            );
        }

        toast({ title: 'Targets Saved', description: `${operations.length} change(s) saved for ${currentYear}.` });
        writeLog('QuarterlyTargetGrid', 'success', 'Targets saved', { count: operations.length, year: currentYear });
        // Re-read so docIds and loaded match what is stored. Without this a document created by
        // the POST above is never given an id, and the next edit duplicates it instead of
        // updating it while a removal silently does nothing.
        setPendingDeletions([]);
        await fetchYearData();
        onSaveSuccess();
    } catch (error: any) {
        writeLog('QuarterlyTargetGrid', 'error', 'Save failed', error);
        toast({ variant: 'destructive', title: 'Save Failed', description: error.message });
    } finally {
        setIsSaving(false);
    }
  };
  
  const pageIsLoading = internalLoading || userLoading;

  return (
    <TooltipProvider>
    <Card>
      <CardHeader>
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
          <div>
            <CardTitle>Quarterly Target Grid</CardTitle>
            <CardDescription>Add employees to build your hiring target plan for the year.</CardDescription>
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            <EmployeeSelect employees={availableEmployees} onValueChange={handleAddEmployee} value={selectedEmployeeToAdd} disabled={pageIsLoading || isSaving} />
            <ManagerSelect managers={managers} onValueChange={handleAddManagerTeam} value={selectedManager} disabled={pageIsLoading || isSaving} />
            <Button variant="outline" size="icon" onClick={() => setCurrentYear(currentYear - 1)} disabled={pageIsLoading || isSaving}><ChevronLeft className="h-4 w-4" /></Button>
            <span className="text-sm font-medium w-20 text-center">{pageIsLoading ? <Skeleton className="h-5 w-16 mx-auto" /> : currentYear}</span>
            <Button variant="outline" size="icon" onClick={() => setCurrentYear(currentYear + 1)} disabled={pageIsLoading || isSaving}><ChevronRight className="h-4 w-4" /></Button>
            <Button onClick={handleSave} disabled={pageIsLoading || isSaving || (activeTargets?.length || 0) === 0}>
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
                  <TableHead className="min-w-[200px] sticky left-0 bg-card z-10">Employee</TableHead>
                  <TableHead className="min-w-[220px]">Client Name</TableHead>
                  {quarters.map(q => <TableHead key={q} className="text-center min-w-[120px]">{q}</TableHead>)}
                  <TableHead className="w-[80px]"> </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
              {!hasMounted || pageIsLoading ? (
                <TableRow><TableCell colSpan={7}><div className="space-y-4 py-8"><Skeleton className="h-10 w-full" /><Skeleton className="h-10 w-full" /></div></TableCell></TableRow>
              ) : (activeTargets?.length || 0) === 0 ? (
                  <TableRow><TableCell colSpan={7} className="text-center h-24 text-muted-foreground">Select an employee or load a team to begin.</TableCell></TableRow>
              ) : activeTargets.map(({ employee, targets }) => (
                    <Fragment key={employee.person_id || employee.Person_Number}>
                      <TableRow className="bg-muted/50 hover:bg-muted">
                        <TableCell className="font-semibold sticky left-0 bg-muted/50 z-10">
                          {employee.full_name || employee.Full_Name}
                          <div className="text-xs text-muted-foreground font-normal">{employee.title || employee.Market_Facing_Title}</div>
                        </TableCell>
                        <TableCell></TableCell>
                        {quarters.map(q => <TableCell key={q} className="text-center font-semibold text-muted-foreground">{(targets || []).reduce((sum, row) => sum + (parseInt(row.quarterlyTargets[q]?.toString()) || 0), 0) || '-'}</TableCell>)}
                        <TableCell className='text-right'>
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <Button variant="ghost" size="icon" onClick={() => handleRemoveEmployee(employee.person_id || employee.Person_Number)} disabled={isSaving}>
                                <X className="h-4 w-4 text-muted-foreground" />
                              </Button>
                            </TooltipTrigger>
                            <TooltipContent><p>Remove from grid (does not delete targets)</p></TooltipContent>
                          </Tooltip>
                        </TableCell>
                      </TableRow>
                      {(targets || []).map(row => (
                        <TableRow key={row.id}>
                          <TableCell className="sticky left-0 bg-card z-10"></TableCell>
                          <TableCell><ClientSelect clients={clients} value={row.clientName} onValueChange={name => handleClientChange(employee.person_id || employee.Person_Number, row.id, name)} disabled={isSaving}/></TableCell>
                          {quarters.map(q => (
                              <TableCell key={q} className="text-center">
                                <Input type="number" step="1" min="0" placeholder="0" className="w-20 text-center mx-auto"
                                  value={row.quarterlyTargets[q] || ''}
                                  onChange={e => handleTargetChange(employee.person_id || employee.Person_Number, row.id, q, e.target.value)}
                                  disabled={isSaving}
                                />
                              </TableCell>
                          ))}
                          <TableCell className='text-right'><Button variant="ghost" size="icon" onClick={() => handleRemoveTargetRow(employee.person_id || employee.Person_Number, row.id)} disabled={isSaving}><Trash2 className="h-4 w-4 text-destructive" /></Button></TableCell>
                        </TableRow>
                      ))}
                      <TableRow>
                        <TableCell className="sticky left-0 bg-card z-10 py-2" colSpan={2}>
                          <Button variant="outline" size="sm" className="w-full justify-start" onClick={() => handleAddTargetRow(employee.person_id || employee.Person_Number)} disabled={isSaving}><PlusCircle className="mr-2 h-4 w-4" /> Add Target Row</Button>
                        </TableCell>
                        <TableCell colSpan={5}></TableCell>
                      </TableRow>
                    </Fragment>
                  ))}
              </TableBody>
            </Table>
        </div>
      </CardContent>
    </Card>
    </TooltipProvider>
  );
}
