/**
 * Diagnosis and routing for the HR Data Issues page.
 *
 * `diagnosePerson` replays the `consolidated_hr_fte_report` Magic ETL for one person, in tile
 * order, and reports the first stage that removes them. See docs/hr_data_issues.md for the
 * tile-by-tile mapping. Keep the constants below in step with the ETL when its filters change.
 *
 * This file has no runtime imports so it can be checked with plain `node`.
 */

// ---------------------------------------------------------------------------------------------
// Row shapes
// ---------------------------------------------------------------------------------------------

/** One row of `fte_hr_no_filter`: a source record after per-source renames, before any filter. */
export type RawHrRow = {
  person_id?: string | null;
  full_name?: string | null;
  status?: string | null;
  employment_type?: string | null;
  opco?: string | null;
  department?: string | null;
  title?: string | null;
  manager_id?: string | null;
  manager?: string | null;
  manager_email?: string | null;
  person_email?: string | null;
  start_date?: string | null;
  end_date?: string | null;
  country?: string | null;
  region?: string | null;
  fte?: string | number | null;
  missing_flag?: string | number | null;
  cost_center_code?: string | null;
  /** Added by the ETL change in docs/domo_hr_history/; inferred until it lands. */
  hr_source?: string | null;
  /** Dayforce `Area`; needed for the Dayforce source filter. */
  source_area?: string | null;
  /** Workday `hr_cc_reporting_hierarchy_l4`; needed for the Workday source filter. */
  source_l4?: string | null;
};

/** One row of `consolidated_hr_fte_report_view`. */
export type RosterHrRow = RawHrRow & {
  cleaned_status?: string | null;
  department_detail?: string | null;
};

/** One row of `hr_roster_history`. */
export type HistoryHrRow = RosterHrRow & {
  person_key?: string | null;
  valid_from?: string | null;
  valid_to?: string | null;
  is_current?: string | number | null;
  present_flag?: string | number | null;
  change_type?: string | null;
  changed_fields?: string | null;
  drop_reason?: string | null;
  first_seen?: string | null;
};

// ---------------------------------------------------------------------------------------------
// Sources and teams
// ---------------------------------------------------------------------------------------------

export type HrSource = 'workday_ind' | 'dayforce_emea_can' | 'hris_nam' | 'peoplesoft_nam' | 'mexico';

export const HR_SOURCE_LABELS: Record<HrSource, string> = {
  workday_ind: 'Workday India',
  dayforce_emea_can: 'Dayforce EMEA/CAN',
  hris_nam: 'NAM HRIS',
  peoplesoft_nam: 'NAM PeopleSoft',
  mexico: 'Mexico feed',
};

export const EDAO_TEAM = 'EDAO (FTE tool / ETL)';

export const HR_TEAMS: Record<HrSource, string> = {
  workday_ind: 'HR – Workday India',
  dayforce_emea_can: 'HR – Dayforce EMEA/CAN',
  hris_nam: 'HR – NAM HRIS',
  peoplesoft_nam: 'HR – NAM PeopleSoft',
  mexico: 'HR – Mexico feed',
};

export const ALL_TEAMS: string[] = [...Object.values(HR_TEAMS), EDAO_TEAM];

const HR_SOURCES = Object.keys(HR_SOURCE_LABELS) as HrSource[];

/**
 * The source a row came from. Uses `hr_source` when the ETL provides it; otherwise infers it
 * from what each branch hardcodes (region, PeopleSoft's `employment_type = 'talent'`, Mexico's
 * `mex` ids).
 */
export function getHrSource(row: RawHrRow | null | undefined): { source: HrSource | null; inferred: boolean } {
  if (!row) return { source: null, inferred: true };
  const explicit = text(row.hr_source).toLowerCase();
  if ((HR_SOURCES as string[]).includes(explicit)) return { source: explicit as HrSource, inferred: false };

  const region = text(row.region).toUpperCase();
  if (text(row.person_id).toLowerCase().startsWith('mex')) return { source: 'mexico', inferred: true };
  if (region === 'APAC') return { source: 'workday_ind', inferred: true };
  if (region === 'EMEA') return { source: 'dayforce_emea_can', inferred: true };
  if (region === 'NAM') {
    return { source: text(row.employment_type).toLowerCase() === 'talent' ? 'peoplesoft_nam' : 'hris_nam', inferred: true };
  }
  return { source: null, inferred: true };
}

