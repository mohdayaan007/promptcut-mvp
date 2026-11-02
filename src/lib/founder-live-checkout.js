import crypto from "crypto";
import { customerCheckoutEnabled, dodoMode } from "@/lib/dodo-config";
import { getVerifiedGoogleSubjectDigest } from "@/lib/jobs/job-store";

const PIN_NAME = "DODO_LIVE_FOUNDER_GOOGLE_SUBJECT_SHA256";

/** A configured pilot pin also fails closed if public checkout is accidentally enabled. */
export function founderLiveCheckoutRequested() {
  return dodoMode() === "live" && process.env[PIN_NAME] !== undefined;
}

export function founderLiveCheckoutConfigured() {
  return founderLiveCheckoutRequested() && !customerCheckoutEnabled()
    && /^[a-f0-9]{64}$/.test(process.env[PIN_NAME] || "");
}

/** The digest comes from the verified database identity, never request data or email. */
export async function authorizeFounderLiveCheckout(subscriberId) {
  if (!founderLiveCheckoutConfigured()) return false;
  const actual = await getVerifiedGoogleSubjectDigest(subscriberId);
  return Boolean(actual && crypto.timingSafeEqual(Buffer.from(actual, "hex"), Buffer.from(process.env[PIN_NAME], "hex")));
}
