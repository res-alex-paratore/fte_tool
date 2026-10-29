'use client';

import { useMemo, useState } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Skeleton } from '@/components/ui/skeleton';
import { useToast } from '@/hooks/use-toast';
import { writeLog } from '@/lib/logger';
import type { CurrentUser } from '@/hooks/use-current-user';
import { ALL_TEAMS, DIAGNOSIS_LABELS, HR_SOURCE_LABELS, ISSUE_TYPE_LABELS, type HrSource } from '@/lib/hr-issues';
import { ISSUE_STATUS_LABELS, parseUpdates, updateIssue, type HrDataIssueDoc, type IssueStatus } from './issues-api';

type IssuesTableProps = {
  issues: HrDataIssueDoc[];
  loading: boolean;
  currentUser: CurrentUser;
  isAdmin: boolean;
  onChanged: () => void;
};

const ALL = '__all__';
const OPEN_STATUSES: IssueStatus[] = ['new', 'in_review', 'with_team'];

function statusVariant(status: IssueStatus): 'default' | 'secondary' | 'destructive' | 'outline' {
  if (status === 'new') return 'destructive';
  if (status === 'resolved' || status === 'wont_fix') return 'outline';
  return 'secondary';
}

export function IssuesTable({ issues, loading, currentUser, isAdmin, onChanged }: IssuesTableProps) {
  const [statusFilter, setStatusFilter] = useState<string>('open');
  const [teamFilter, setTeamFilter] = useState<string>(ALL);
  const [mineOnly, setMineOnly] = useState(false);
  const [editing, setEditing] = useState<HrDataIssueDoc | null>(null);

  const filtered = useMemo(() => {
    return issues
      .filter(doc => {
        const c = doc.content;
        if (statusFilter === 'open' && !OPEN_STATUSES.includes(c.status)) return false;
        if (statusFilter !== 'open' && statusFilter !== ALL && c.status !== statusFilter) return false;
        if (teamFilter !== ALL && c.assigned_team !== teamFilter) return false;
        if (mineOnly && c.reported_by !== currentUser.name) return false;
        return true;
      })
      .sort((a, b) => (b.content.created_date || '').localeCompare(a.content.created_date || ''));
  }, [issues, statusFilter, teamFilter, mineOnly, currentUser.name]);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-lg">Logged issues</CardTitle>
        <CardDescription>
          {isAdmin ? 'Click an issue to update its status, team or notes.' : 'Issues raised about HR data, and where each one is.'}
        </CardDescription>
        <div className="flex flex-wrap items-end gap-3 pt-2">
          <div className="grid gap-1">
            <Label className="text-xs">Status</Label>
            <Select value={statusFilter} onValueChange={setStatusFilter}>
              <SelectTrigger className="w-40"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="open">Open</SelectItem>
                <SelectItem value={ALL}>All</SelectItem>
                {(Object.keys(ISSUE_STATUS_LABELS) as IssueStatus[]).map(s => (
                  <SelectItem key={s} value={s}>{ISSUE_STATUS_LABELS[s]}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="grid gap-1">
            <Label className="text-xs">Team</Label>
            <Select value={teamFilter} onValueChange={setTeamFilter}>
              <SelectTrigger className="w-56"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL}>All teams</SelectItem>
                {ALL_TEAMS.map(t => <SelectItem key={t} value={t}>{t}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          <Button variant={mineOnly ? 'default' : 'outline'} size="sm" onClick={() => setMineOnly(v => !v)}>
            Raised by me
          </Button>
        </div>
      </CardHeader>
      <CardContent>
        {loading ? (
          <Skeleton className="h-32 w-full" />
        ) : filtered.length === 0 ? (
          <p className="py-6 text-center text-sm text-muted-foreground">No issues match these filters.</p>
        ) : (
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Raised</TableHead>
                  <TableHead>Person</TableHead>
                  <TableHead>Issue</TableHead>
                  <TableHead>Diagnosis</TableHead>
                  <TableHead>Team</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Ticket</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filtered.map(doc => {
                  const c = doc.content;
                  return (
                    <TableRow
                      key={doc.id}
                      className={isAdmin ? 'cursor-pointer' : undefined}
                      onClick={isAdmin ? () => setEditing(doc) : undefined}
                    >
                      <TableCell className="whitespace-nowrap">
                        <div>{c.created_date}</div>
                        <div className="text-xs text-muted-foreground">{c.reported_by}{c.raised_on_behalf_of ? ` for ${c.raised_on_behalf_of}` : ''}</div>
                      </TableCell>
                      <TableCell>
                        <div className="font-medium">{c.person_name || c.person_email}</div>
                        <div className="text-xs text-muted-foreground">
                          {[c.person_id, HR_SOURCE_LABELS[c.hr_source as HrSource]].filter(Boolean).join(' · ')}
                        </div>
                      </TableCell>
                      <TableCell className="max-w-xs">
                        <div className="font-medium">{ISSUE_TYPE_LABELS[c.issue_type] || c.issue_type}</div>
                        <div className="line-clamp-2 text-xs text-muted-foreground">
                          {c.expected_value ? `${c.current_value || '—'} → ${c.expected_value}. ` : ''}{c.description}
                        </div>
                      </TableCell>
                      <TableCell className="text-sm">{c.diagnosis ? DIAGNOSIS_LABELS[c.diagnosis] || c.diagnosis : ''}</TableCell>
                      <TableCell className="text-sm">{c.assigned_team}</TableCell>
                      <TableCell><Badge variant={statusVariant(c.status)}>{ISSUE_STATUS_LABELS[c.status] || c.status}</Badge></TableCell>
                      <TableCell className="text-sm">
                        {c.related_ticket && /^https?:\/\//.test(c.related_ticket)
                          ? <a href={c.related_ticket} target="_blank" rel="noreferrer" className="underline" onClick={e => e.stopPropagation()}>Open</a>
                          : c.related_ticket}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
        )}
      </CardContent>
      {editing && (
        <TriageDialog
          doc={editing}
          currentUser={currentUser}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            onChanged();
          }}
        />
      )}
    </Card>
  );
}

function TriageDialog({ doc, currentUser, onClose, onSaved }: { doc: HrDataIssueDoc; currentUser: CurrentUser; onClose: () => void; onSaved: () => void }) {
  const { toast } = useToast();
  const c = doc.content;
  const [status, setStatus] = useState<IssueStatus>(c.status);
  const [team, setTeam] = useState(c.assigned_team);
  const [ticket, setTicket] = useState(c.related_ticket);
  const [resolution, setResolution] = useState(c.resolution);
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);
  const updates = parseUpdates(c);
  const teams = ALL_TEAMS.includes(c.assigned_team) ? ALL_TEAMS : [...ALL_TEAMS, c.assigned_team];

  const handleSave = async () => {
    const today = new Date().toISOString().slice(0, 10);
    const nextUpdates = note.trim() ? [...updates, { date: today, by: currentUser.name, note: note.trim() }] : updates;
    const closed = status === 'resolved' || status === 'wont_fix';
    setSaving(true);
    try {
      await updateIssue(doc.id, {
        ...c,
        status,
        assigned_team: team,
        related_ticket: ticket.trim(),
        resolution: resolution.trim(),
        updates: JSON.stringify(nextUpdates),
        resolved_date: closed ? c.resolved_date || today : '',
      });
      toast({ title: 'Issue updated' });
      onSaved();
    } catch (error) {
      writeLog('HrDataIssues', 'error', 'Failed to update HR data issue', error);
      toast({ variant: 'destructive', title: 'Update failed', description: 'The issue could not be updated.' });
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open onOpenChange={open => !open && onClose()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{c.person_name || c.person_email}: {ISSUE_TYPE_LABELS[c.issue_type] || c.issue_type}</DialogTitle>
          <DialogDescription>Raised {c.created_date} by {c.reported_by}{c.raised_on_behalf_of ? ` for ${c.raised_on_behalf_of}` : ''}.</DialogDescription>
        </DialogHeader>
        <div className="space-y-4 text-sm">
          <p>{c.description}</p>
          {(c.current_value || c.expected_value) && (
            <p>
              <span className="text-muted-foreground">Shows</span> {c.current_value || '—'} <span className="text-muted-foreground">should be</span> {c.expected_value || '—'}
              {c.effective_date ? <span className="text-muted-foreground"> since {c.effective_date}</span> : null}
            </p>
          )}
          <div className="rounded-md border bg-muted/40 p-3">
            <div className="font-medium">{c.diagnosis ? DIAGNOSIS_LABELS[c.diagnosis] || c.diagnosis : 'No diagnosis'}</div>
            <p className="text-muted-foreground">{c.diagnosis_detail}</p>
          </div>
          <div className="grid gap-4 md:grid-cols-2">
            <div className="grid gap-2">
              <Label>Status</Label>
              <Select value={status} onValueChange={v => setStatus(v as IssueStatus)}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {(Object.keys(ISSUE_STATUS_LABELS) as IssueStatus[]).map(s => (
                    <SelectItem key={s} value={s}>{ISSUE_STATUS_LABELS[s]}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="grid gap-2">
              <Label>Assigned team</Label>
              <Select value={team} onValueChange={setTeam}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {teams.map(t => <SelectItem key={t} value={t}>{t}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div className="grid gap-2 md:col-span-2">
              <Label htmlFor="triage-ticket">Freshservice ticket</Label>
              <Input id="triage-ticket" value={ticket} onChange={e => setTicket(e.target.value)} />
            </div>
          </div>
          {updates.length > 0 && (
            <div>
              <div className="mb-1 font-medium">Updates</div>
              <ul className="space-y-1">
                {[...updates].reverse().map((u, i) => (
                  <li key={i}><span className="text-muted-foreground">{u.date} · {u.by}:</span> {u.note}</li>
                ))}
              </ul>
            </div>
          )}
          <div className="grid gap-2">
            <Label htmlFor="triage-note">Add an update</Label>
            <Textarea id="triage-note" rows={2} value={note} onChange={e => setNote(e.target.value)} placeholder="e.g. Raised with HR, awaiting next report drop." />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="triage-resolution">Resolution</Label>
            <Textarea id="triage-resolution" rows={2} value={resolution} onChange={e => setResolution(e.target.value)} />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button onClick={handleSave} disabled={saving}>{saving ? 'Saving...' : 'Save'}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