// ---------------------------------------------------------------------------------------------
// ETL constants (copied from the dataflow)
// ---------------------------------------------------------------------------------------------

/** `Filter Rows 1` on `peoplesoft_nam_hr_data`: `DESCR IN (...)`. DESCR arrives as `department`. */
const PEOPLESOFT_DEPARTMENTS = ['RPO MSP Admin Talent', 'RPO Sourcing Delivery', 'RPO Admin Delivery'];

/** `Filter Rows 2` on `NAM HRIS Levels GCP`: `dept_descr IN (...)`. dept_descr arrives as `department`. */
const HRIS_DEPARTMENTS = [
  'RSRS GBS NAM Mgmt',
  'RPO GBS RPO Admin Mgmt',
  'RSRS GBS Fld',
  'RPO GBS Sourcing Mgmt',
  'RPO Sourcing Delivery',
  'MSP Admin Delivery',
];

/** `Filter Rows 5` on `workday_ind_hr_data`. l3 arrives as `opco`, l5 as `department`. */
const WORKDAY_L3 = ['Randstad Enterprise - GBS', 'RE Global Business Services'];
const WORKDAY_EXCLUDED_L4 = 'Business Service-Global BPO';
const WORKDAY_EXCLUDED_L5 = 'Coaching & Outplacement- core ser';

/** `filter end dates before 6_28`. */
export const END_DATE_CUTOFF = '2026-06-28';

// ---------------------------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------------------------

function text(value: unknown): string {
  return value === null || value === undefined ? '' : String(value).trim();
}

function isBlank(value: unknown): boolean {
  return text(value) === '';
}

/** Normalises a date-ish value to `YYYY-MM-DD`, or '' when it can't be read. */
export function toIsoDate(value: unknown): string {
  const raw = text(value);
  if (!raw) return '';
  if (/^\d{4}-\d{2}-\d{2}/.test(raw)) return raw.slice(0, 10);
  if (/^\d+$/.test(raw)) {
    const epoch = Number(raw);
    const date = new Date(raw.length <= 10 ? epoch * 1000 : epoch);
    return Number.isNaN(date.getTime()) ? '' : date.toISOString().slice(0, 10);
  }
  const parsed = Date.parse(raw);
  return Number.isNaN(parsed) ? '' : new Date(parsed).toISOString().slice(0, 10);
}

/** The CASE in `cleaned status and department` that builds `cleaned_status`. */
export function cleanStatus(status: unknown): string {
  const raw = text(status);
  const lower = raw.toLowerCase();
  if (lower.includes('inactive') || lower.includes('term') || lower.includes('closed') || lower === 't') return 'inactive';
  if (lower === 'a' || lower === 'active') return 'active';
  return raw;
}

/** The Mexico-aware key `hr_roster_history` uses. Mexico ids are row numbers, so it keys on email. */
export function getPersonKey(row: RawHrRow | null | undefined): string {
  const id = text(row?.person_id);
  if (id.toLowerCase().startsWith('mex')) return `mex:${text(row?.person_email).toLowerCase()}`;
  return id;
}

function sqlIn(value: unknown, list: string[]): boolean {
  return !isBlank(value) && list.includes(text(value));
}

/** SQL `<>`: NULL on either side is not true, so the row is filtered out. */
function sqlNotEqual(value: unknown, other: string): boolean {
  return !isBlank(value) && text(value) !== other;
}

// ---------------------------------------------------------------------------------------------
// Per-row checks
// ---------------------------------------------------------------------------------------------

