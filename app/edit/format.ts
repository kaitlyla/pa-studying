// Times shown in Versions and the save banners (50 §50.4, §50.6): "MMM d, yyyy, h:mm a" in her locale's clock.
import { newDeviceId } from "../../lib/content/index.ts";
import { DEVICE_KEY } from "../auth/config.ts";

/** "Oct 4, 2026, 4:37 AM" for an ISO time. */
export function versionTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString("en-US", { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" });
}

/** localStorage `pa.device`: a 10-character Crockford id created on first use (the Device trailer). */
export function deviceId(): string {
  let id = localStorage.getItem(DEVICE_KEY);
  if (id === null || !/^[0-9A-HJKMNP-TV-Z]{10}$/.test(id)) {
    id = newDeviceId();
    localStorage.setItem(DEVICE_KEY, id);
  }
  return id;
}
