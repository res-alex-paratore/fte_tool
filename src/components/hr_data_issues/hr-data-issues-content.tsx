'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { useToast } from '@/hooks/use-toast';
import { useCurrentUser } from '@/hooks/use-current-user';
import { writeLog } from '@/lib/logger';
import { cn } from '@/lib/utils';
import {
  HR_SOURCE_LABELS,
  collectPersonRows,
  diagnosePerson,
  getHrSource,
  getPersonKey,
  toIsoDate,
  type HistoryHrRow,
  type HrSource,
  type RawHrRow,
  type RosterHrRow,
} from '@/lib/hr-issues';
import { PersonSearch, type SearchEntry } from './person-search';
import { PersonPanel } from './person-panel';
import { LogIssueForm } from './log-issue-form';
import { IssuesTable } from './issues-table';
import { fetchIssues, type HrDataIssueDoc } from './issues-api';

type QualityRow = { table?: string; last_update_date?: string };

const STALE_AFTER_DAYS = 7;

async function loadDataset<T>(alias: string): Promise<T[]> {
  const response = await fetch(`/data/v1/${alias}`);
  if (!response.ok) {
    writeLog('HrDataIssues', 'warning', `Dataset '${alias}' returned ${response.status}`, { statusText: response.statusText });
    return [];
  }
  const data = await response.json();
  return Array.isArray(data) ? data : [];
}

function str(value: unknown): string {
  return value === null || value === undefined ? '' : String(value).trim();
}

function searchKey(row: RawHrRow): string {
  const key = getPersonKey(row);
  if (key && key !== 'mex:') return key;
  if (str(row.person_email)) return `email:${str(row.person_email).toLowerCase()}`;
  return `name:${str(row.full_name).toLowerCase()}`;
}

