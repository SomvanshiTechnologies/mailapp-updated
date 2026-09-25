import { ReviewQueue } from "../components/ReviewQueue";
import { PageHeader } from "../components/ui";

export function ReviewPage() {
  return (
    <div>
      <PageHeader title="Review queue" subtitle="Drafts waiting for approval across all campaigns" />
      <ReviewQueue />
    </div>
  );
}