export type CheckResult = { result: 'pass' | 'fail' | 'unknown'; detail: string };

/** Replays the per-source filter tile for one raw row. */
export function checkSourceFilter(row: RawHrRow): CheckResult {
  const { source } = getHrSource(row);
  switch (source) {
    case 'peoplesoft_nam':
      return sqlIn(row.department, PEOPLESOFT_DEPARTMENTS)
        ? { result: 'pass', detail: `PeopleSoft DESCR "${text(row.department)}" is in the GBS list.` }
        : { result: 'fail', detail: `PeopleSoft DESCR "${text(row.department) || '(blank)'}" is not one of: ${PEOPLESOFT_DEPARTMENTS.join(', ')}.` };
    case 'hris_nam':
      return sqlIn(row.department, HRIS_DEPARTMENTS)
        ? { result: 'pass', detail: `NAM HRIS dept_descr "${text(row.department)}" is in the GBS list.` }
        : { result: 'fail', detail: `NAM HRIS dept_descr "${text(row.department) || '(blank)'}" is not one of: ${HRIS_DEPARTMENTS.join(', ')}.` };
    case 'dayforce_emea_can': {
      // Filter Rows: Area = 'Delivery Center' AND Site <> 'Supply Chain'. Site arrives as `department`.
      if (!sqlNotEqual(row.department, 'Supply Chain')) {
        return { result: 'fail', detail: `Dayforce Site is "${text(row.department) || '(blank)'}"; the filter needs a Site that is not "Supply Chain".` };
      }
      if (row.source_area === undefined) {
        return { result: 'unknown', detail: 'Dayforce Area isn\'t in fte_hr_no_filter yet, so the Area = "Delivery Center" check can\'t be confirmed.' };
      }
      return text(row.source_area) === 'Delivery Center'
        ? { result: 'pass', detail: 'Dayforce Area is "Delivery Center" and Site is not "Supply Chain".' }
        : { result: 'fail', detail: `Dayforce Area is "${text(row.source_area) || '(blank)'}"; the filter needs "Delivery Center".` };
    }
    case 'workday_ind': {
      if (!sqlIn(row.opco, WORKDAY_L3)) {
        return { result: 'fail', detail: `Workday hierarchy L3 is "${text(row.opco) || '(blank)'}"; the filter needs one of: ${WORKDAY_L3.join(', ')}.` };
      }
      if (!sqlNotEqual(row.department, WORKDAY_EXCLUDED_L5)) {
        return { result: 'fail', detail: `Workday hierarchy L5 is "${text(row.department) || '(blank)'}"; Coaching & Outplacement and blank L5 are excluded.` };
      }
      if (row.source_l4 === undefined) {
        return { result: 'unknown', detail: 'Workday hierarchy L4 isn\'t in fte_hr_no_filter yet, so the Global BPO exclusion can\'t be confirmed.' };
      }
      return sqlNotEqual(row.source_l4, WORKDAY_EXCLUDED_L4)
        ? { result: 'pass', detail: 'Workday L3 is GBS, and L4/L5 are not excluded.' }
        : { result: 'fail', detail: `Workday hierarchy L4 is "${text(row.source_l4) || '(blank)'}"; Global BPO and blank L4 are excluded.` };
    }
    case 'mexico':
      return { result: 'pass', detail: 'The Mexico feed is not filtered.' };
    default:
      return { result: 'unknown', detail: 'Could not tell which HR system this row came from.' };
  }
}

/** `filter end dates before 6_28`: keeps active, undated, or ended on/after the cutoff. */
export function checkEndDate(row: RawHrRow): CheckResult {
  const status = cleanStatus(row.status);
  const end = toIsoDate(row.end_date);
  if (status === 'active') return { result: 'pass', detail: 'Status is active.' };
  if (!end) return { result: 'pass', detail: `Status is "${status || '(blank)'}" but there is no end date.` };
  if (end >= END_DATE_CUTOFF) return { result: 'pass', detail: `End date ${end} is on or after ${END_DATE_CUTOFF}.` };
  return {
    result: 'fail',
    detail: `Status "${text(row.status) || '(blank)'}" cleans to "${status || '(blank)'}" (not active) and end date ${end} is before ${END_DATE_CUTOFF}.`,
  };
}

