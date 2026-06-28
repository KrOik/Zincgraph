export function makeCase(spec) {
  return {
    repoId: spec.repoId,
    queryId: spec.queryId,
    tier: spec.tier,
    family: spec.family,
    query: spec.query,
    difficulty: spec.difficulty ?? 'medium',
    goldenFiles: spec.goldenFiles ?? [],
    goldenSymbols: spec.goldenSymbols ?? [],
    goldenRelations: spec.goldenRelations ?? [],
    goldenImplementations: spec.goldenImplementations ?? [],
    acceptableAlternates: spec.acceptableAlternates ?? [],
    invalidImplementations: spec.invalidImplementations ?? [],
    requiredTopK: spec.requiredTopK ?? 5,
    requiredEvidenceTerms: spec.requiredEvidenceTerms ?? [],
    forbiddenFalsePositives: spec.forbiddenFalsePositives ?? [],
    freshnessSetup: spec.freshnessSetup ?? { newTargets: [], staleTargets: [] },
    goldenTests: spec.goldenTests ?? [],
    goldenRuntimeArtifacts: spec.goldenRuntimeArtifacts ?? [],
    requiredConsequenceTerms: spec.requiredConsequenceTerms ?? [],
    impactRequired: spec.impactRequired ?? false
  };
}

export function relation(kind, from, to) {
  return { kind, from, to };
}
