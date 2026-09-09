
'use client';

import { useEffect, useState, useMemo } from 'react';
import { Users, Briefcase, UserMinus, ChevronsUpDown, ChevronLeft, ChevronRight } from 'lucide-react';
import SummaryCard from '@/components/dashboard/summary-card';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import type { TeamMember, WeeklyAllocation, BulkFteDoc, BulkSummaryDoc } from '@/types';
import { useToast } from '@/hooks/use-toast';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Skeleton } from '@/components/ui/skeleton';
import FteAllocationChart from '@/components/dashboard/fte-allocation-chart';
import { startOfWeek, subWeeks, addWeeks, addDays, addMonths, subMonths, startOfMonth, isSameMonth, format, isValid, parseISO } from 'date-fns';
import { PageHeader } from '../page-header';
import { writeLog } from '@/lib/logger';
import { normalizeHrRoster } from '@/lib/hr-roster';
import { formatAllocationMonthYear, getWeeksForMonth, initializeFiscalCalendar, type FiscalCalendarEntry } from '@/lib/fiscal-calendar';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover';
import { Button } from '../ui/button';
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from '../ui/command';
import { Checkbox } from '../ui/checkbox';

type ActiveView = 'total' | 'allocated' | 'unallocated' | null;

type ChartData = {
  name: string;
  [key: string]: any;
};

