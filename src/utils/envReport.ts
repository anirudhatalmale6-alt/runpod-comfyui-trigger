/**
 * Environment-variable inspection, kept free of any Trigger.dev import so it can
 * be unit tested. configDoctor is a thin wrapper over this.
 *
 * SECRETS ARE NEVER RETURNED. Presence, length and shape only — length alone is
 * safe to log and is usually enough to spot a truncated paste.
 */

export type VarReport = {
  name: string;
  present: boolean;
  /** Character count of the raw value. Never the value itself. */
  length: number;
  /** Present but only whitespace. */
  blank: boolean;
  /** Leading or trailing whitespace — a copy-paste artefact. */
  untrimmed: boolean;
};

export function inspectVar(name: string, env: NodeJS.ProcessEnv = process.env): VarReport {
  const raw = env[name];
  if (raw === undefined) {
    return { name, present: false, length: 0, blank: false, untrimmed: false };
  }
  const trimmed = raw.trim();
  return {
    name,
    present: true,
    length: raw.length,
    blank: trimmed.length === 0,
    untrimmed: trimmed.length !== raw.length,
  };
}

/**
 * Turn reports into human-readable problems. `environmentType` is named in every
 * message because Trigger.dev environment variables are scoped per environment,
 * and "set in Development, run in Production" is the usual cause.
 */
export function problemsFor(reports: VarReport[], environmentType: string): string[] {
  const problems: string[] = [];
  for (const report of reports) {
    if (!report.present) {
      problems.push(
        `${report.name} is NOT SET in the ${environmentType} environment. ` +
          `Set it under Project Settings > Environment Variables with ${environmentType} ticked.`,
      );
    } else if (report.blank) {
      problems.push(`${report.name} is set but empty.`);
    } else if (report.untrimmed) {
      problems.push(
        `${report.name} has leading or trailing whitespace (${report.length} chars including it). ` +
          `That will be sent verbatim in the Authorization header and rejected — re-paste it.`,
      );
    }
  }
  return problems;
}

/** Safe projection for logging: never includes values. */
export function loggableReport(report: VarReport): { name: string; present: boolean; length: number } {
  return { name: report.name, present: report.present, length: report.length };
}