/**
 * `Rank & Window 1` + `Filter Rows 6`: RANK() over person_id ORDER BY cleaned_status ASC,
 * start_date DESC, keep rank 1. Ties all survive. Returns the winning rows.
 */
export function rankAssignments(rows: RawHrRow[]): RawHrRow[] {
  if (rows.length <= 1) return rows;
  const sortKey = (r: RawHrRow) => [cleanStatus(r.status).toLowerCase(), toIsoDate(r.start_date)] as const;
  const compare = (a: RawHrRow, b: RawHrRow) => {
    const [sa, da] = sortKey(a);
    const [sb, db] = sortKey(b);
    if (sa !== sb) return sa < sb ? -1 : 1;
    if (da !== db) return da > db ? -1 : 1;
    return 0;
  };
  const sorted = [...rows].sort(compare);
  return sorted.filter(r => compare(r, sorted[0]) === 0);
}

// ---------------------------------------------------------------------------------------------
// Diagnosis
// ---------------------------------------------------------------------------------------------

export type Stage = 'not_in_source' | 'excluded_by_source_filter' | 'dropped_by_etl' | 'in_roster';

export type DiagnosisCode =
  | 'in_roster'
  | 'removed_from_feed'
  | 'never_seen'
  | 'source_filter'
  | 'source_filter_unconfirmed'
  | 'missing_employee_id'
  | 'end_date_cutoff'
  | 'assignment_rank'
  | 'unknown';

export const DIAGNOSIS_LABELS: Record<DiagnosisCode, string> = {
  in_roster: 'In the roster',
  removed_from_feed: 'Was in the HR feed before, no longer is',
  never_seen: 'Never appeared in the HR feed',
  source_filter: 'Excluded by the HR system filter',
  source_filter_unconfirmed: 'May be excluded by the HR system filter',
  missing_employee_id: 'No employee ID in the HR system',
  end_date_cutoff: 'Dropped by the end-date rule',
  assignment_rank: 'Another assignment for the same ID won',
  unknown: 'Passes every rule but is not in the roster',
};

export const STAGE_LABELS: Record<Stage, string> = {
  not_in_source: 'Not in the HR feed',
  excluded_by_source_filter: 'Excluded by HR system filter',
  dropped_by_etl: 'Dropped by an FTE tool rule',
  in_roster: 'In the roster',
};

export type RowEvaluation = {
  row: RawHrRow;
  source: HrSource | null;
  sourceInferred: boolean;
  sourceFilter: CheckResult;
  hasId: boolean;
  endDate: CheckResult;
  rankWinner: boolean;
};

export type Finding = { severity: 'info' | 'warning'; message: string };

export type Diagnosis = {
  stage: Stage;
  code: DiagnosisCode;
  summary: string;
  detail: string;
  /** Pipeline steps for the strip on the page, in ETL order. */
  steps: { label: string; state: 'pass' | 'fail' | 'unknown' | 'skipped' }[];
  evaluations: RowEvaluation[];
  findings: Finding[];
  hrSource: HrSource | null;
  /** The source row the ETL would keep, or the closest one. */
  primaryRaw: RawHrRow | null;
  /** True when the source row's status is a recognised inactive value (so the HR system says they left). */
  sourceSaysInactive: boolean;
};