/** One entry per person across all three datasets, so dropped people are still searchable. */
function buildSearchEntries(raw: RawHrRow[], roster: RosterHrRow[], history: HistoryHrRow[]): SearchEntry[] {
  const byKey = new Map<string, SearchEntry>();
  const add = (row: RawHrRow, where: 'inRaw' | 'inRoster' | 'inHistory') => {
    if (!str(row.full_name) && !str(row.person_email) && !str(row.person_id)) return;
    const key = searchKey(row);
    let entry = byKey.get(key);
    if (!entry) {
      const { source } = getHrSource(row);
      entry = {
        key,
        personId: str(row.person_id),
        email: str(row.person_email),
        name: str(row.full_name),
        inRaw: false,
        inRoster: false,
        inHistory: false,
        sourceLabel: source ? HR_SOURCE_LABELS[source] : '',
      };
      byKey.set(key, entry);
    }
    entry[where] = true;
    if (!entry.name) entry.name = str(row.full_name);
    if (!entry.email) entry.email = str(row.person_email);
  };
  roster.forEach(r => add(r, 'inRoster'));
  raw.forEach(r => add(r, 'inRaw'));
  history.forEach(r => add(r, 'inHistory'));
  return [...byKey.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export function HrDataIssuesContent() {
  const { toast } = useToast();
  const { currentUser, isAdmin, loading: userLoading } = useCurrentUser();

  const [raw, setRaw] = useState<RawHrRow[]>([]);
  const [roster, setRoster] = useState<RosterHrRow[]>([]);
  const [history, setHistory] = useState<HistoryHrRow[]>([]);
  const [quality, setQuality] = useState<QualityRow[]>([]);
  const [issues, setIssues] = useState<HrDataIssueDoc[]>([]);
  const [loading, setLoading] = useState(true);
  const [issuesLoading, setIssuesLoading] = useState(true);

  const [selected, setSelected] = useState<SearchEntry | null>(null);
  const [manual, setManual] = useState(false);

  const loadIssues = useCallback(async () => {
    setIssuesLoading(true);
    try {
      setIssues(await fetchIssues());
    } catch (error) {
      writeLog('HrDataIssues', 'error', 'Failed to load HR data issues', error);
    } finally {
      setIssuesLoading(false);
    }
  }, []);

  useEffect(() => {
    const load = async () => {
      setLoading(true);
      try {
        const [rawData, rosterData, historyData, qualityData] = await Promise.all([
          loadDataset<RawHrRow>('fte_hr_no_filter'),
          loadDataset<RosterHrRow>('consolidated_hr_fte_report_view'),
          loadDataset<HistoryHrRow>('hr_roster_history'),
          loadDataset<QualityRow>('hr_data_quality'),
        ]);
        setRaw(rawData);
        setRoster(rosterData);
        setHistory(historyData);
        setQuality(qualityData);
      } catch (error) {
        writeLog('HrDataIssues', 'error', 'Failed to load HR datasets', error);
        toast({ variant: 'destructive', title: 'Data Fetch Error', description: 'Could not load the HR datasets.' });
      } finally {
        setLoading(false);
      }
    };
    load();
    loadIssues();
  }, [toast, loadIssues]);

  const entries = useMemo(() => buildSearchEntries(raw, roster, history), [raw, roster, history]);

  const personRows = useMemo(
    () => (selected ? collectPersonRows(selected, raw, roster, history) : null),
    [selected, raw, roster, history],
  );
  const diagnosis = useMemo(
    () => (personRows ? diagnosePerson(personRows.raw, personRows.roster, personRows.history) : null),
    [personRows],
  );
  const openIssuesForPerson = useMemo(() => {
    if (!selected) return [];
    return issues.filter(doc => {
      const c = doc.content;
      if (c.status === 'resolved' || c.status === 'wont_fix') return false;
      return (selected.personId && c.person_id === selected.personId) ||
        (selected.email && c.person_email.toLowerCase() === selected.email.toLowerCase());
    });
  }, [issues, selected]);

  return (
    <div className="flex flex-col gap-6">
      <SourceFreshness quality={quality} loading={loading} />

      <Card>
        <CardHeader>
          <CardTitle className="text-lg">Find a person</CardTitle>
          <CardDescription>
            Searches every HR source feed, the roster the tool uses, and roster history, so people who were dropped can still be found.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3 sm:flex-row sm:items-center">
          {loading ? (
            <Skeleton className="h-10 w-full" />
          ) : (
            <div className="flex-1">
              <PersonSearch
                entries={entries}
                selected={manual ? null : selected}
                onSelect={entry => {
                  setManual(false);
                  setSelected(entry);
                }}
              />
            </div>
          )}
          <Button
            variant={manual ? 'default' : 'outline'}
            onClick={() => {
              setManual(true);
              setSelected(null);
            }}
          >
            Not found anywhere
          </Button>
        </CardContent>
      </Card>

      {!manual && selected && diagnosis && personRows && (
        <>
          <PersonPanel diagnosis={diagnosis} roster={personRows.roster} history={personRows.history} openIssues={openIssuesForPerson} />
          {!userLoading && (
            <LogIssueForm
              diagnosis={diagnosis}
              person={selected}
              rows={personRows}
              currentUser={currentUser}
              onSaved={loadIssues}
            />
          )}
        </>
      )}

      {manual && !userLoading && (
        <LogIssueForm
          manual
          diagnosis={null}
          person={{ personId: '', name: '', email: '' }}
          rows={{ raw: [], roster: [], history: [] }}
          currentUser={currentUser}
          onSaved={loadIssues}
        />
      )}

      <IssuesTable issues={issues} loading={issuesLoading} currentUser={currentUser} isAdmin={isAdmin} onChanged={loadIssues} />
    </div>
  );
}

function SourceFreshness({ quality, loading }: { quality: QualityRow[]; loading: boolean }) {
  if (loading) return <Skeleton className="h-14 w-full" />;
  if (quality.length === 0) return null;
  const today = Date.now();
  return (
    <div className="flex flex-wrap gap-3 text-sm">
      {quality.map(q => {
        const date = toIsoDate(q.last_update_date);
        const ageDays = date ? Math.floor((today - Date.parse(date)) / 86_400_000) : null;
        const stale = ageDays === null || ageDays > STALE_AFTER_DAYS;
        const label = HR_SOURCE_LABELS[q.table as HrSource] || q.table;
        return (
          <div key={q.table} className={cn('rounded-md border px-3 py-2', stale && 'border-amber-400 bg-amber-50 dark:bg-amber-950/30')}>
            <div className="font-medium">{label}</div>
            <div className="text-xs text-muted-foreground">
              Source updated {date || 'unknown'}{ageDays !== null ? ` (${ageDays}d ago)` : ''}
            </div>
          </div>
        );
      })}
    </div>
  );
}
