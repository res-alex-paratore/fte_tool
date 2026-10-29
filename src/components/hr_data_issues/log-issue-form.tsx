'use client';

import { useEffect, useMemo, useState } from 'react';
import { v4 as uuidv4 } from 'uuid';
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useToast } from '@/hooks/use-toast';
import { writeLog } from '@/lib/logger';
import type { CurrentUser } from '@/hooks/use-current-user';
import {
  HR_SOURCE_LABELS,
  ISSUE_TYPE_FIELD,
  ISSUE_TYPE_LABELS,
  routeIssue,
  suggestIssueType,
  type Diagnosis,
  type HistoryHrRow,
  type HrSource,
  type IssueType,
  type RawHrRow,
  type RosterHrRow,
} from '@/lib/hr-issues';
import { createIssue, type HrDataIssue } from './issues-api';

type LogIssueFormProps = {
  /** Null for a person who could not be found anywhere. */
  diagnosis: Diagnosis | null;
  person: { personId: string; name: string; email: string };
  rows: { raw: RawHrRow[]; roster: RosterHrRow[]; history: HistoryHrRow[] };
  currentUser: CurrentUser;
  onSaved: () => void;
  /** Manual entry: let the user type name/email and pick the HR system. */
  manual?: boolean;
};

export function LogIssueForm({ diagnosis, person, rows, currentUser, onSaved, manual }: LogIssueFormProps) {
  const { toast } = useToast();
  const rosterRow = rows.roster[0];

  const [name, setName] = useState(person.name);
  const [email, setEmail] = useState(person.email);
  const [manualSource, setManualSource] = useState<HrSource | ''>('');
  const [issueType, setIssueType] = useState<IssueType>(diagnosis ? suggestIssueType(diagnosis) : 'missing_person');
  const [currentValue, setCurrentValue] = useState('');
  const [expectedValue, setExpectedValue] = useState('');
  const [effectiveDate, setEffectiveDate] = useState('');
  const [description, setDescription] = useState('');
  const [onBehalfOf, setOnBehalfOf] = useState('');
  const [relatedTicket, setRelatedTicket] = useState('');
  const [submitting, setSubmitting] = useState(false);

  // Reset when a different person is picked.
  useEffect(() => {
    setName(person.name);
    setEmail(person.email);
    setIssueType(diagnosis ? suggestIssueType(diagnosis) : 'missing_person');
    setExpectedValue('');
    setEffectiveDate('');
    setDescription('');
  }, [person.personId, person.name, person.email, diagnosis]);

  // Prefill "current value" from the roster for the field this issue type is about.
  useEffect(() => {
    const field = ISSUE_TYPE_FIELD[issueType];
    setCurrentValue(field && rosterRow ? String(rosterRow[field] ?? '') : '');
  }, [issueType, rosterRow]);

  const hrSource: HrSource | null = manual ? (manualSource || null) : diagnosis?.hrSource ?? null;
  const diagnosisCode = diagnosis?.code ?? 'never_seen';
  const team = useMemo(
    () => routeIssue(issueType, diagnosisCode, hrSource, diagnosis?.sourceSaysInactive),
    [issueType, diagnosisCode, hrSource, diagnosis?.sourceSaysInactive],
  );

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim() && !email.trim()) {
      toast({ variant: 'destructive', title: 'Missing person', description: 'Enter a name or email.' });
      return;
    }
    if (!description.trim()) {
      toast({ variant: 'destructive', title: 'Missing description', description: 'Describe what is wrong.' });
      return;
    }

    const primary = diagnosis?.primaryRaw;
    const content: HrDataIssue = {
      issue_id: uuidv4(),
      created_date: new Date().toISOString().slice(0, 10),
      reported_by: currentUser.name,
      reported_by_email: currentUser.email || '',
      raised_on_behalf_of: onBehalfOf.trim(),
      person_id: person.personId,
      person_name: name.trim(),
      person_email: email.trim(),
      hr_source: hrSource || '',
      region: String(rosterRow?.region || primary?.region || ''),
      manager: String(rosterRow?.manager || primary?.manager || ''),
      issue_type: issueType,
      field: ISSUE_TYPE_FIELD[issueType] || '',
      current_value: currentValue.trim(),
      expected_value: expectedValue.trim(),
      effective_date: effectiveDate,
      description: description.trim(),
      stage: diagnosis?.stage ?? 'not_in_source',
      diagnosis: diagnosisCode,
      diagnosis_detail: diagnosis ? `${diagnosis.summary} ${diagnosis.detail}` : 'Not found in any HR dataset.',
      assigned_team: team,
      status: 'new',
      related_ticket: relatedTicket.trim(),
      updates: '[]',
      resolution: '',
      resolved_date: '',
      source_snapshot: JSON.stringify({ raw: rows.raw, roster: rows.roster, history: rows.history.slice(-5) }),
    };

    setSubmitting(true);
    try {
      await createIssue(content);
      toast({ title: 'Issue logged', description: `Assigned to ${team}.` });
      setDescription('');
      setExpectedValue('');
      setEffectiveDate('');
      setRelatedTicket('');
      setOnBehalfOf('');
      onSaved();
    } catch (error) {
      writeLog('HrDataIssues', 'error', 'Failed to save HR data issue', error);
      toast({ variant: 'destructive', title: 'Save failed', description: 'The issue could not be saved. Please try again.' });
    } finally {
      setSubmitting(false);
    }
  };

  const showValueFields = issueType !== 'missing_person' && issueType !== 'should_not_appear';

  return (
    <Card>
      <form onSubmit={handleSubmit}>
        <CardHeader>
          <CardTitle className="text-lg">Log an issue</CardTitle>
          <CardDescription>
            This will be assigned to <span className="font-medium text-foreground">{team}</span>. An admin reviews every new issue.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4 md:grid-cols-2">
          {manual && (
            <>
              <div className="grid gap-2">
                <Label htmlFor="issue-name">Name</Label>
                <Input id="issue-name" value={name} onChange={e => setName(e.target.value)} />
              </div>
              <div className="grid gap-2">
                <Label htmlFor="issue-email">Email</Label>
                <Input id="issue-email" type="email" value={email} onChange={e => setEmail(e.target.value)} />
              </div>
              <div className="grid gap-2">
                <Label>HR system</Label>
                <Select value={manualSource} onValueChange={v => setManualSource(v as HrSource)}>
                  <SelectTrigger><SelectValue placeholder="Which HR system should they be in?" /></SelectTrigger>
                  <SelectContent>
                    {(Object.keys(HR_SOURCE_LABELS) as HrSource[]).map(s => (
                      <SelectItem key={s} value={s}>{HR_SOURCE_LABELS[s]}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </>
          )}
          <div className="grid gap-2">
            <Label>Issue type</Label>
            <Select value={issueType} onValueChange={v => setIssueType(v as IssueType)}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                {(Object.keys(ISSUE_TYPE_LABELS) as IssueType[]).map(t => (
                  <SelectItem key={t} value={t}>{ISSUE_TYPE_LABELS[t]}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          {showValueFields && (
            <>
              <div className="grid gap-2">
                <Label htmlFor="issue-current">Currently shows</Label>
                <Input id="issue-current" value={currentValue} onChange={e => setCurrentValue(e.target.value)} />
              </div>
              <div className="grid gap-2">
                <Label htmlFor="issue-expected">Should be</Label>
                <Input id="issue-expected" value={expectedValue} onChange={e => setExpectedValue(e.target.value)} />
              </div>
              <div className="grid gap-2">
                <Label htmlFor="issue-effective">Since when (if a change)</Label>
                <Input id="issue-effective" type="date" value={effectiveDate} onChange={e => setEffectiveDate(e.target.value)} />
              </div>
            </>
          )}
          <div className="grid gap-2">
            <Label htmlFor="issue-behalf">Raised on behalf of (optional)</Label>
            <Input id="issue-behalf" value={onBehalfOf} onChange={e => setOnBehalfOf(e.target.value)} placeholder="e.g. the manager who reported it" />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="issue-ticket">Freshservice ticket (optional)</Label>
            <Input id="issue-ticket" value={relatedTicket} onChange={e => setRelatedTicket(e.target.value)} placeholder="Ticket number or link" />
          </div>
          <div className="grid gap-2 md:col-span-2">
            <Label htmlFor="issue-description">What is wrong?</Label>
            <Textarea id="issue-description" rows={3} value={description} onChange={e => setDescription(e.target.value)} placeholder="e.g. Active in Dayforce but not in my team view since 25 Sep." />
          </div>
        </CardContent>
        <CardFooter>
          <Button type="submit" disabled={submitting}>{submitting ? 'Saving...' : 'Log issue'}</Button>
        </CardFooter>
      </form>
    </Card>
  );
}