function evaluateRows(rawRows: RawHrRow[]): RowEvaluation[] {
  const evaluations: RowEvaluation[] = rawRows.map(row => {
    const { source, inferred } = getHrSource(row);
    return {
      row,
      source,
      sourceInferred: inferred,
      sourceFilter: checkSourceFilter(row),
      hasId: !isBlank(row.person_id),
      endDate: checkEndDate(row),
      rankWinner: false,
    };
  });

  // Rank only rows that reach `Rank & Window 1`: past the source filter and Filter Rows 4.
  const byId = new Map<string, RowEvaluation[]>();
  for (const e of evaluations) {
    if (e.sourceFilter.result === 'fail' || !e.hasId) continue;
    const id = text(e.row.person_id).toLowerCase();
    byId.set(id, [...(byId.get(id) || []), e]);
  }
  for (const group of byId.values()) {
    const winners = new Set(rankAssignments(group.map(g => g.row)));
    for (const e of group) e.rankWinner = winners.has(e.row);
  }
  return evaluations;
}

function sameValue(a: unknown, b: unknown): boolean {
  return text(a).toLowerCase() === text(b).toLowerCase();
}

function describeChange(row: HistoryHrRow): string {
  const when = toIsoDate(row.valid_from) || 'unknown date';
  const type = text(row.change_type) || 'version';
  if (type === 'changed' && row.changed_fields) return `${when}: changed ${text(row.changed_fields).split(',').join(', ')}`;
  if (type === 'dropped') return `${when}: dropped (${text(row.drop_reason) || 'reason not recorded'})`;
  return `${when}: ${type}`;
}

/**
 * Diagnoses one person. Pass every raw, roster and history row that belongs to them
 * (see `collectPersonRows`).
 */