type FilterOptions = {
  fullNames: string[];
  titles: string[];
  managers: string[];
  departments: string[];
};

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
    const s = (search || '').toLowerCase();
    if (!s) return options || [];
    return (options || []).filter(o => o && String(o).toLowerCase().includes(s));
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
          <div className="flex items-center border-b px-3">
            <input
              className="flex h-11 w-full rounded-md bg-transparent py-3 text-sm outline-none placeholder:text-muted-foreground disabled:cursor-not-allowed disabled:opacity-50"
              placeholder={`Search ${placeholder.toLowerCase()}...`}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
          <CommandList className="max-h-64 overflow-y-auto">
            <CommandEmpty>No results found.</CommandEmpty>
            <CommandGroup>
              {filteredOptions.map((option, idx) => (
                <CommandItem
                  key={`${option}-${idx}`}
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


/**
 * The Monday keys of the fiscal month containing `date`.
 *
 * Prefers the 4-4-5 calendar so these match the weeks the allocation grid offers. Falls back to
 * generating them when that dataset is unavailable: getWeeksForMonth reads a module-level singleton
 * that only initializeFiscalCalendar fills, and an empty result would silently show every weekly
 * allocation as 0.00 rather than failing visibly.
 */
const monthWeekKeysFor = (date: Date): string[] => {
  const fromCalendar = (getWeeksForMonth(date) || [])
    .map(w => format(startOfWeek(w.startDate, { weekStartsOn: 1 }), 'yyyy-MM-dd'));
  if (fromCalendar.length > 0) return fromCalendar;

  // Same rule as getOwningMonth: a week belongs to the month containing its Friday.
  const keys: string[] = [];
  let cursor = startOfWeek(startOfMonth(subWeeks(date, 2)), { weekStartsOn: 1 });
  const limit = addWeeks(startOfMonth(date), 7);
  while (cursor <= limit) {
    if (isSameMonth(addDays(cursor, 4), date)) keys.push(format(cursor, 'yyyy-MM-dd'));
    cursor = addWeeks(cursor, 1);
  }
  return keys;
};

export function DashboardContent() {
  const [loading, setLoading] = useState(true);
  const [today, setToday] = useState<Date | null>(null);
  const [hasMounted, setHasMounted] = useState(false);

  const [allEmployees, setAllEmployees] = useState<TeamMember[]>([]);
  const [weeklyAllocations, setWeeklyAllocations] = useState<WeeklyAllocation[]>([]);
  const [bulkFtes, setBulkFtes] = useState<BulkFteDoc[]>([]);
  const [bulkSummaries, setBulkSummaries] = useState<BulkSummaryDoc[]>([]);

  // The month the whole page is framed on. Every figure and every chart uses this, so the scroller
  // moves the table and the chart together.
  const [selectedDate, setSelectedDate] = useState<Date | null>(null);

  const [activeView, setActiveView] = useState<ActiveView>('total');
  const [employeeFilters, setEmployeeFilters] = useState({ 
    fullName: [] as string[], 
    title: [] as string[], 
    manager: [] as string[],
    department: [] as string[]
  });
  const [chartClientFilter, setChartClientFilter] = useState<string[]>([]);
  const [chartView, setChartView] = useState<'weekly' | 'bulk' | 'freshservice' | 'total'>('weekly');
  
  const { toast } = useToast();
  
  useEffect(() => {
    setHasMounted(true);
    const now = new Date();
    setToday(now);
    setSelectedDate(now);

    async function fetchData() {
      setLoading(true);
      try {
        const [
          calendarResponse,
          empResponse,
          weeklyAllocResponse,
          bulkFteResponse,
          bulkSummaryResponse,
        ] = await Promise.all([
          fetch(`/data/v1/global_445_calendar`),
          fetch(`/data/v1/consolidated_hr_fte_report_view`),
          fetch(`/domo/datastores/v1/collections/weekly_allocation/documents/`),
          fetch(`/domo/datastores/v1/collections/bulk_allocation_fte/documents/`),
          fetch(`/domo/datastores/v1/collections/bulk_allocation_summary/documents/`),
        ]);

        // The fiscal calendar is a module-level singleton, and only the Allocation page used to
        // fill it. Reaching this page directly left getWeeksForMonth returning nothing, which
        // showed every weekly allocation as 0.00. Initialise it here too — the call is idempotent.
        if (calendarResponse.ok) {
          const calendarData: Omit<FiscalCalendarEntry, 'parsedDate'>[] = await calendarResponse.json();
          initializeFiscalCalendar(calendarData);
        } else {
          writeLog('DashboardContent', 'warning', 'Failed to load 4-4-5 calendar, using generated weeks', {
            status: calendarResponse.status,
          });
        }

        const rawEmps = empResponse.ok ? await empResponse.json() : [];
        const rawWeekly = weeklyAllocResponse.ok ? await weeklyAllocResponse.json() : [];
        const rawBFtes = bulkFteResponse.ok ? await bulkFteResponse.json() : [];
        const rawBSums = bulkSummaryResponse.ok ? await bulkSummaryResponse.json() : [];

        setAllEmployees(normalizeHrRoster(rawEmps));
        setWeeklyAllocations(Array.isArray(rawWeekly) ? rawWeekly.filter(a => a?.content) : []);
        setBulkFtes(Array.isArray(rawBFtes) ? rawBFtes.filter(f => f?.content) : []);
        setBulkSummaries(Array.isArray(rawBSums) ? rawBSums.filter(s => s?.content) : []);

      } catch (error) {
        writeLog('DashboardContent', 'error', 'Failed to load dashboard data', error);
      } finally {
        setLoading(false);
      }
    }
    fetchData();
  }, []);

  const filteredEmployeesBase = useMemo(() => {
    if (!hasMounted) return [];
    return (allEmployees || [])
      .filter(member => {
        if (!member) return false;
        
        const fullName = member.full_name || member.Full_Name || '';
        const title = member.title || member.Market_Facing_Title || '';
        const manager = member.manager || member.First_Reviewer_Name || '';
        const department = member.department || member.Team_Name || '';

        const fullNameMatch = employeeFilters.fullName.length === 0 || employeeFilters.fullName.includes(fullName);
        const titleMatch = employeeFilters.title.length === 0 || employeeFilters.title.includes(title);
        const managerMatch = employeeFilters.manager.length === 0 || employeeFilters.manager.includes(manager);
        const deptMatch = employeeFilters.department.length === 0 || employeeFilters.department.includes(department);

        return fullNameMatch && titleMatch && managerMatch && deptMatch;
      })
      .sort((a, b) => {
        const nameA = (a.full_name || a.Full_Name || '').toLowerCase();
        const nameB = (b.full_name || b.Full_Name || '').toLowerCase();
        return nameA.localeCompare(nameB);
      });
  }, [allEmployees, employeeFilters, hasMounted]);

  const stats = useMemo(() => {
    if (!selectedDate || !hasMounted || loading) {
      return { totalFtes: 0, allocatedFtes: 0, unallocatedFtes: 0, allocatedEmployees: [], unallocatedEmployees: [], allocatedFteMap: new Map<string, number>() };
    }

    const safeEmployees = filteredEmployeesBase;

    // Both this table and the Weekly chart are framed on the current fiscal month, taken from the
    // same calendar helper the allocation grid uses so the weeks line up with what managers edit.
    const monthWeekKeys = new Set(monthWeekKeysFor(selectedDate));
    const monthAllocations = (weeklyAllocations || []).filter(a => a?.content?.allocation_date && monthWeekKeys.has(a.content.allocation_date));

    const currentMonthYear = formatAllocationMonthYear(selectedDate);

    // The two branches are alternative ways of allocating the same person for the same week, so
    // they are accumulated separately and combined per employee below rather than summed. A bulk
    // profile cannot be saved unless its allocation equals its members' total FTE
    // (bulk-allocation-grid.tsx handleSave), so profile membership already means a person is fully
    // allocated for that month. Adding weekly rows on top double-counted them, which is what
    // showed 2.00 for anyone allocated both ways.
    const weeklyFteMap = new Map<string, number>();
    const bulkFteMap = new Map<string, number>();

    // Monthly figure is SUM(allocation_amount) / weeks-that-have-a-row, matching the Domo cards
    // (DASHBOARD_HANDOVER.md 10.1). Note there is no `> 0` filter: an explicit 0 is a real entry
    // and has to reach the denominator, because that is how a partial month is recorded — users
    // zero the weeks somebody is not allocated rather than the app writing a placeholder row for
    // every person and client. Dropping zeros here would silently restore the over-report.
    const weeklyWeeksWithData = new Map<string, Set<string>>();

    monthAllocations.forEach(a => {
        const content = a?.content;
        if (!content) return;

        const amount = parseFloat(content.allocation_amount || '0');
        if (!Number.isFinite(amount)) return;

        let empId = content.employee_id || '';
        if (!empId && content.allocation_name) {
          const match = String(content.allocation_name).match(/\[(.*?)\]/);
          if (match && match[1]) empId = match[1];
        }
        if (!empId) return;

        weeklyFteMap.set(empId, (weeklyFteMap.get(empId) || 0) + amount);
        if (!weeklyWeeksWithData.has(empId)) weeklyWeeksWithData.set(empId, new Set<string>());
        weeklyWeeksWithData.get(empId)!.add(content.allocation_date);
    });

    weeklyWeeksWithData.forEach((weeks, empId) => {
        const total = weeklyFteMap.get(empId) || 0;
        weeklyFteMap.set(empId, weeks.size > 0 ? total / weeks.size : 0);
    });

    const profileCapacityMap = new Map<string, number>();
    const profileAssignments = (bulkFtes || []).filter(f => f?.content?.allocation_monthyear === currentMonthYear);
    
    profileAssignments.forEach(f => {
        const empId = f.content.employee_id;
        const emp = allEmployees.find(ae => ae && (ae.person_id === empId || ae.Person_Number === empId));
        if (emp) {
            const base = parseFloat(emp.fte || emp.FTE || '0') || 0;
            const pid = f.content.bulk_allocation_id;
            if (pid) profileCapacityMap.set(pid, (profileCapacityMap.get(pid) || 0) + (isFinite(base) ? base : 0));
        }
    });

    const profileSummariesByProfileId = (bulkSummaries || []).reduce((acc, s) => {
        if (!s?.content?.bulk_allocation_id) return acc;
        if (!acc[s.content.bulk_allocation_id]) acc[s.content.bulk_allocation_id] = [];
        acc[s.content.bulk_allocation_id].push(s);
        return acc;
    }, {} as Record<string, BulkSummaryDoc[]>);

    profileAssignments.forEach(f => {
        const empId = f.content.employee_id;
        const profileId = f.content.bulk_allocation_id;
        if (!empId || !profileId) return;

        const summaries = profileSummariesByProfileId[profileId] || [];
        const groupCapacity = profileCapacityMap.get(profileId) || 0;
        
        if (groupCapacity > 0) {
            const employee = safeEmployees.find(e => e && (e.person_id === empId || e.Person_Number === empId));
            if (employee) {
                const baseFte = parseFloat(employee.fte || employee.FTE || '0') || 0;
                if (!isFinite(baseFte)) return;

                summaries.forEach(s => {
                    const profileFteAmount = parseFloat(s?.content?.allocation_percentage || '0') || 0;
                    if (!isFinite(profileFteAmount)) return;
                    
                    const individualShare = (profileFteAmount / groupCapacity) * baseFte;
                    if (!isFinite(individualShare)) return;

                    const current = bulkFteMap.get(empId) || 0;
                    bulkFteMap.set(empId, current + (Number.isNaN(individualShare) ? 0 : individualShare));
                });
            }
        }
    });

    // Whichever branch claims more of the person's capacity wins. Max rather than a fixed
    // precedence: it cannot understate someone whose profile covers them in full but who also has
    // a small stray weekly row, and it still surfaces genuine over-allocation within one branch
    // (weekly rows totalling 1.20 continue to read 1.20).
    const allocatedFteMap = new Map<string, number>();
    new Set([...weeklyFteMap.keys(), ...bulkFteMap.keys()]).forEach(empId => {
        allocatedFteMap.set(empId, Math.max(weeklyFteMap.get(empId) || 0, bulkFteMap.get(empId) || 0));
    });

    let totalBaseFteSum = 0;
    let totalAllocatedFteSum = 0;
    
    safeEmployees.forEach(e => {
        const empId = e.person_id || e.Person_Number;
        const base = parseFloat(e.fte || e.FTE || '0') || 0;
        const alloc = allocatedFteMap.get(empId) || 0;
        
        totalBaseFteSum += (isFinite(base) ? base : 0);
        totalAllocatedFteSum += (isFinite(alloc) ? alloc : 0);
    });

    const allocatedEmps = safeEmployees.filter(e => (allocatedFteMap.get(e.person_id || e.Person_Number) || 0) > 0.005);
    const unallocatedEmps = safeEmployees.filter(e => (allocatedFteMap.get(e.person_id || e.Person_Number) || 0) <= 0.005);
    
    return {
      totalFtes: totalBaseFteSum,
      allocatedFtes: totalAllocatedFteSum,
      unallocatedFtes: Math.max(0, totalBaseFteSum - totalAllocatedFteSum),
      allocatedEmployees: allocatedEmps,
      unallocatedEmployees: unallocatedEmps,
      allocatedFteMap
    };
  }, [selectedDate, hasMounted, loading, filteredEmployeesBase, weeklyAllocations, bulkFtes, bulkSummaries, allEmployees]);

  // The chart shows only the employees the table is showing, so the employee filters and the
  // selected tile drive both halves of the page from one place.
  const tableEmployeeIds = useMemo(() => {
    const source = activeView === 'allocated' ? stats.allocatedEmployees
      : activeView === 'unallocated' ? stats.unallocatedEmployees
      : filteredEmployeesBase;
    return new Set(
      (source || []).map(e => String(e?.person_id || e?.Person_Number || '')).filter(Boolean)
    );
  }, [activeView, stats, filteredEmployeesBase]);

  const employeeFilterOptions = useMemo<FilterOptions>(() => {
    const safeEmployees = (allEmployees || []).filter(e => e && (e.person_id || e.Person_Number));
    function getUniqueSorted(field1: keyof TeamMember, field2?: keyof TeamMember) {
        return Array.from(
            new Set(
                safeEmployees
                    .map(item => item && (item[field1] || (field2 ? item[field2] : '')))
                    .filter(val => typeof val === 'string' && val) as string[]
            )
        ).sort((a, b) => a.localeCompare(b));
    }

    return {
      fullNames: getUniqueSorted('full_name', 'Full_Name'),
      titles: getUniqueSorted('title', 'Market_Facing_Title'),
      managers: getUniqueSorted('manager', 'First_Reviewer_Name'),
      departments: getUniqueSorted('department', 'Team_Name'),
    };
  }, [allEmployees]);
  
  const allChartClients = useMemo<string[]>(() => {
    if (loading || !hasMounted) return [];
    const clientsSet = new Set<string>();
    (weeklyAllocations || []).forEach(a => { if (a?.content?.cost_center_name) clientsSet.add(String(a.content.cost_center_name)); });
    (bulkSummaries || []).forEach(s => { if (s?.content?.cost_center_name) clientsSet.add(String(s.content.cost_center_name)); });

    return Array.from(clientsSet)
      .filter(c => typeof c === 'string' && c)
      .sort((a,b) => a.localeCompare(b));
  }, [loading, hasMounted, weeklyAllocations, bulkSummaries]);

  const chartState = useMemo(() => {
    if (!selectedDate || !hasMounted || loading) {
        return { chartData: [], chartTitle: 'Loading Chart...', chartDescription: '...'};
    }

    const currentChartClientFilter = chartClientFilter || [];
    const monthLabel = format(selectedDate, 'MMMM yyyy');
    const selectedMonthYear = formatAllocationMonthYear(selectedDate);
    const selectedYearMonth = format(selectedDate, 'yyyy-MM');

    const localAllEmployees = allEmployees || [];

    // Resolve an allocation row to a person — by employee_id, by the [id] prefix the weekly and
    // targets grids write, or by the bare name the Freshservice and ratio grids write — then keep
    // the row only if that person is in the table.
    const matchesTable = (id?: string, name?: string) => {
        if (id && tableEmployeeIds.has(String(id))) return true;
        if (!name) return false;
        const match = String(name).match(/\[(.*?)\]/);
        if (match && match[1]) return tableEmployeeIds.has(match[1]);
        const emp = localAllEmployees.find(e => e && (e.full_name === name || e.Full_Name === name));
        const empId = emp ? String(emp.person_id || emp.Person_Number || '') : '';
        return !!empId && tableEmployeeIds.has(empId);
    };

    let initialChartData: ChartData[] = [];
    let title: string = 'FTE Allocation';
    let description: string = 'FTE distribution over time.';

    switch(chartView) {
        case 'bulk': {
            const bulkSummariesByProfileId = (bulkSummaries || []).reduce((acc, summary) => {
                if (!summary?.content?.bulk_allocation_id) return acc;
                if (!acc[summary.content.bulk_allocation_id]) acc[summary.content.bulk_allocation_id] = [];
                acc[summary.content.bulk_allocation_id].push(summary);
                return acc;
            }, {} as Record<string, BulkSummaryDoc[]>);

            const profileCapacityMap = new Map<string, number>();
            (bulkFtes || []).forEach(f => {
                const emp = localAllEmployees.find(ae => ae && (ae.person_id === f.content.employee_id || ae.Person_Number === f.content.employee_id));
                if (emp) {
                    const base = parseFloat(emp.fte || emp.FTE || '0') || 0;
                    const pid = f.content.bulk_allocation_id;
                    if (pid) profileCapacityMap.set(pid, (profileCapacityMap.get(pid) || 0) + (isFinite(base) ? base : 0));
                }
            });

            // Only the selected month. A bulk profile is a monthly artefact, so the month is a
            // single group and the clients are the bars within it — there is no weekly grain to
            // break out without inventing one.
            const bulkClientTotals = (bulkFtes || []).reduce((acc, fte) => {
                const { allocation_monthyear, bulk_allocation_id, employee_id, employee_name } = fte?.content || {};
                if (!allocation_monthyear || !bulk_allocation_id) return acc;
                if (allocation_monthyear !== selectedMonthYear) return acc;
                if (!matchesTable(employee_id, employee_name)) return acc;
                
                const groupCapacity = profileCapacityMap.get(bulk_allocation_id) || 0;
                if (groupCapacity <= 0) return acc;

                const summariesForFte = bulkSummariesByProfileId[bulk_allocation_id] || [];
                const employee = localAllEmployees.find(e => e && (e.person_id === employee_id || e.Person_Number === employee_id));
                const baseFte = employee ? (parseFloat(employee.fte || employee.FTE || '0') || 0) : 0;
                if (!isFinite(baseFte)) return acc;

                summariesForFte.forEach(summary => {
                    const profileFteAmount = parseFloat(summary?.content?.allocation_percentage || '0') || 0;
                    if (!isFinite(profileFteAmount)) return;
                    const clientName = summary?.content?.cost_center_name || 'Unknown';
                    const share = (profileFteAmount / groupCapacity) * baseFte;
                    if (isFinite(share)) {
                        acc[clientName] = (acc[clientName] || 0) + share;
                    }
                });
                return acc;
            }, {} as Record<string, number>);
            initialChartData = Object.keys(bulkClientTotals).length > 0
              ? [{ name: monthLabel, ...bulkClientTotals }]
              : [];
            title = "Bulk Allocations";
            description = `Total FTEs assigned per client via bulk allocation profiles in ${monthLabel}.`;
            break;
        }
        case 'freshservice': {
            const freshserviceAllocations = (weeklyAllocations || []).filter(a => {
                if (!a?.content) return false;
                const isManual = a.content.cost_center_name === 'MANUAL ENTRY';
                const matchesDept = matchesTable(a.content.employee_id, a.content.allocation_name);
                return !isManual && matchesDept;
            });
            // Matched on the calendar month rather than the week keys: the Freshservice and ratio
            // grids stamp allocation_date as the first of the month, not a Monday.
            const freshserviceClientTotals = freshserviceAllocations.reduce((acc, alloc) => {
                const dateStr = alloc?.content?.allocation_date;
                if (!dateStr || String(dateStr).slice(0, 7) !== selectedYearMonth) return acc;
                const clientName = alloc?.content?.cost_center_name || 'Unknown';
                const amount = parseFloat(alloc?.content?.allocation_amount || '0') || 0;
                if (isFinite(amount)) {
                    acc[clientName] = (acc[clientName] || 0) + amount;
                }
                return acc;
            }, {} as Record<string, number>);
             initialChartData = Object.keys(freshserviceClientTotals).length > 0
               ? [{ name: monthLabel, ...freshserviceClientTotals }]
               : [];
             title = "Freshservice Allocations";
             description = `Total FTEs assigned per client from Freshservice ticket ratios in ${monthLabel}.`;
             break;
        }
        case 'total':
        case 'weekly':
        default: {
            const isTotal = chartView === 'total';
            const weeksCount = isTotal ? 8 : 6;
            const allWeeklyClients = Array.from(new Set((weeklyAllocations || []).map(a => String(a?.content?.cost_center_name)).filter(c => c && c !== 'undefined')));
            // Weekly is framed on the current fiscal month, from the same helper the table uses, so
            // the chart beside it covers exactly the same weeks. Total stays a rolling trend — that
            // view exists to show movement over time, which one month cannot.
            const lastPeriod = isTotal
              ? Array.from({ length: weeksCount }, (_, i) => startOfWeek(subWeeks(selectedDate, (weeksCount - 1) - i), { weekStartsOn: 1 }))
              : monthWeekKeysFor(selectedDate).map(k => startOfWeek(parseISO(k), { weekStartsOn: 1 }));
            initialChartData = lastPeriod.map(weekStart => {
              const weekKey = format(weekStart, 'yyyy-MM-dd');
              const allocationsForWeek = (weeklyAllocations || []).filter(a => {
                  if (!a?.content || a.content.allocation_date !== weekKey) return false;
                  return matchesTable(a.content.employee_id, a.content.allocation_name);
              });
              const weeklyTotals = allocationsForWeek.reduce((acc, curr) => {
                const clientName = curr?.content?.cost_center_name || 'Unknown';
                const amount = parseFloat(curr?.content?.allocation_amount || '0') || 0;
                if (isFinite(amount)) {
                    acc[clientName] = (acc[clientName] || 0) + amount;
                }
                return acc;
              }, {} as Record<string, number>);
              const completeWeeklyData: Record<string, any> = { name: weekKey };
              allWeeklyClients.forEach(client => { if (client) completeWeeklyData[client as string] = weeklyTotals[client as string] || 0; });
              return completeWeeklyData;
            });
            title = isTotal ? "Total FTE Allocation Trend" : "Weekly Client Allocation";
            description = isTotal
              ? `FTEs allocated per client over the 8 weeks up to ${monthLabel}.`
              : `Total FTEs allocated per client, by week of ${monthLabel}.`;
            break;
        }
    }

    const finalChartData = currentChartClientFilter.length > 0 ? initialChartData.map(item => {
            const newItem: { [key: string]: any } = { name: item?.name || 'Unknown' };
            currentChartClientFilter.forEach(client => { if (item && item[client] !== undefined) newItem[client] = item[client]; });
            return newItem;
          }) : initialChartData;

    return { chartData: finalChartData, chartTitle: title, chartDescription: description };
  }, [selectedDate, hasMounted, loading, chartView, weeklyAllocations, bulkFtes, bulkSummaries, chartClientFilter, allEmployees, tableEmployeeIds]);

  const detailState = useMemo(() => {
    if (!hasMounted) return { title: 'FTE List', data: [], description: 'Loading...' };
    
    let baseData: TeamMember[] = [];
    let baseTitle: string = 'FTE List';
    switch (activeView) {
      case 'total': baseData = filteredEmployeesBase; baseTitle = 'All FTEs'; break;
      case 'allocated': baseData = stats.allocatedEmployees; baseTitle = 'Allocated FTEs (Current Month)'; break;
      case 'unallocated': baseData = stats.unallocatedEmployees; baseTitle = 'Unallocated FTEs (Current Month)'; break;
      default: baseData = filteredEmployeesBase; baseTitle = 'All FTEs';
    }
    
    const isFiltered = employeeFilters.fullName.length > 0 || employeeFilters.title.length > 0 || employeeFilters.manager.length > 0 || employeeFilters.department.length > 0;
    let descriptionText = `Displaying ${baseData.length} employee(s).`;
    if (isFiltered) descriptionText = `Displaying ${baseData.length} filtered employee(s).`;
    return { title: baseTitle, data: baseData, description: descriptionText };
  }, [activeView, filteredEmployeesBase, stats.allocatedEmployees, stats.unallocatedEmployees, employeeFilters, hasMounted]);

  const handleCardClick = (view: ActiveView) => setActiveView(current => (current === view ? null : view));
  const handleEmployeeFilterChange = (filterName: keyof typeof employeeFilters, value: string) => setEmployeeFilters(prev => { const current = prev[filterName] || []; const next = current.includes(value) ? current.filter(v => v !== value) : [...current, value]; return { ...prev, [filterName]: next }; });
  const handleChartClientFilterChange = (value: string) => setChartClientFilter(prev => { const current = prev || []; return current.includes(value) ? current.filter(v => v !== value) : [...current, value]; });
  const clearEmployeeFilters = () => setEmployeeFilters({ fullName: [], title: [], manager: [], department: [] });
  const clearChartFilters = () => { setChartClientFilter([]); };

  const handlePrevMonth = () => setSelectedDate(prev => (prev ? subMonths(prev, 1) : prev));
  const handleNextMonth = () => setSelectedDate(prev => (prev ? addMonths(prev, 1) : prev));
  const isPageLoading = loading || !today || !selectedDate || !hasMounted;

  const totalFteVal = isPageLoading ? 0 : (parseFloat(stats.totalFtes.toString()) || 0);
  const allocatedFteVal = isPageLoading ? 0 : (parseFloat(stats.allocatedFtes.toString()) || 0);
  const unallocatedFteVal = isPageLoading ? 0 : (parseFloat(stats.unallocatedFtes.toString()) || 0);

  return (
    <div className="flex flex-col gap-8">
      <PageHeader title="Dashboard" />
      <div className="flex items-center justify-center gap-2">
        <Button variant="outline" size="icon" onClick={handlePrevMonth} disabled={isPageLoading}>
          <ChevronLeft className="h-4 w-4" />
        </Button>
        <span className="text-sm font-medium w-40 text-center">
          {isPageLoading || !selectedDate ? <Skeleton className="h-5 w-32 mx-auto" /> : format(selectedDate, 'MMMM yyyy')}
        </span>
        <Button variant="outline" size="icon" onClick={handleNextMonth} disabled={isPageLoading}>
          <ChevronRight className="h-4 w-4" />
        </Button>
      </div>
      <div className="grid gap-4 md:grid-cols-3">
        <SummaryCard title="Total FTEs" value={isPageLoading ? <Skeleton className="h-8 w-1/2" /> : (Number.isNaN(totalFteVal) ? '0.00' : totalFteVal.toFixed(2))} icon={Users} onClick={() => handleCardClick('total')} isActive={activeView === 'total'} />
        <SummaryCard title="Allocated FTEs" value={isPageLoading ? <Skeleton className="h-8 w-1/2" /> : (Number.isNaN(allocatedFteVal) ? '0.00' : allocatedFteVal.toFixed(2))} icon={Briefcase} onClick={() => handleCardClick('allocated')} isActive={activeView === 'allocated'} />
        <SummaryCard title="Unallocated FTEs" value={isPageLoading ? <Skeleton className="h-8 w-1/2" /> : (Number.isNaN(unallocatedFteVal) ? '0.00' : unallocatedFteVal.toFixed(2))} icon={UserMinus} onClick={() => handleCardClick('unallocated')} isActive={activeView === 'unallocated'} />
      </div>
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
          <Card>
            <CardHeader>
              <div className="flex flex-col sm:flex-row sm:justify-between sm:items-start gap-4">
                <div className="flex-1">
                  <CardTitle>{isPageLoading ? <Skeleton className="h-6 w-2/3" /> : chartState.chartTitle}</CardTitle>
                  <CardDescription>{isPageLoading ? <Skeleton className="h-4 w-full" /> : chartState.chartDescription}</CardDescription>
                </div>
                <Tabs value={chartView} onValueChange={(v) => setChartView(v as any)} className="w-full sm:w-auto">
                    <TabsList className="grid w-full grid-cols-2 sm:grid-cols-4 h-auto sm:h-10">
                        <TabsTrigger value="weekly">Weekly</TabsTrigger>
                        <TabsTrigger value="bulk">Bulk</TabsTrigger>
                        <TabsTrigger value="freshservice">Freshservice</TabsTrigger>
                        <TabsTrigger value="total">Total</TabsTrigger>
                    </TabsList>
                </Tabs>
              </div>
               <div className="grid grid-cols-1 md:grid-cols-2 gap-2 pt-4">
                  <MultiSelectFilter placeholder="Filter by Client..." options={allChartClients} selected={chartClientFilter} onValueChange={handleChartClientFilterChange} disabled={isPageLoading} />
                  <Button variant="outline" onClick={clearChartFilters} disabled={isPageLoading || chartClientFilter.length === 0}>Clear Client Filter</Button>
              </div>
              <p className="text-xs text-muted-foreground pt-2">
                Showing the employees listed in the table — use its filters, and the cards above, to narrow both.
              </p>
            </CardHeader>
            <CardContent>{isPageLoading ? <Skeleton className="h-[400px] w-full" /> : <FteAllocationChart data={chartState.chartData} />}</CardContent>
          </Card>
          <Card>
            <CardHeader>
               <div className="flex justify-between items-start gap-4">
                    <div>
                        <CardTitle>{isPageLoading ? <Skeleton className="h-6 w-1/3" /> : detailState.title}</CardTitle>
                        <CardDescription>{isPageLoading ? <Skeleton className="h-4 w-2/3" /> : detailState.description}</CardDescription>
                    </div>
                    <Button variant="outline" size="sm" onClick={clearEmployeeFilters} disabled={isPageLoading}>Clear Filters</Button>
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-2 pt-4">
                    <MultiSelectFilter placeholder="Name..." options={employeeFilterOptions.fullNames} selected={employeeFilters.fullName} onValueChange={value => handleEmployeeFilterChange('fullName', value)} disabled={isPageLoading} />
                    <MultiSelectFilter placeholder="Title..." options={employeeFilterOptions.titles} selected={employeeFilters.title} onValueChange={value => handleEmployeeFilterChange('title', value)} disabled={isPageLoading} />
                    <MultiSelectFilter placeholder="Manager..." options={employeeFilterOptions.managers} selected={employeeFilters.manager} onValueChange={value => handleEmployeeFilterChange('manager', value)} disabled={isPageLoading} />
                    <MultiSelectFilter placeholder="Department..." options={employeeFilterOptions.departments} selected={employeeFilters.department} onValueChange={value => handleEmployeeFilterChange('department', value)} disabled={isPageLoading} />
                </div>
            </CardHeader>
            <CardContent>
              <ScrollArea className="h-[330px]">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Full Name</TableHead>
                      <TableHead>Title</TableHead>
                      <TableHead>Manager</TableHead>
                      <TableHead className="text-right">Allocated FTE</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {isPageLoading ? (
                       Array.from({ length: 5 }).map((_, i) => (
                        <TableRow key={i}>
                          <TableCell><Skeleton className="h-5 w-full" /></TableCell>
                          <TableCell><Skeleton className="h-5 w-full" /></TableCell>
                          <TableCell><Skeleton className="h-5 w-full" /></TableCell>
                          <TableCell><Skeleton className="h-5 w-full" /></TableCell>
                        </TableRow>
                      ))
                    ) : (detailState.data || []).length > 0 ? detailState.data.map((employee, idx) => {
                      const empId = employee.person_id || employee.Person_Number;
                      const allocatedAmount = stats.allocatedFteMap.get(empId) || 0;
                      
                      return (
                        <TableRow key={empId || idx}>
                          <TableCell>{employee.full_name || employee.Full_Name}</TableCell>
                          <TableCell>{employee.title || employee.Market_Facing_Title}</TableCell>
                          <TableCell>{employee.manager || employee.First_Reviewer_Name}</TableCell>
                          <TableCell className="text-right font-mono">{Number.isNaN(allocatedAmount) ? '0.00' : allocatedAmount.toFixed(2)}</TableCell>
                        </TableRow>
                      );
                    }) : (
                      <TableRow>
                        <TableCell colSpan={4} className="h-24 text-center text-muted-foreground">No data to display.</TableCell>
                      </TableRow>
                    )}
                  </TableBody>
                </Table>
              </ScrollArea>
            </CardContent>
          </Card>
      </div>
    </div>
  );
}

