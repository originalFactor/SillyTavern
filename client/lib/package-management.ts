export type PackageKind = "extension" | "server-plugin";
export type PackageAction = "install" | "upgrade" | "remove";
export type PackageIdentity = { kind: PackageKind; name: string };
export type ManagedPackage = PackageIdentity & {
  id: string;
  version?: string;
  repository?: string;
  commit?: string;
  manageable: boolean;
  diagnostic?: string;
};
export type PackageInventory = { enabled: boolean; revision: string; packages: ManagedPackage[]; diagnostics?: string[] };
export type PackageResult = PackageIdentity & { ok: boolean; message: string };
export type PackageOutcome = { results: PackageResult[]; restartRequired: boolean };
export type PackagePlan = { action: "install"; kind: PackageKind; name: string; url: string } |
  { action: "upgrade" | "remove"; packages: PackageIdentity[] };

export const packageKey = (item: PackageIdentity) => JSON.stringify([item.kind, item.name]);

export function installPlan(kind: PackageKind, name: string, source: string): PackagePlan {
  name = name.trim();
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(name)) throw new Error("Use a plugin folder name with 1–64 letters, numbers, hyphens or underscores, starting with a letter or number.");
  let url: URL;
  try { url = new URL(source.trim()); } catch { throw new Error("Use an HTTPS Git repository URL without credentials, query or fragment."); }
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) throw new Error("Use an HTTPS Git repository URL without credentials, query or fragment.");
  return { action: "install", kind, name, url: url.href };
}

// Capture exact selected identities, not a mutable filter or a future inventory.
export function bulkPlan(action: "upgrade" | "remove", inventory: ManagedPackage[], selected: ReadonlySet<string>): PackagePlan {
  const packages = inventory.filter(item => item.manageable && selected.has(packageKey(item))).map(({ kind, name }) => ({ kind, name }));
  if (!packages.length) throw new Error("Select at least one manageable plugin.");
  if (packages.length > 32) throw new Error("Select at most 32 plugins per action.");
  return { action, packages };
}

export function packageRequest(plan: PackagePlan, revision: string) {
  if (!revision) throw new Error("Reload plugin inventory before making changes.");
  return plan.action === "install" ? {
    path: "/package-management/install",
    body: { kind: plan.kind, name: plan.name, url: plan.url, expectedRevision: revision, confirmTrust: true },
  } : {
    path: "/package-management/bulk",
    body: { action: plan.action, packages: plan.packages, expectedRevision: revision, confirmTrust: true },
  };
}