export function diagnosePerson(rawRows: RawHrRow[], rosterRows: RosterHrRow[], historyRows: HistoryHrRow[]): Diagnosis {
  const evaluations = evaluateRows(rawRows);
  const findings: Finding[] = [];
  const history = [...historyRows].sort((a, b) => toIsoDate(a.valid_from).localeCompare(toIsoDate(b.valid_from)));

  const inSource = evaluations.length > 0;
  const passedFilter = evaluations.filter(e => e.sourceFilter.result !== 'fail');
  const filterUnknown = passedFilter.length > 0 && passedFilter.every(e => e.sourceFilter.result === 'unknown');
  const withId = passedFilter.filter(e => e.hasId);
  const winners = withId.filter(e => e.rankWinner);
  const keptByEndDate = winners.filter(e => e.endDate.result === 'pass');

  const primary =
    keptByEndDate[0] || winners[0] || withId[0] || passedFilter[0] || evaluations[0] || null;
  const hrSource = primary?.source ?? getHrSource(rosterRows[0] || history[history.length - 1]).source;
  const sourceSaysInactive = primary ? cleanStatus(primary.row.status) === 'inactive' : false;

  if (evaluations.some(e => e.sourceInferred) && evaluations.length > 0) {
    findings.push({ severity: 'info', message: 'HR system inferred from region; fte_hr_no_filter has no hr_source column yet.' });
  }
  if (withId.length > 1) {
    findings.push({
      severity: 'warning',
      message: `${withId.length} source rows share this person's ID. The ETL keeps the one ranked first (active before inactive, then latest start date).`,
    });
  }
  for (const h of history.filter(h => text(h.change_type) !== 'initial').slice(-5)) {
    findings.push({ severity: 'info', message: `History: ${describeChange(h)}` });
  }

  const steps: Diagnosis['steps'] = [
    { label: 'In HR feed', state: inSource ? 'pass' : 'fail' },
    { label: 'Passes HR system filter', state: !inSource ? 'skipped' : passedFilter.length === 0 ? 'fail' : filterUnknown ? 'unknown' : 'pass' },
    { label: 'Has employee ID', state: passedFilter.length === 0 ? 'skipped' : withId.length ? 'pass' : 'fail' },
    { label: 'Passes end-date rule', state: winners.length === 0 ? 'skipped' : keptByEndDate.length ? 'pass' : 'fail' },
    { label: 'In roster', state: rosterRows.length ? 'pass' : 'fail' },
  ];

  const base = { steps, evaluations, findings, hrSource, primaryRaw: primary?.row ?? null, sourceSaysInactive };

  if (rosterRows.length > 0) {
    const roster = rosterRows[0];
    if (text(roster.missing_flag) === '1') {
      findings.push({ severity: 'warning', message: 'Flagged as a manager/lead (missing_flag = 1): not expected to log allocations.' });
    }
    const rosterEnd = toIsoDate(roster.end_date);
    if (rosterEnd && rosterEnd < END_DATE_CUTOFF) {
      findings.push({ severity: 'warning', message: `Roster end date ${rosterEnd} is before ${END_DATE_CUTOFF}.` });
    }
    if (primary && !sameValue(primary.row.manager, roster.manager) && !isBlank(primary.row.manager)) {
      findings.push({ severity: 'info', message: `Manager differs: source "${text(primary.row.manager)}", roster "${text(roster.manager)}".` });
    }
    if (rawRows.length && !evaluations.some(e => sameValue(e.row.person_id, roster.person_id))) {
      findings.push({ severity: 'warning', message: 'The roster row\'s ID does not match any source row found for this person.' });
    }
    return {
      ...base,
      stage: 'in_roster',
      code: 'in_roster',
      summary: 'This person is in the roster the FTE tool reads.',
      detail: 'Compare the source and roster columns below for wrong values.',
    };
  }

  if (!inSource) {
    const everSeen = history.length > 0;
    const lastSeen = everSeen ? toIsoDate(history[history.length - 1].valid_from) : '';
    return {
      ...base,
      stage: 'not_in_source',
      code: everSeen ? 'removed_from_feed' : 'never_seen',
      summary: everSeen
        ? 'This person used to be in the HR feed but is no longer in it.'
        : 'This person is not in any HR source feed.',
      detail: everSeen
        ? `Last recorded in roster history around ${lastSeen || 'an unknown date'}. The HR report may be removing leavers or rehires instead of sending them with dates.`
        : 'They may not be onboarded yet, their HR profile may be incomplete, or the HR report may not include them.',
    };
  }

  if (passedFilter.length === 0) {
    return {
      ...base,
      stage: 'excluded_by_source_filter',
      code: 'source_filter',
      summary: 'This person is in the HR feed but their department or area tagging excludes them.',
      detail: evaluations.map(e => e.sourceFilter.detail).join(' '),
    };
  }

  if (withId.length === 0) {
    return {
      ...base,
      stage: 'dropped_by_etl',
      code: 'missing_employee_id',
      summary: 'This person has no employee ID in the HR system, so the ETL drops them.',
      detail: '`Filter Rows 4` keeps only rows with a person_id. For Dayforce this is the local employee ID.',
    };
  }

  if (keptByEndDate.length === 0) {
    const loserThatWouldPass = withId.find(e => !e.rankWinner && e.endDate.result === 'pass');
    if (loserThatWouldPass) {
      return {
        ...base,
        stage: 'dropped_by_etl',
        code: 'assignment_rank',
        summary: 'Another assignment with the same ID won the ranking, and that assignment is ended.',
        detail: `Kept: ${winners.map(w => `${text(w.row.status)} from ${toIsoDate(w.row.start_date) || '?'}`).join('; ')}. ${winners[0].endDate.detail} A different assignment (${text(loserThatWouldPass.row.status)} from ${toIsoDate(loserThatWouldPass.row.start_date) || '?'}) would have passed.`,
      };
    }
    return {
      ...base,
      stage: 'dropped_by_etl',
      code: 'end_date_cutoff',
      summary: 'This person is dropped by the end-date rule.',
      detail: winners[0].endDate.detail,
    };
  }

  if (filterUnknown) {
    return {
      ...base,
      stage: 'excluded_by_source_filter',
      code: 'source_filter_unconfirmed',
      summary: 'Every rule we can check passes, so the HR system filter is the likely cause.',
      detail: passedFilter.map(e => e.sourceFilter.detail).join(' '),
    };
  }

  return {
    ...base,
    stage: 'dropped_by_etl',
    code: 'unknown',
    summary: 'This person passes every rule we can replay but is not in the roster.',
    detail: 'Check whether the HR dataflow has run since the source last updated, and the definition of consolidated_hr_fte_report_view.',
  };
}

