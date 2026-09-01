
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { SelectSearch } from '@/components/ui/select-search';
import { PlusCircle, Trash2, ChevronLeft, ChevronRight, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { normalizeHrRoster } from '@/lib/hr-roster';
import { useToast } from '@/hooks/use-toast';
import { Skeleton } from '../ui/skeleton';
import { format, startOfMonth, addMonths, subMonths } from 'date-fns';
import { TeamMember, WeeklyAllocation } from '@/types';
import { ScrollArea } from '@/components/ui/scroll-area';

type TicketAllocationData = {
  agent_name: string;
  agent_group_name: string;
  department_name: string;
  client_name: string;
  reporting_month: string;
  reporting_year: string;
  tickets: string;
  total_monthly_tickets: string;
  monthly_ticket_ratio: string;
};

type AllocationRow = {
  id: string;
  clientName: string;
  fte: number;
};

type EmployeeAllocation = {
  agentName: string;
  allocations: AllocationRow[];
};

type MonthlyFreshserviceGridProps = {
  onSaveSuccess: () => void;
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
  agentName?: string;
  clientName?: string;
  promise: Promise<Response>;
};

// Employee Select Component
const EmployeeSelect = ({ 
  employees, 
  onValueChange,
  value,
  disabled
}: { 
  employees: { person_id: string, full_name: string }[], 
  onValueChange: (value: string) => void,
  value: string,
  disabled?: boolean
}) => {
  const [searchTerm, setSearchTerm] = useState('');
  
  const filteredEmployees = useMemo(() => {
    const sortedEmployees = [...employees].sort((a,b) => (a.full_name || '').localeCompare(b.full_name || ''));
    if (!searchTerm) {
      return sortedEmployees;
    }
    return sortedEmployees.filter(e => e.full_name && e.full_name.toLowerCase().includes(searchTerm.toLowerCase()));
  }, [employees, searchTerm]);

  return (
    <Select onValueChange={onValueChange} value={value} disabled={disabled}>
      <SelectTrigger className="w-[200px]">
          <SelectValue placeholder="Load Employee..." />
      </SelectTrigger>
      <SelectContent>
          <SelectSearch placeholder="Search employee..." onChange={setSearchTerm} />
          <ScrollArea className="h-64">
            {filteredEmployees.map(e => (
                <SelectItem key={e.person_id} value={e.full_name}>
                    {e.full_name}
                </SelectItem>
            ))}
            {filteredEmployees.length === 0 && (
                <div className="p-4 text-sm text-center text-muted-foreground">
                    No employees found.
                </div>
            )}
          </ScrollArea>
      </SelectContent>
    </Select>
  );
};

// Placeholder Manager Select
const ManagerSelect = ({ disabled }: { disabled?: boolean }) => (
    <Select disabled={disabled}>
        <SelectTrigger className="w-[200px]">
            <SelectValue placeholder="Load Team (Future)..." />
        </SelectTrigger>
        <SelectContent></SelectContent>
    </Select>
);


export function MonthlyFreshserviceGrid({ onSaveSuccess }: MonthlyFreshserviceGridProps) {
  const [activeAllocations, setActiveAllocations] = useState<EmployeeAllocation[]>([]);
  const [allTicketData, setAllTicketData] = useState<TicketAllocationData[]>([]);
  const [allEmployees, setAllEmployees] = useState<TeamMember[]>([]);
  const [currentDate, setCurrentDate] = useState<Date | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [selectedEmployeeToAdd, setSelectedEmployeeToAdd] = useState('');
  const [hasMounted, setHasMounted] = useState(false);

  const { toast } = useToast();

  useEffect(() => {
    setHasMounted(true);
  }, []);

  const fetchDataForMonth = useCallback(async (date: Date) => {
    setIsLoading(true);
    try {
      const selectedMonth = format(date, 'MMM');
      const selectedYear = format(date, 'yyyy');

      const [ticketResponse, employeeResponse] = await Promise.all([
          fetch(`/data/v1/fte_tickets_grouped_monthly_view`),
          fetch('/data/v1/consolidated_hr_fte_report_view')
      ]);

      if (!ticketResponse.ok || !employeeResponse.ok) {
        console.warn(`Failed to fetch all required data.`);
        setAllTicketData([]);
        setAllEmployees([]);
        return;
      }
      
      const ticketData: TicketAllocationData[] = await ticketResponse.json();
      const employeeData: TeamMember[] = normalizeHrRoster(await employeeResponse.json());

      setAllEmployees(employeeData);

      // Filter ticket data for the selected month and store it
      const filteredTicketData = ticketData.filter(item => 
        String(item.reporting_month).trim() === selectedMonth && 
        String(item.reporting_year).trim() === selectedYear
      );
      setAllTicketData(filteredTicketData);
      
      // Important: Clear active allocations when the month changes
      setActiveAllocations([]);

    } catch (error) {
      console.error("Failed to fetch and process data:", error);
      toast({ variant: 'destructive', title: 'Failed to process data' });
      setActiveAllocations([]);
      setAllTicketData([]);
      setAllEmployees([]);
    } finally {
      setIsLoading(false);
    }
  }, [toast]);
  
  useEffect(() => {
    // Set initial date on client-side only to avoid hydration errors
    setCurrentDate(new Date());
  }, []);

  useEffect(() => {
    // Fetch data whenever the date changes, but only if date is not null
    if (currentDate) {
      fetchDataForMonth(currentDate);
    }
  }, [currentDate, fetchDataForMonth]);


  const availableEmployees = useMemo(() => {
    const activeEmployeeNames = new Set(activeAllocations.map(a => a.agentName));
    const uniqueAgentNamesFromTickets = Array.from(new Set(allTicketData.map(t => t.agent_name).filter(Boolean)));
    
    const dynamicEmployees = allEmployees
        .filter(e => e.full_name && uniqueAgentNamesFromTickets.includes(e.full_name) && !activeEmployeeNames.has(e.full_name))
        .map(e => ({ person_id: e.person_id, full_name: e.full_name }));

    return dynamicEmployees;
  }, [allEmployees, allTicketData, activeAllocations]);

  const handleAddEmployee = (employeeName: string) => {
    if (!employeeName) return;
    
    setSelectedEmployeeToAdd(employeeName);

    const isAlreadyActive = activeAllocations.some(a => a.agentName === employeeName);
    if (isAlreadyActive) {
      toast({ variant: 'destructive', title: 'Employee already in grid' });
      return;
    }
    
    // Find ticket data for the selected employee
    const employeeTicketData = allTicketData.filter(t => t.agent_name === employeeName);

    if (employeeTicketData.length > 0) {
      const newEmployeeAllocation: EmployeeAllocation = {
        agentName: employeeName,
        allocations: employeeTicketData.map(d => ({
          id: `${employeeName}-${d.client_name || d.agent_group_name}-${Date.now()}`,
          clientName: d.client_name || d.agent_group_name,
          fte: parseFloat(d.monthly_ticket_ratio) || 0,
        })),
      };
      setActiveAllocations(prev => [newEmployeeAllocation, ...prev]);
    } else {
      toast({ variant: 'destructive', title: 'No Data', description: `No ticket allocation data found for ${employeeName} in this month.` });
    }
    
    setTimeout(() => setSelectedEmployeeToAdd(''), 0);
  };


  const handlePrevMonth = () => currentDate && setCurrentDate(subMonths(currentDate, 1));
  const handleNextMonth = () => currentDate && setCurrentDate(addMonths(currentDate, 1));

  const handleFteChange = (agentName: string, allocId: string, newFteValue: string) => {
    const newFte = parseFloat(newFteValue) || 0;
    setActiveAllocations(prev => prev.map(empAlloc => {
      if (empAlloc.agentName === agentName) {
        const newAllocations = empAlloc.allocations.map(alloc => {
          if (alloc.id === allocId) {
            return { ...alloc, fte: newFte };
          }
          return alloc;
        });
        return { ...empAlloc, allocations: newAllocations };
      }
      return empAlloc;
    }));
  };

  const handleAddAllocationRow = (agentName: string) => {
    setActiveAllocations(prev => prev.map(empAlloc => {
      if (empAlloc.agentName === agentName) {
        const newAlloc: AllocationRow = {
          id: `${agentName}-new-${Date.now()}`,
          clientName: 'MANUAL ENTRY',
          fte: 0,
        };
        return { ...empAlloc, allocations: [...empAlloc.allocations, newAlloc] };
      }
      return empAlloc;
    }));
  };

  const handleRemoveAllocationRow = (agentName: string, allocId: string) => {
    // Removing the last row leaves the agent in the grid with nothing allocated rather than
    // dropping them out of it. The save reconciles only the agents on screen, so removing the
    // agent here would take their documents out of scope and quietly preserve the very rows the
    // user just deleted. Nothing allocated is a valid state: the save withdraws them entirely.
    setActiveAllocations(prev => prev.map(empAlloc => (
        empAlloc.agentName === agentName
            ? { ...empAlloc, allocations: empAlloc.allocations.filter(a => a.id !== allocId) }
            : empAlloc
    )));
  };

  /**
   * Take an agent off the grid without touching their documents.
   *
   * Removal here is a view action, matching the weekly allocation grid. Withdrawing an agent's
   * allocations is done by removing their rows and saving.
   */
  const handleRemoveEmployee = (agentName: string) => {
      setActiveAllocations(prev => prev.filter(a => a.agentName !== agentName));
  }

  const handleSave = async () => {
    if (!currentDate) {
        toast({ variant: 'destructive', title: 'Invalid Date', description: 'Please select a valid month and year.' });
        return;
    }
    
    setIsSubmitting(true);
    const allocationDate = format(startOfMonth(currentDate), 'yyyy-MM-dd');
    const selectedMonth = format(currentDate, 'MMM');
    const selectedYear = format(currentDate, 'yyyy');
    
    let hasValidationError = false;

    // Desired state for every agent on screen: agentName -> clientName -> fte.
    const desired = new Map<string, Map<string, number>>();

    activeAllocations.forEach(empAlloc => {
      const totalFte = empAlloc.allocations.reduce((sum, alloc) => sum + alloc.fte, 0);
      // An agent with nothing allocated is being withdrawn, which is a valid outcome rather than a
      // validation failure — their documents are deleted below. Only a partial allocation is wrong.
      if (totalFte > 0.01 && Math.abs(totalFte - 1.0) > 0.01) {
          toast({ variant: 'destructive', title: `Validation Error for ${empAlloc.agentName}`, description: `Total allocation must be 1.0, but it is ${totalFte.toFixed(3)}.` });
          hasValidationError = true;
          return;
      }
      // Sum rather than overwrite: the reconcile keys on agent + cost centre, and the Add
      // Allocation button produces rows whose name is a readOnly 'MANUAL ENTRY', so two rows can
      // legitimately share a name. Overwriting would drop their FTE and write less than the 1.0
      // the user sees totalled on screen.
      const rows = new Map<string, number>();
      empAlloc.allocations.forEach(alloc => {
        if (alloc.fte > 0) rows.set(alloc.clientName, (rows.get(alloc.clientName) || 0) + alloc.fte);
      });
      desired.set(empAlloc.agentName, rows);
    });

    if (hasValidationError) {
        setIsSubmitting(false);
        return;
    }

    if (desired.size === 0) {
      toast({ title: 'No changes to save.' });
      setIsSubmitting(false);
      return;
    }

    const collectionUrl = '/domo/datastores/v1/collections/weekly_allocation/documents/';

    try {
        // Read what is already stored for this month, so the save can update and remove rather than
        // only create. Without this every save re-created every row, so editing duplicated an entry
        // and removing a row left its document behind.
        const storedRes = await fetch(`/domo/datastores/v1/collections/weekly_allocation/documents?q=content.allocation_date='${allocationDate}'`);
        if (!storedRes.ok) throw new Error(`Could not read existing allocations (HTTP ${storedRes.status}).`);
        const stored: WeeklyAllocation[] = await storedRes.json();

        // Only documents this page owns. The weekly allocation grid always writes
        // allocation_name as '[personId] Name', so an exact match on a bare agent name cannot
        // reach its rows. Agents absent from the grid are left alone entirely.
        const mine = stored.filter(doc => doc?.content && desired.has(String(doc.content.allocation_name || '')));

        const operations: SaveOperation[] = [];
        const claimed = new Set<string>();

        mine.forEach(doc => {
            const agentName = String(doc.content.allocation_name);
            const clientName = String(doc.content.cost_center_name || '');
            const key = `${agentName}|${clientName}`;
            const want = desired.get(agentName)!.get(clientName);

            // Claim the first document for a given agent and client; any further copy is a
            // duplicate from the old create-only save and is removed here.
            if (typeof want === 'number' && !claimed.has(key)) {
                claimed.add(key);
                if (parseFloat(doc.content.allocation_amount || '') === want) return;
                operations.push({
                    kind: 'PUT',
                    docId: doc.id,
                    agentName,
                    clientName,
                    promise: fetch(`${collectionUrl}${doc.id}`, {
                        method: 'PUT',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ content: {
                            allocation_date: allocationDate,
                            allocation_name: agentName,
                            cost_center_name: clientName,
                            cost_center_number: clientName, // Using name as number for this use case
                            allocation_amount: want.toString(),
                        }}),
                    }),
                });
                return;
            }

            operations.push({
                kind: 'DELETE',
                docId: doc.id,
                agentName,
                clientName,
                promise: fetch(`${collectionUrl}${doc.id}`, { method: 'DELETE' }),
            });
        });

        desired.forEach((rows, agentName) => {
            rows.forEach((fte, clientName) => {
                if (claimed.has(`${agentName}|${clientName}`)) return;
                operations.push({
                    kind: 'POST',
                    agentName,
                    clientName,
                    promise: fetch(collectionUrl, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ content: {
                            allocation_date: allocationDate,
                            allocation_name: agentName,
                            cost_center_name: clientName,
                            cost_center_number: clientName, // Using name as number for this use case
                            allocation_amount: fte.toString(),
                        }}),
                    }),
                });
            });
        });

        if (operations.length === 0) {
            toast({ title: 'No changes to save.' });
            setIsSubmitting(false);
            return;
        }

        const results = await Promise.all(operations.map(op => op.promise));
        const failures = operations
            .map((op, i) => ({ op, res: results[i] }))
            .filter(({ res }) => !res.ok);

        if (failures.length > 0) {
            const statuses = Array.from(new Set(failures.map(({ res }) => res.status))).join(', ');
            console.error('Save operations failed', failures.map(({ op, res }) => ({
                kind: op.kind, docId: op.docId, agentName: op.agentName, clientName: op.clientName, status: res.status,
            })));
            throw new Error(
                `${failures.length} of ${operations.length} changes failed (HTTP ${statuses}). ` +
                'Some changes may have been applied — reload the page before retrying.'
            );
        }

        toast({
            title: 'Allocations Saved',
            description: `${operations.length} change(s) for ${selectedMonth} ${selectedYear} have been saved successfully.`,
        });
        onSaveSuccess();
    } catch (error: any) {
        console.error("Save error:", error);
        toast({ variant: 'destructive', title: 'Save Failed', description: error.message });
    } finally {
        setIsSubmitting(false);
    }
  };

  const isGridLoading = isLoading || !currentDate;

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
          <div>
            <CardTitle>Allocation Grid</CardTitle>
            <CardDescription>Add employees to view and adjust their pre-populated ticket ratios.</CardDescription>
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            <EmployeeSelect 
                employees={availableEmployees}
                onValueChange={handleAddEmployee}
                value={selectedEmployeeToAdd}
                disabled={isGridLoading || isSubmitting}
            />
            <ManagerSelect disabled={isGridLoading || isSubmitting}/>
            <Button variant="outline" size="icon" onClick={handlePrevMonth} disabled={isGridLoading || isSubmitting}>
              <ChevronLeft className="h-4 w-4" />
            </Button>
            <span className="text-sm font-medium w-32 text-center">
              {currentDate ? format(currentDate, 'MMMM yyyy') : <Skeleton className="h-5 w-24" />}
            </span>
            <Button variant="outline" size="icon" onClick={handleNextMonth} disabled={isGridLoading || isSubmitting}>
              <ChevronRight className="h-4 w-4" />
            </Button>
            <Button onClick={handleSave} disabled={activeAllocations.length === 0 || isSubmitting || isGridLoading}>
              {isSubmitting ? 'Saving...' : 'Save All'}
            </Button>
          </div>
        </div>
      </CardHeader>
      <CardContent>
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="min-w-[200px] sticky left-0 bg-card z-10">Agent Name</TableHead>
                <TableHead className="min-w-[250px]">Client</TableHead>
                <TableHead className="text-center min-w-[150px]">FTE</TableHead>
                <TableHead className="w-[100px]"> </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {!hasMounted || isGridLoading ? (
                <TableRow>
                  <TableCell colSpan={4} className="h-24 text-center">
                     <Skeleton className="h-5 w-48 mx-auto" />
                  </TableCell>
                </TableRow>
              ) : activeAllocations.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={4} className="text-center h-24 text-muted-foreground">
                    Select an employee from the dropdown to begin.
                  </TableCell>
                </TableRow>
              ) : (
                activeAllocations.map(({ agentName, allocations }) => {
                  const totalFte = allocations.reduce((sum, alloc) => sum + (alloc.fte || 0), 0);
                  return (
                    <Fragment key={agentName}>
                      <TableRow className="bg-muted/50 hover:bg-muted">
                        <TableCell className="font-semibold sticky left-0 bg-muted/50 z-10">{agentName}</TableCell>
                        <TableCell></TableCell>
                        <TableCell className={cn("text-center font-semibold", totalFte > 0.01 && Math.abs(totalFte - 1.0) > 0.01 ? "text-destructive" : "text-muted-foreground")}>
                          {totalFte > 0 ? totalFte.toFixed(3) : '-'}
                        </TableCell>
                        <TableCell className='text-right'>
                          <Button variant="ghost" size="icon" title="Remove from grid (does not delete allocations)" onClick={() => handleRemoveEmployee(agentName)} disabled={isSubmitting}>
                            <X className="h-4 w-4 text-muted-foreground" />
                          </Button>
                        </TableCell>
                      </TableRow>

                      {allocations.map((alloc) => (
                        <TableRow key={alloc.id}>
                          <TableCell className="sticky left-0 bg-card z-10"></TableCell>
                          <TableCell>
                            <Input value={alloc.clientName} readOnly className="bg-muted" />
                          </TableCell>
                          <TableCell>
                            <Input
                              type="number" step="0.01" min="0" placeholder="0.00"
                              className="w-32 text-center mx-auto"
                              value={alloc.fte || ''}
                              onChange={(e) => handleFteChange(agentName, alloc.id, e.target.value)}
                              disabled={isSubmitting}
                            />
                          </TableCell>
                          <TableCell className='text-right'>
                            <Button variant="ghost" size="icon" onClick={() => handleRemoveAllocationRow(agentName, alloc.id)} disabled={isSubmitting}>
                              <Trash2 className="h-4 w-4 text-destructive" />
                            </Button>
                          </TableCell>
                        </TableRow>
                      ))}

                      <TableRow>
                        <TableCell className="sticky left-0 bg-card z-10 py-2" colSpan={2}>
                          <Button variant="outline" size="sm" className="w-full justify-start" onClick={() => handleAddAllocationRow(agentName)} disabled={isSubmitting}>
                            <PlusCircle className="mr-2 h-4 w-4" /> Add Manual Allocation
                          </Button>
                        </TableCell>
                        <TableCell colSpan={2}></TableCell>
                      </TableRow>
                    </Fragment>
                  );
                })
              )}
            </TableBody>
          </Table>
        </div>
      </CardContent>
    </Card>
  );
}
