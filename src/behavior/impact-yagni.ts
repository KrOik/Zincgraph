export type ImpactYagniVerdict = 'proceed' | 'inline' | 'keep-existing';

export interface ImpactCallSite {
  id?: string;
  filePath: string;
  estimatedRepeatedLines?: number;
  complexity?: 'simple' | 'moderate' | 'complex';
}

export interface ImpactYagniProposal {
  name: string;
  description?: string;
  callSites: readonly (ImpactCallSite | string)[];
  linesSavedPerSite?: number;
  minCallSites?: number;
}

export interface ImpactYagniResult {
  name: string;
  verdict: ImpactYagniVerdict;
  callSiteCount: number;
  estimatedSavedLines: number;
  message: string;
  evidence: {
    callSites: ImpactCallSite[];
    minCallSites: number;
  };
}

const DEFAULT_MIN_CALL_SITES = 2;
const DEFAULT_LINES_SAVED_PER_SITE = 3;

export class ImpactAwareYagni {
  assess(proposal: ImpactYagniProposal): ImpactYagniResult {
    const callSites = proposal.callSites.map(normalizeCallSite);
    const callSiteCount = callSites.length;
    const minCallSites = proposal.minCallSites ?? DEFAULT_MIN_CALL_SITES;
    const estimatedSavedLines = callSites.reduce(
      (total, site) => total + (site.estimatedRepeatedLines ?? proposal.linesSavedPerSite ?? DEFAULT_LINES_SAVED_PER_SITE),
      0
    );
    const allSimple = callSites.length > 0 && callSites.every((site) => site.complexity === 'simple');
    let verdict: ImpactYagniVerdict;
    let message: string;
    if (callSiteCount < minCallSites) {
      verdict = 'inline';
      message = `${proposal.name}: only ${callSiteCount} call site${callSiteCount === 1 ? '' : 's'}; suggest inlining, estimated saved lines ${estimatedSavedLines}.`;
    } else if (estimatedSavedLines <= 0 || allSimple) {
      verdict = 'keep-existing';
      message = `${proposal.name}: ${callSiteCount} call sites are already simple; keep existing code, estimated saved lines ${estimatedSavedLines}.`;
    } else {
      verdict = 'proceed';
      message = `${proposal.name}: proceed, saves about ${estimatedSavedLines} lines across ${callSiteCount} sites.`;
    }
    return {
      name: proposal.name,
      verdict,
      callSiteCount,
      estimatedSavedLines,
      message,
      evidence: { callSites, minCallSites }
    };
  }
}

export function assessImpactYagni(proposal: ImpactYagniProposal): ImpactYagniResult {
  return new ImpactAwareYagni().assess(proposal);
}

function normalizeCallSite(site: ImpactCallSite | string): ImpactCallSite {
  return typeof site === 'string' ? { filePath: site } : site;
}
