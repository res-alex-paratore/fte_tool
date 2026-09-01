
'use client';

import { useState, useEffect } from 'react';
import { PageHeader } from '@/components/page-header';
import { MultiWeekGrid } from '@/components/allocation/multi-week-grid';
import { initializeFiscalCalendar, type FiscalCalendarEntry } from '@/lib/fiscal-calendar';
import { writeLog } from '@/lib/logger';

export default function AllocationPage() {
  const [currentDate, setCurrentDate] = useState<Date | null>(null);
  const [calendarInitialized, setCalendarInitialized] = useState(false);

  useEffect(() => {
    async function initCalendar() {
      try {
        const response = await fetch('/data/v1/global_445_calendar');
        if (response.ok) {
          const calendarData: Omit<FiscalCalendarEntry, 'parsedDate'>[] = await response.json();
          initializeFiscalCalendar(calendarData);
        } else {
          const errorPayload = { status: response.status, statusText: response.statusText };
          writeLog('AllocationPage', 'warning', 'Failed to load 4-4-5 calendar data, using fallback.', errorPayload);
          console.error("Failed to load 4-4-5 calendar data, using fallback.");
        }
      } catch (error) {
        writeLog('AllocationPage', 'error', 'Error initializing fiscal calendar', error);
        console.error("Error initializing calendar:", error);
      } finally {
        // This must be called in all paths to ensure client-side state
        // transitions correctly and avoids hydration errors.
        setCalendarInitialized(true);
        setCurrentDate(new Date());
      }
    }
    initCalendar();
  }, []);

  const isInitialLoading = !calendarInitialized || !currentDate;

  return (
    <div className="flex flex-col gap-8">
       <PageHeader
        title="Weekly Allocation"
        description="Allocate FTEs for the current calendar month."
      />
      {/* No onSaveSuccess: the saved allocations table is gone and the grid refetches itself. */}
      <MultiWeekGrid 
        currentDate={currentDate} 
        setCurrentDate={setCurrentDate} 
        initialLoading={isInitialLoading}
      />
      {/* The saved allocations table has been removed. All work is now done in the grid above. */}
    </div>
  );
}
