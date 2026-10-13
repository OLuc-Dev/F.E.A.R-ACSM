// Tells a downloaded install that a newer F.E.A.R. exists. One request to
// GitHub's public releases API per launch; development builds never ask.

const LATEST_RELEASE = "https://api.github.com/repos/OLuc-Dev/F.E.A.R-ACSM/releases/latest";

export interface UpdateInfo {
  version: string;
  /** The release page: notes plus the installer to download. */
  url: string;
}

function parts(version: string): number[] | null {
  const match = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(version.trim());
  return match ? match.slice(1).map(Number) : null;
}

/** Whether `candidate` is a later x.y.z than `current` (anything else: no). */
export function isNewer(candidate: string, current: string): boolean {
  const next = parts(candidate);
  const now = parts(current);
  if (!next || !now) return false;
  for (let index = 0; index < 3; index++) {
    if (next[index] !== now[index]) return next[index] > now[index];
  }
  return false;
}

/** The newer release, if there is one; null when up to date, offline, or a dev build. */
export async function checkForUpdate(
  current: string,
  fetcher: typeof fetch = fetch,
): Promise<UpdateInfo | null> {
  if (!parts(current)) return null;
  try {
    const response = await fetcher(LATEST_RELEASE, { headers: { accept: "application/vnd.github+json" } });
    if (!response.ok) return null;
    const release = (await response.json()) as { tag_name?: unknown; html_url?: unknown };
    const version = String(release.tag_name ?? "").replace(/^v/, "");
    if (!isNewer(version, current) || typeof release.html_url !== "string") return null;
    return { version, url: release.html_url };
  } catch {
    return null;
  }
}
