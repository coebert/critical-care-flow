import { Badge } from "@/components/ui/badge";
import {
  POSTOP_STATUS_CLASS,
  POSTOP_STATUS_LABEL,
  type PostopBookingStatus,
} from "@/lib/postop-lifecycle";

export function PostopStatusBadge({
  status,
  className,
}: {
  status: PostopBookingStatus;
  className?: string;
}) {
  return (
    <Badge
      variant="secondary"
      className={`${POSTOP_STATUS_CLASS[status]} ${className ?? ""}`}
    >
      {POSTOP_STATUS_LABEL[status]}
    </Badge>
  );
}