// ---------------------------------------------------------------------------------------------
// Matching rows to a person
// ---------------------------------------------------------------------------------------------

export type PersonIdentity = { personId: string; email: string; name: string };

function normName(value: unknown): string {
  return text(value).toLowerCase().replace(/\s+/g, ' ');
}

/** Rows in `rows` that belong to `who`: same ID, same email, or (for ID-less rows) same name. */
export function matchRows<T extends RawHrRow>(rows: T[], who: PersonIdentity): T[] {
  const id = who.personId.toLowerCase();
  const email = who.email.toLowerCase();
  const name = normName(who.name);
  const isMex = id.startsWith('mex');
  return rows.filter(r => {
    const rid = text(r.person_id).toLowerCase();
    const remail = text(r.person_email).toLowerCase();
    // Mexico ids are row numbers and change between runs, so match Mexico on email only.
    if (id && !isMex && rid === id) return true;
    if (email && remail === email) return true;
    if (!rid && name && normName(r.full_name) === name) return true;
    return false;
  });
}

export function collectPersonRows(
  who: PersonIdentity,
  raw: RawHrRow[],
  roster: RosterHrRow[],
  history: HistoryHrRow[],
) {
  const historyKey = who.personId.toLowerCase().startsWith('mex') ? `mex:${who.email.toLowerCase()}` : who.personId;
  return {
    raw: matchRows(raw, who),
    roster: matchRows(roster, who),
    history: history.filter(h => (historyKey && text(h.person_key) === historyKey) || matchRows([h], who).length > 0),
  };
}

// ---------------------------------------------------------------------------------------------
// Issue types and routing
// ---------------------------------------------------------------------------------------------

export type IssueType =
  | 'missing_person'
  | 'wrong_department'
  | 'wrong_manager'
  | 'wrong_title'
  | 'wrong_status_or_dates'
  | 'should_not_appear'
  | 'other';

export const ISSUE_TYPE_LABELS: Record<IssueType, string> = {
  missing_person: 'Missing from the tool',
  wrong_department: 'Wrong department',
  wrong_manager: 'Wrong manager',
  wrong_title: 'Wrong title',
  wrong_status_or_dates: 'Wrong status or dates',
  should_not_appear: 'Should not appear',
  other: 'Other',
};

/** The roster field each issue type is about, for prefilling "current value". */
export const ISSUE_TYPE_FIELD: Partial<Record<IssueType, keyof RosterHrRow>> = {
  wrong_department: 'department',
  wrong_manager: 'manager',
  wrong_title: 'title',
  wrong_status_or_dates: 'status',
};

export function suggestIssueType(diagnosis: Diagnosis): IssueType {
  return diagnosis.stage === 'in_roster' ? 'other' : 'missing_person';
}

/**
 * Who should fix it. Source data problems go to that system's HR team; problems in the FTE
 * tool's own rules go to EDAO. Admins can override.
 */
export function routeIssue(issueType: IssueType, diagnosis: DiagnosisCode, hrSource: HrSource | null, sourceSaysInactive = false): string {
  const hrTeam = hrSource ? HR_TEAMS[hrSource] : EDAO_TEAM;
  switch (diagnosis) {
    case 'removed_from_feed':
    case 'never_seen':
    case 'source_filter':
    case 'source_filter_unconfirmed':
    case 'missing_employee_id':
      return hrTeam;
    case 'end_date_cutoff':
      // A recognised terminated status means HR says they left; anything else is our status mapping.
      return sourceSaysInactive ? hrTeam : EDAO_TEAM;
    case 'assignment_rank':
    case 'unknown':
      return EDAO_TEAM;
    case 'in_roster':
      // Old leavers and mis-flagged leads showing up are our filters, not HR's data.
      if (issueType === 'other' || issueType === 'should_not_appear') return EDAO_TEAM;
      return hrTeam;
  }
}
