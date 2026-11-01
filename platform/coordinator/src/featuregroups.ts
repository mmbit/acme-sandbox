// Explicit historical feature membership from company/features.yaml, before live corrections.
import { existsSync } from 'node:fs';
import { parse } from 'yaml';
import { REPO_DIR } from './config.ts';
import { readOnce } from './company.ts';

type Group = { feature: string; work?: string[]; feedback?: { round: string; deliverables: string[] }[] };
export function featureGroups() {
  const file = `${REPO_DIR}/company/features.yaml`;
  if (!existsSync(file)) return [];
  const groups = readOnce(file, source => parse(source) as { features: Group[] }).features;
  return groups.flatMap(group => [
    ...(group.work ?? []).map(thread => ({ thread, feature: group.feature, feedback: false, round: '' })),
    ...(group.feedback ?? []).flatMap(round =>
      round.deliverables.map(thread => ({ thread, feature: group.feature, feedback: true, round: round.round })),
    ),
  ]);
}
