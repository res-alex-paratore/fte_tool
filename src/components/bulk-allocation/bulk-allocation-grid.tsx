
'use client';

import { useState, useMemo, useEffect, useCallback } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle, CardDescription, CardFooter } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Checkbox } from '@/components/ui/checkbox';
import { ScrollArea } from '@/components/ui/scroll-area';
import { PlusCircle, X, ChevronsUpDown, Check } from 'lucide-react';
import { useCurrentUser } from '@/hooks/use-current-user';
import type { TeamMember, SummaryEntry } from '@/types';
import { useToast } from '@/hooks/use-toast';
import { Skeleton } from '@/components/ui/skeleton';
import { v4 as uuidv4 } from 'uuid';
import { ALLOCATION_MONTH_LABELS } from '@/lib/fiscal-calendar';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Label } from '@/components/ui/label';
import { writeLog } from '@/lib/logger';
import { normalizeHrRoster } from '@/lib/hr-roster';
import { Badge } from '@/components/ui/badge';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from '@/components/ui/command';
import { cn } from '@/lib/utils';

type AiReportData = {
    Code: string;
    Name: string;
    DisplayName: string;
    RollsUpTo: string;
};
type AllocationRow = { id: string; clientName: string; fte: number };

type BulkAllocationGridProps = {
  onSaveSuccess: () => void;
  templateToCopy: SummaryEntry[] | null;
};

// Calendar months. The label format is the contract with the reporting dataflow -
// see ALLOCATION_MONTH_LABELS.
const months = ALLOCATION_MONTH_LABELS;
const currentYearValue = new Date().getFullYear();
const years = Array.from({ length: 5 }, (_, i) => (currentYearValue - 2 + i).toString());

