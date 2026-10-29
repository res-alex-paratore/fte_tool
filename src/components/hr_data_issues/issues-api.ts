'use client';

import type { IssueType, Stage, DiagnosisCode } from '@/lib/hr-issues';

export const ISSUES_COLLECTION = '/domo/datastores/v1/collections/hr_data_issues/documents/';

export type IssueStatus = 'new' | 'in_review' | 'with_team' | 'resolved' | 'wont_fix';

export const ISSUE_STATUS_LABELS: Record<IssueStatus, string> = {
  new: 'New',
  in_review: 'In review',
  with_team: 'With team',
  resolved: 'Resolved',
  wont_fix: "Won't fix",
};

export type IssueUpdate = { date: string; by: string; note: string };

/** Content of one `hr_data_issues` document. Every field must also be in the manifest schema. */
export type HrDataIssue = {
  issue_id: string;
  created_date: string;
  reported_by: string;
  reported_by_email: string;
  raised_on_behalf_of: string;
  person_id: string;
  person_name: string;
  person_email: string;
  hr_source: string;
  region: string;
  manager: string;
  issue_type: IssueType;
  field: string;
  current_value: string;
  expected_value: string;
  effective_date: string;
  description: string;
  stage: Stage | '';
  diagnosis: DiagnosisCode | '';
  diagnosis_detail: string;
  assigned_team: string;
  status: IssueStatus;
  related_ticket: string;
  /** JSON array of IssueUpdate. */
  updates: string;
  resolution: string;
  resolved_date: string;
  /** JSON of the person's raw, roster and history rows when the issue was logged. */
  source_snapshot: string;
};

export type HrDataIssueDoc = { id: string; content: HrDataIssue };

export function parseUpdates(issue: HrDataIssue): IssueUpdate[] {
  try {
    const parsed = JSON.parse(issue.updates || '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export async function fetchIssues(): Promise<HrDataIssueDoc[]> {
  const response = await fetch(ISSUES_COLLECTION);
  if (!response.ok) throw new Error(`Failed to load issues (${response.status})`);
  const docs = await response.json();
  return Array.isArray(docs) ? docs : [];
}

export async function createIssue(content: HrDataIssue): Promise<void> {
  const response = await fetch(ISSUES_COLLECTION, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content }),
  });
  if (!response.ok) throw new Error(`Failed to save issue (${response.status})`);
}

export async function updateIssue(id: string, content: HrDataIssue): Promise<void> {
  const response = await fetch(`${ISSUES_COLLECTION}${id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content }),
  });
  if (!response.ok) throw new Error(`Failed to update issue (${response.status})`);
}
