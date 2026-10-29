
'use client';

import { PageHeader } from '@/components/page-header';
import { HrDataIssuesContent } from '@/components/hr_data_issues/hr-data-issues-content';

export default function HrDataIssuesPage() {
  return (
    <div className="flex flex-col gap-8">
      <PageHeader
        title="HR Data Issues"
        description="Check what the HR data shows for a person and log anything missing or wrong."
      />
      <HrDataIssuesContent />
    </div>
  );
}
