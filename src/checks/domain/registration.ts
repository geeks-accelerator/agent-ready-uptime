import { badStatuses, lockChanges } from "./rdap.js";

/**
 * What a domain's registration change means, judged the same way by every monitor that reads RDAP.
 *
 * The registry renews most gTLDs (.com, .net…) by itself the day after they expire, whether or not
 * the registrar was paid: the public expiry jumps a year ahead and the status shows "auto renew
 * period" for 45 days, while the registrar may park the site. A date that moves forward is a
 * renewal only when it moved before the old expiry, without that status. (ICANN's ERRP; RFC 3915.)
 */

/** The registry's own renewal after expiry (RFC 3915's autoRenewPeriod, as RDAP writes it). */
export const AUTO_RENEW_PERIOD = "auto renew period";

/** A renewal moves the expiry forward by at least this many days (registrations are whole years). */
export const RENEWAL_MIN_DAYS = 300;

/**
 * Nameserver hosts that mean a domain was parked, typically by its registrar after it lapsed
 * (Network Solutions' pending-renewal host, the big parking services). Never a registrar's normal
 * DNS. Matched as the host or a subdomain of it.
 */
export const PARKING_NS = ["pendingrenewaldeletion.com", "parkingcrew.net", "sedoparking.com", "bodis.com"];

export interface RegistrationState {
  expiresAt: string | null;
  statusFlags: string[];
  nameservers: string[];
}

export interface RegistrationJudgement {
  /**
   * "seen": the expiry moved forward before the old one, without the registry's own renewal: the
   * registrar renewed it. "registry": it moved after expiry, or with "auto renew period": not proof
   * anyone paid. null: no change.
   */
  renewal: "seen" | "registry" | null;
  /** Expired, and only the registry has renewed it: the registrar may not have been paid. */
  unpaid: boolean;
  /** Registry statuses that take the domain out of service (holds, redemption, pending delete…). */
  bad: string[];
  /** Registrar and registry locks gone or set (only once there's a reading to compare with). */
  locks: { removed: string[]; added: string[] };
  /** Nameservers that just changed to a parking host. */
  parked: string[];
}

const DAY = 86_400_000;
const isParking = (ns: string) => PARKING_NS.some((p) => ns === p || ns.endsWith(`.${p}`));

/** The change from `before` (null on the first reading) to `after`, read at `at` (ms). */
export function judgeRegistration(before: RegistrationState | null, after: RegistrationState, at: number): RegistrationJudgement {
  const unpaid = after.statusFlags.includes(AUTO_RENEW_PERIOD);
  let renewal: RegistrationJudgement["renewal"] = null;
  if (before?.expiresAt && after.expiresAt) {
    const old = Date.parse(before.expiresAt);
    const moved = Date.parse(after.expiresAt) - old;
    if (moved >= RENEWAL_MIN_DAYS * DAY) renewal = at < old && !unpaid ? "seen" : "registry";
  }
  const compared = !!before && before.statusFlags.length > 0 && after.statusFlags.length > 0;
  const nsChanged = !!before && before.nameservers.length > 0 && before.nameservers.join(",") !== after.nameservers.join(",");
  return {
    renewal,
    unpaid,
    bad: badStatuses(after.statusFlags),
    locks: compared ? lockChanges(before!.statusFlags, after.statusFlags) : { removed: [], added: [] },
    parked: nsChanged ? after.nameservers.filter(isParking) : [],
  };
}
