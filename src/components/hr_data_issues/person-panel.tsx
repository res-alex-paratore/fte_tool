'use client';

import { CheckCircle2, CircleSlash, HelpCircle, XCircle, AlertTriangle, Info } from 'lucide-react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { cn } from '@/lib/utils';
import {
  DIAGNOSIS_LABELS,
  HR_SOURCE_LABELS,
  STAGE_LABELS,
  toIsoDate,
  type Diagnosis,
  type HistoryHrRow,
  type RosterHrRow,
} from '@/lib/hr-issues';
import { ISSUE_STATUS_LABELS, type HrDataIssueDoc } from './issues-api';

type PersonPanelProps = {
  diagnosis: Diagnosis;
  roster: RosterHrRow[];
  history: HistoryHrRow[];
  openIssues: HrDataIssueDoc[];
};

const COMPARE_FIELDS: { key: keyof RosterHrRow; label: string; date?: boolean }[] = [
  { key: 'person_id', label: 'Employee ID' },
  { key: 'full_name', label: 'Name' },
  { key: 'person_email', label: 'Email' },
  { key: 'status', label: 'Status' },
  { key: 'department', label: 'Department' },
  { key: 'department_detail', label: 'Department detail' },
  { key: 'title', label: 'Title' },
  { key: 'manager', label: 'Manager' },
  { key: 'manager_email', label: 'Manager email' },
  { key: 'start_date', label: 'Start date', date: true },
  { key: 'end_date', label: 'End date', date: true },
  { key: 'country', label: 'Country' },
  { key: 'region', label: 'Region' },
  { key: 'fte', label: 'FTE' },
  { key: 'missing_flag', label: 'Manager flag' },
];

function show(row: RosterHrRow | undefined, key: keyof RosterHrRow, date?: boolean): string {
  if (!row) return '';
  const value = row[key];
  if (value === null || value === undefined) return '';
  return date ? toIsoDate(value) || String(value) : String(value);
}

const STEP_ICONS = {
  pass: <CheckCircle2 className="h-4 w-4 text-green-600" />,
  fail: <XCircle className="h-4 w-4 text-destructive" />,
  unknown: <HelpCircle className="h-4 w-4 text-amber-500" />,
  skipped: <CircleSlash className="h-4 w-4 text-muted-foreground" />,
};

