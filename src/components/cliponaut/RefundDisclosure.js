import Link from "next/link";
import { REFUND_FAILED_RENDERS, REFUND_RENDER_CUTOFF, REFUND_SUMMARY } from "@/lib/billing-policy";

export function RefundDisclosure({ id }) {
  return <p id={id} className="cliponaut-refund-disclosure">
    {REFUND_SUMMARY} {REFUND_RENDER_CUTOFF} {REFUND_FAILED_RENDERS}{" "}
    <Link href="/refunds">Read the full refund policy</Link>.
  </p>;
}