const MultiSelectFilter = ({
  placeholder,
  options,
  selected,
  onValueChange,
  disabled,
}: {
  placeholder: string;
  options: string[];
  selected: string[];
  onValueChange: (value: string) => void;
  disabled?: boolean;
}) => {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');

  const filteredOptions = useMemo(() => {
    if (!search) return options || [];
    const s = search.toLowerCase();
    return (options || []).filter(o => o.toLowerCase().includes(s));
  }, [search, options]);

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
            {(selected || []).length === 0
              ? placeholder
              : (selected || []).length <= 2
              ? (selected || []).join(', ')
              : `${(selected || []).length} selected`}
          </span>
          <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[--radix-popover-trigger-width] p-0" align="start">
        <Command shouldFilter={false}>
          <CommandInput 
            placeholder="Search..." 
            value={search}
            onValueChange={setSearch}
          />
          <CommandList className="max-h-64 overflow-y-auto">
            <CommandEmpty>No results found.</CommandEmpty>
            <CommandGroup>
              {filteredOptions.map(option => (
                <CommandItem
                  key={option}
                  value={option}
                  onSelect={() => onValueChange(option)}
                >
                  <Checkbox
                    className="mr-2"
                    checked={(selected || []).includes(option)}
                  />
                  <span>{option}</span>
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
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


export function BulkAllocationGrid({ onSaveSuccess, templateToCopy }: BulkAllocationGridProps) {
  const [allEmployees, setAllEmployees] = useState<TeamMember[]>([]);
  const [clients, setClients] = useState<AiReportData[]>([]);
  const [loading, setLoading] = useState(true);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [hasMounted, setHasMounted] = useState(false);

  const [selectedEmployees, setSelectedEmployees] = useState<Set<string>>(new Set());
  const [allocationRows, setAllocationRows] = useState<AllocationRow[]>([]);
  
  const [selectedMonth, setSelectedMonth] = useState<string | null>(null);
  const [selectedYear, setSelectedYear] = useState<string | null>(null);
  const [selectedAllocationGroup, setSelectedAllocationGroup] = useState('');
  const [otherAllocationGroup, setOtherAllocationGroup] = useState('');

  const [employeeFilters, setEmployeeFilters] = useState({
    fullName: [] as string[],
    manager: [] as string[],
    department: [] as string[]
  });

  const { loading: userLoading } = useCurrentUser();
  const { toast } = useToast();
  
  useEffect(() => {
    setHasMounted(true);
    const now = new Date();
    setSelectedMonth(months[now.getMonth()]);
    setSelectedYear(now.getFullYear().toString());
  }, []);

  const fetchData = useCallback(async () => {
    setLoading(true);
    try {
      const [empResponse, clientResponse] = await Promise.all([
        fetch(`/data/v1/consolidated_hr_fte_report_view`),
        fetch(`/data/v1/fte_tool_cost_center_guidance_view`),
      ]);

      if (!empResponse.ok) writeLog('BulkAllocationGrid', 'warning', 'Could not fetch employee data', { status: empResponse.status });
      if (!clientResponse.ok) writeLog('BulkAllocationGrid', 'warning', 'Could not fetch client data', { status: clientResponse.status });
      
      const rawEmpData = empResponse.ok ? await empResponse.json() : [];
      const rawClientData = clientResponse.ok ? await clientResponse.json() : [];
      
      const empData: TeamMember[] = normalizeHrRoster(rawEmpData);
      
      const clientData: AiReportData[] = (Array.isArray(rawClientData) ? rawClientData : [])
        .filter((c: AiReportData) => c && c.DisplayName);
      
      setAllEmployees(empData);
      
      const staticClients: AiReportData[] = [
        { Code: 'UNALLOCATED', Name: 'Unallocated', DisplayName: 'Unallocated', RollsUpTo: '' },
        { Code: 'PTO', Name: 'PTO', DisplayName: 'PTO', RollsUpTo: '' },
      ];
      setClients([...staticClients, ...clientData]);

    } catch (error) {
      writeLog('BulkAllocationGrid', 'error', 'Failed to fetch initial data', error);
      toast({ variant: 'destructive', title: 'Failed to fetch data' });
    } finally {
      setLoading(false);
    }
  }, [toast]);
  
  const selectedEmployeeDetails = useMemo(() => {
    return Array.from(selectedEmployees)
      .map(id => (allEmployees || []).find(e => e && (e.person_id === id || e.Person_Number === id)))
      .filter((e): e is TeamMember => !!e)
      .sort((a, b) => (a.full_name || a.Full_Name || '').localeCompare(b.full_name || b.Full_Name || ''));
  }, [selectedEmployees, allEmployees]);

  const totalSelectedFte = useMemo(() => {
    return selectedEmployeeDetails.reduce((sum, e) => sum + (parseFloat(e.fte || e.FTE || '0') || 0), 0);
  }, [selectedEmployeeDetails]);
  
  useEffect(() => {
    if (templateToCopy) {
      const templateTotal = templateToCopy.reduce((sum, s) => sum + (s.percentage || 0), 0);

      if (totalSelectedFte === 0) {
        toast({
          title: 'Select Employees First',
          description: 'Copying template with original FTE values. Select employees to validate.',
        });
        const newAllocationRows = templateToCopy.map(summary => ({
          id: uuidv4(),
          clientName: summary.name || 'Unknown',
          fte: summary.percentage || 0,
        }));
        setAllocationRows(newAllocationRows);
      } else {
        const newAllocationRows = templateToCopy.map(summary => {
            const ratio = templateTotal > 0 ? (summary.percentage || 0) / templateTotal : 0;
            return {
                id: uuidv4(),
                clientName: summary.name || 'Unknown',
                fte: ratio * totalSelectedFte
            };
        });
        setAllocationRows(newAllocationRows);
        toast({ title: 'Template Copied', description: 'Allocation profile has been copied. Amounts scaled to current group FTE.' });
      }
    } else {
        if (allocationRows.length === 0) {
            setAllocationRows([{ id: uuidv4(), clientName: '', fte: 0 }]);
        }
    }
  }, [templateToCopy, totalSelectedFte, toast]);

  useEffect(() => {
    if (!userLoading) {
      fetchData();
    }
  }, [fetchData, userLoading]);

  const filterOptions = useMemo(() => {
    const getUniqueSorted = (key1: keyof TeamMember, key2?: keyof TeamMember) =>
        Array.from(
            new Set(
                (allEmployees || [])
                    .map(item => item && (item[key1] || (key2 ? item[key2] : '')))
                    .filter(val => typeof val === 'string' && val) as string[]
            )
        ).sort((a, b) => a.localeCompare(b));

    return {
      fullNames: getUniqueSorted('full_name', 'Full_Name'),
      managers: getUniqueSorted('manager', 'First_Reviewer_Name'),
      departments: getUniqueSorted('department', 'Team_Name'),
    };
  }, [allEmployees]);

  const filteredEmployees = useMemo(() => {
    return (allEmployees || []).filter(emp => {
      if (!emp) return false;
      const empName = emp.full_name || emp.Full_Name || '';
      const empManager = emp.manager || emp.First_Reviewer_Name || '';
      const empDept = emp.department || emp.Team_Name || '';

      const nameMatch = employeeFilters.fullName.length === 0 || employeeFilters.fullName.includes(empName);
      const managerMatch = employeeFilters.manager.length === 0 || employeeFilters.manager.includes(empManager);
      const departmentMatch = employeeFilters.department.length === 0 || employeeFilters.department.includes(empDept);
      return nameMatch && managerMatch && departmentMatch;
    });
  }, [allEmployees, employeeFilters]);
  
  const totalAllocatedFte = useMemo(() => {
    return (allocationRows || []).reduce((sum, row) => sum + (parseFloat(row.fte?.toString()) || 0), 0);
  }, [allocationRows]);

  const handleEmployeeToggle = (employeeId: string, isSelected: boolean) => {
    setSelectedEmployees(prev => {
      const newSet = new Set(prev);
      if (isSelected) {
        newSet.add(employeeId);
      } else {
        newSet.delete(employeeId);
      }
      return newSet;
    });
  };

  const handleAddAllocationRow = () => {
    setAllocationRows(prev => [...prev, { id: uuidv4(), clientName: '', fte: 0 }]);
  };

  const handleRemoveAllocationRow = (id: string) => {
    setAllocationRows(prev => prev.filter(row => row.id !== id));
  };
  
  const handleAllocationChange = (id: string, field: 'clientName' | 'fte', value: string) => {
    setAllocationRows(prev => prev.map(row => {
      if (row.id === id) {
        if (field === 'fte') {
          return { ...row, [field]: Number(value) };
        }
        return { ...row, [field]: value };
      }
      return row;
    }));
  };

  const handleFilterChange = (filterName: keyof typeof employeeFilters, value: string) => {
    setEmployeeFilters(prev => {
        const currentValues = prev[filterName] || [];
        const newValues = currentValues.includes(value)
          ? currentValues.filter(v => v !== value)
          : [...currentValues, value];
        return { ...prev, [filterName]: newValues };
    });
  };

  const clearEmployeeFilters = () => {
    setEmployeeFilters({ fullName: [], manager: [], department: [] });
  };

  const handleSave = async () => {
    if (selectedEmployees.size === 0) {
      toast({ variant: 'destructive', title: 'No employees selected.' });
      return;
    }
    if (Math.abs(totalAllocatedFte - totalSelectedFte) > 0.01) {
      toast({ variant: 'destructive', title: 'Allocation Mismatch', description: `Total allocated FTE (${totalAllocatedFte.toFixed(2)}) must match the selected employees' total FTE (${totalSelectedFte.toFixed(2)}).` });
      return;
    }
    if (allocationRows.some(row => !row.clientName || row.fte < 0)) {
        toast({ variant: 'destructive', title: 'Invalid allocation rows.', description: 'Please ensure every row has a client and an allocation of 0 or more.' });
        return;
    }
    if (!selectedMonth || !selectedYear) {
      toast({ variant: 'destructive', title: 'Please select a month and year.' });
      return;
    }

    let allocationGroupValue = selectedAllocationGroup;
    if (selectedAllocationGroup === 'Other') {
      if (!otherAllocationGroup.trim()) {
        toast({ variant: 'destructive', title: 'Missing Field', description: 'Please specify the "Other" allocation group name.' });
        return;
      }
      allocationGroupValue = otherAllocationGroup.trim();
    } else if (!selectedAllocationGroup) {
      toast({ variant: 'destructive', title: 'Missing Field', description: 'Please select an Allocation Group.' });
      return;
    }

    setIsSubmitting(true);
    const bulkAllocationId = uuidv4();
    const allocationDate = new Date().toISOString();
    // Must stay in the "MMM yyyy" shape the dataflow joins on - selectedMonth comes
    // from ALLOCATION_MONTH_LABELS, so this matches by construction.
    const allocationMonthYear = `${selectedMonth} ${selectedYear}`;

    const employeeSubmissions = Array.from(selectedEmployees).map(employeeId => {
      const employee = allEmployees.find(e => e && (e.person_id === employeeId || e.Person_Number === employeeId));
      return fetch('/domo/datastores/v1/collections/bulk_allocation_fte/documents/', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          content: {
            bulk_allocation_id: bulkAllocationId,
            employee_id: employeeId,
            employee_name: (employee?.full_name || employee?.Full_Name || 'Unknown'),
            bulk_allocation_date: allocationDate,
            allocation_monthyear: allocationMonthYear,
          }
        }),
      });
    });

    const summarySubmissions = allocationRows.map(row => {
      const client = clients.find(c => c.DisplayName === row.clientName);
      return fetch('/domo/datastores/v1/collections/bulk_allocation_summary/documents/', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          content: {
            bulk_allocation_id: bulkAllocationId,
            cost_center_number: client?.Code || row.clientName || 'Unknown',
            cost_center_name: row.clientName,
            allocation_percentage: row.fte.toString(), 
            bulk_allocation_date: allocationDate,
            allocation_group: allocationGroupValue,
          }
        }),
      });
    });

    try {
      const allPromises = [...employeeSubmissions, ...summarySubmissions];
      const results = await Promise.all(allPromises);

      if (results.some(res => !res.ok)) {
        throw new Error('One or more submissions failed.');
      }
      
      writeLog('BulkAllocationGrid', 'success', 'Bulk allocation saved', { count: selectedEmployees.size, month: allocationMonthYear });
      toast({ title: 'Bulk Allocation Saved', description: `Assigned allocation profile to ${selectedEmployees.size} employees.` });
      
      setSelectedEmployees(new Set());
      setAllocationRows([{ id: uuidv4(), clientName: '', fte: 0 }]);
      setSelectedAllocationGroup('');
      setOtherAllocationGroup('');
      onSaveSuccess();

    } catch (error: any) {
      writeLog('BulkAllocationGrid', 'error', 'Bulk allocation save failed', error);
      toast({ variant: 'destructive', title: 'Save Failed', description: error.message });
    } finally {
      setIsSubmitting(false);
    }
  };
  
  const isPageLoading = loading || userLoading || !hasMounted;
  const isAllocationInvalid = Math.abs(totalAllocatedFte - totalSelectedFte) > 0.01;
  const isSubmitDisabled = isPageLoading || isSubmitting || selectedEmployees.size === 0 || isAllocationInvalid || !selectedAllocationGroup || (selectedAllocationGroup === 'Other' && !otherAllocationGroup.trim());

  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-8 items-start">
      <Card>
        <CardHeader>
          <div className="flex justify-between items-start gap-4">
            <div>
              <CardTitle>Step 1: Select Employees</CardTitle>
              <CardDescription>Choose the employees who will share this allocation profile.</CardDescription>
            </div>
            <Button variant="outline" size="sm" onClick={clearEmployeeFilters} disabled={isPageLoading}>Clear Filters</Button>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 pt-4">
            <MultiSelectFilter
              placeholder="Name..."
              options={filterOptions.fullNames}
              selected={employeeFilters.fullName}
              onValueChange={value => handleFilterChange('fullName', value)}
              disabled={isPageLoading}
            />
            <MultiSelectFilter
              placeholder="Manager..."
              options={filterOptions.managers}
              selected={employeeFilters.manager}
              onValueChange={value => handleFilterChange('manager', value)}
              disabled={isPageLoading}
            />
            <MultiSelectFilter
              placeholder="Department..."
              options={filterOptions.departments}
              selected={employeeFilters.department}
              onValueChange={value => handleFilterChange('department', value)}
              disabled={isPageLoading}
            />
          </div>
        </CardHeader>
        <CardContent>
          <ScrollArea className="h-96">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-[50px]"></TableHead>
                  <TableHead>Name</TableHead>
                  <TableHead>Title</TableHead>
                  <TableHead>Manager</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {isPageLoading ? (
                  Array.from({ length: 8 }).map((_, i) => (
                    <TableRow key={i}>
                      <TableCell><Skeleton className="h-5 w-5 rounded" /></TableCell>
                      <TableCell><Skeleton className="h-5 w-full" /></TableCell>
                      <TableCell><Skeleton className="h-5 w-full" /></TableCell>
                      <TableCell><Skeleton className="h-5 w-full" /></TableCell>
                    </TableRow>
                  ))
                ) : filteredEmployees.length > 0 ? (
                  filteredEmployees.map(emp => {
                    const empId = emp.person_id || emp.Person_Number;
                    return (
                      <TableRow key={empId}>
                        <TableCell>
                          <Checkbox 
                            checked={selectedEmployees.has(empId)}
                            onCheckedChange={checked => handleEmployeeToggle(empId, !!checked)}
                            aria-label={`Select ${emp.full_name || emp.Full_Name}`}
                          />
                        </TableCell>
                        <TableCell className="font-medium">{emp.full_name || emp.Full_Name || 'N/A'}</TableCell>
                        <TableCell className="text-muted-foreground">{emp.title || emp.Market_Facing_Title || 'N/A'}</TableCell>
                        <TableCell className="text-muted-foreground">{emp.manager || emp.First_Reviewer_Name || 'N/A'}</TableCell>
                      </TableRow>
                    );
                  })
                ) : (
                  <TableRow>
                    <TableCell colSpan={4} className="text-center h-24 text-muted-foreground">
                      No employees match the current filters.
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </ScrollArea>
        </CardContent>
        <CardFooter>
            <div className="text-sm text-muted-foreground">
                {selectedEmployees.size} employee(s) selected, for a total of {totalSelectedFte.toFixed(2)} FTE.
            </div>
        </CardFooter>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Step 2: Define Allocation</CardTitle>
          <CardDescription>Define the client allocation in FTE. Must sum to the total FTE of selected employees.</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="grid gap-6">
            <div className="grid grid-cols-2 gap-4">
                <div className="grid gap-2">
                    <Label htmlFor="month">Month</Label>
                    <Select value={selectedMonth || ''} onValueChange={(value) => setSelectedMonth(value)} disabled={isPageLoading}>
                        <SelectTrigger id="month">
                            <SelectValue placeholder="Select Month" />
                        </SelectTrigger>
                        <SelectContent>
                            {months.map(m => <SelectItem key={m} value={m}>{m}</SelectItem>)}
                        </SelectContent>
                    </Select>
                </div>
                <div className="grid gap-2">
                    <Label htmlFor="year">Year</Label>
                    <Select value={selectedYear || ''} onValueChange={(value) => setSelectedYear(value)} disabled={isPageLoading}>
                        <SelectTrigger id="year">
                            <SelectValue placeholder="Select Year" />
                        </SelectTrigger>
                        <SelectContent>
                            {years.map(y => <SelectItem key={y} value={y}>{y}</SelectItem>)}
                        </SelectContent>
                    </Select>
                </div>
            </div>
            
            <div className="grid gap-2">
                <Label htmlFor="allocation-group">Allocation Group</Label>
                <Select value={selectedAllocationGroup} onValueChange={setSelectedAllocationGroup} disabled={isPageLoading || isSubmitting}>
                    <SelectTrigger id="allocation-group">
                    <SelectValue placeholder="Select Group" />
                    </SelectTrigger>
                    <SelectContent>
                    <SelectItem value="Business Services Compliance">Business Services Compliance</SelectItem>
                    <SelectItem value="Business Services Contractor Care">Business Services Contractor Care</SelectItem>
                    <SelectItem value="Business Services MSP NAM">Business Services MSP NAM</SelectItem>
                    <SelectItem value="Other">Other</SelectItem>
                    </SelectContent>
                </Select>
            </div>
            {selectedAllocationGroup === 'Other' && (
                <div className="grid gap-2">
                    <Label htmlFor="other-allocation-group">Specify Other Group</Label>
                    <Input
                    id="other-allocation-group"
                    value={otherAllocationGroup}
                    onChange={(e) => setOtherAllocationGroup(e.target.value)}
                    placeholder="Enter group name"
                    disabled={isPageLoading || isSubmitting}
                    />
                </div>
            )}


            <div className="grid gap-2">
              <Label>Selected Employees ({selectedEmployeeDetails.length})</Label>
              <ScrollArea className="h-40 rounded-md border">
                <div className="p-4 text-sm">
                  {isPageLoading ? (
                    <Skeleton className="h-20 w-full" />
                  ) : selectedEmployeeDetails.length > 0 ? (
                    <ul className="space-y-2">
                      {selectedEmployeeDetails.map(emp => (
                        <li key={emp.person_id || emp.Person_Number} className="flex items-center justify-between">
                          <span>{emp.full_name || emp.Full_Name || 'N/A'}</span>
                          <Badge variant="secondary">FTE: {emp.fte || emp.FTE || 'N/A'}</Badge>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="py-4 text-center text-muted-foreground">Select employees from the list on the left.</p>
                  )}
                </div>
              </ScrollArea>
            </div>

            <div className="grid gap-4">
              {allocationRows.map((row) => (
                <div key={row.id} className="flex gap-2 items-center">
                  <ClientSelect
                    clients={clients}
                    value={row.clientName}
                    onValueChange={value => handleAllocationChange(row.id, 'clientName', value)}
                    disabled={isPageLoading || isSubmitting}
                  />
                  <Input 
                    type="number"
                    min="0"
                    step="0.05"
                    value={row.fte}
                    onChange={e => handleAllocationChange(row.id, 'fte', e.target.value)}
                    className="w-32 text-center"
                    placeholder="0.00"
                    disabled={isPageLoading || isSubmitting}
                  />
                  <Button variant="ghost" size="icon" onClick={() => handleRemoveAllocationRow(row.id)} disabled={allocationRows.length === 1 || isPageLoading || isSubmitting}>
                      <X className="h-4 w-4" />
                  </Button>
                </div>
              ))}
              <Button variant="outline" onClick={handleAddAllocationRow} disabled={isPageLoading || isSubmitting}>
                <PlusCircle className="mr-2 h-4 w-4" /> Add Client
              </Button>
              <Alert variant={isAllocationInvalid ? 'destructive' : 'default'}>
                <AlertDescription>
                  Total Allocated: <span className="font-bold">{(parseFloat(totalAllocatedFte.toString()) || 0).toFixed(2)}</span> / {(parseFloat(totalSelectedFte.toString()) || 0).toFixed(2)} FTE
                  {isAllocationInvalid && " (Totals must match)"}
                </AlertDescription>
              </Alert>
            </div>
          </div>
        </CardContent>
        <CardFooter>
            <Button onClick={handleSave} disabled={isSubmitDisabled}>
              {isSubmitting ? 'Saving...' : 'Save Bulk Allocation'}
            </Button>
        </CardFooter>
      </Card>
    </div>
  );
}