export function PersonPanel({ diagnosis, roster, history, openIssues }: PersonPanelProps) {
  const rawRows = diagnosis.evaluations;
  const rosterRow = roster[0];
  const columns: { title: string; row: RosterHrRow | undefined; note?: string }[] = [
    ...rawRows.map((e, i) => ({
      title: `Source${rawRows.length > 1 ? ` ${i + 1}` : ''}${e.source ? ` · ${HR_SOURCE_LABELS[e.source]}` : ''}`,
      row: e.row as RosterHrRow,
      note: [
        e.sourceFilter.result === 'fail' ? 'Excluded by filter' : null,
        !e.hasId ? 'No ID' : null,
        rawRows.length > 1 && e.rankWinner ? 'Ranked first' : null,
        rawRows.length > 1 && !e.rankWinner && e.hasId && e.sourceFilter.result !== 'fail' ? 'Lost ranking' : null,
      ].filter(Boolean).join(' · '),
    })),
    { title: 'Roster (what the tool uses)', row: rosterRow },
  ];
  const sortedHistory = [...history].sort((a, b) => toIsoDate(b.valid_from).localeCompare(toIsoDate(a.valid_from)));

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-center gap-2">
          <CardTitle className="text-lg">What the HR data shows</CardTitle>
          <Badge variant={diagnosis.stage === 'in_roster' ? 'secondary' : 'destructive'}>{STAGE_LABELS[diagnosis.stage]}</Badge>
          {diagnosis.hrSource && <Badge variant="outline">{HR_SOURCE_LABELS[diagnosis.hrSource]}</Badge>}
        </div>
        <CardDescription>{diagnosis.summary}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        <ol className="flex flex-wrap items-center gap-x-4 gap-y-2 text-sm">
          {diagnosis.steps.map(step => (
            <li key={step.label} className={cn('flex items-center gap-1.5', step.state === 'skipped' && 'text-muted-foreground')}>
              {STEP_ICONS[step.state]}
              {step.label}
            </li>
          ))}
        </ol>

        <div className="rounded-md border bg-muted/40 p-3 text-sm">
          <div className="font-medium">{DIAGNOSIS_LABELS[diagnosis.code]}</div>
          <p className="text-muted-foreground">{diagnosis.detail}</p>
        </div>

        {diagnosis.findings.length > 0 && (
          <ul className="space-y-1 text-sm">
            {diagnosis.findings.map((f, i) => (
              <li key={i} className="flex items-start gap-2">
                {f.severity === 'warning'
                  ? <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-500" />
                  : <Info className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />}
                <span>{f.message}</span>
              </li>
            ))}
          </ul>
        )}

        {openIssues.length > 0 && (
          <div className="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm dark:bg-amber-950/30">
            <div className="font-medium">Already logged for this person</div>
            <ul className="mt-1 list-disc pl-5">
              {openIssues.map(doc => (
                <li key={doc.id}>
                  {doc.content.created_date}: {doc.content.description || doc.content.issue_type} ({ISSUE_STATUS_LABELS[doc.content.status] || doc.content.status}, {doc.content.assigned_team})
                </li>
              ))}
            </ul>
          </div>
        )}

        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-40">Field</TableHead>
                {columns.map(c => (
                  <TableHead key={c.title}>
                    <div>{c.title}</div>
                    {c.note && <div className="text-xs font-normal text-muted-foreground">{c.note}</div>}
                  </TableHead>
                ))}
              </TableRow>
            </TableHeader>
            <TableBody>
              {COMPARE_FIELDS.map(field => {
                const rosterValue = show(rosterRow, field.key, field.date);
                return (
                  <TableRow key={field.key}>
                    <TableCell className="font-medium">{field.label}</TableCell>
                    {columns.map((c, i) => {
                      const value = show(c.row, field.key, field.date);
                      const isRoster = i === columns.length - 1;
                      const differs = !isRoster && rosterRow && value.toLowerCase() !== rosterValue.toLowerCase();
                      return (
                        <TableCell key={c.title} className={cn(differs && 'bg-amber-100 dark:bg-amber-900/40', !c.row && 'text-muted-foreground')}>
                          {c.row ? value || '—' : isRoster ? 'Not in roster' : ''}
                        </TableCell>
                      );
                    })}
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
          {rawRows.length === 0 && (
            <p className="mt-2 text-sm text-muted-foreground">No rows for this person in any HR source feed (fte_hr_no_filter).</p>
          )}
        </div>

        {sortedHistory.length > 0 && (
          <div>
            <div className="mb-2 text-sm font-medium">Roster history</div>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>From</TableHead>
                  <TableHead>To</TableHead>
                  <TableHead>Change</TableHead>
                  <TableHead>Department</TableHead>
                  <TableHead>Manager</TableHead>
                  <TableHead>Status</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {sortedHistory.map((h, i) => (
                  <TableRow key={i}>
                    <TableCell>{toIsoDate(h.valid_from)}</TableCell>
                    <TableCell>{toIsoDate(h.valid_to) || 'current'}</TableCell>
                    <TableCell>
                      {h.change_type}
                      {h.changed_fields ? `: ${String(h.changed_fields).split(',').join(', ')}` : ''}
                      {h.drop_reason ? ` (${h.drop_reason})` : ''}
                    </TableCell>
                    <TableCell>{h.department}</TableCell>
                    <TableCell>{h.manager}</TableCell>
                    <TableCell>{h.cleaned_status || h.status}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
