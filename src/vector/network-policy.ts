export type NetworkPolicyMode = 'disabled' | 'enabled';

export interface NetworkPolicyOptions {
  mode?: NetworkPolicyMode;
  allowedProviders?: readonly string[];
}

export class RemoteProviderBlockedError extends Error {
  readonly provider: string;

  constructor(provider: string) {
    super(
      `Remote embedding provider "${provider}" is blocked. ` +
        'Enable network access explicitly before using non-local embeddings.'
    );
    this.name = 'RemoteProviderBlockedError';
    this.provider = provider;
  }
}

export class NetworkPolicy {
  private readonly mode: NetworkPolicyMode;
  private readonly allowedProviders: Set<string>;

  constructor(options: NetworkPolicyOptions = {}) {
    this.mode = options.mode ?? 'disabled';
    this.allowedProviders = new Set(options.allowedProviders ?? []);
  }

  static disabled(): NetworkPolicy {
    return new NetworkPolicy({ mode: 'disabled' });
  }

  static enabledFor(providers: readonly string[]): NetworkPolicy {
    return new NetworkPolicy({ mode: 'enabled', allowedProviders: providers });
  }

  assertAllowed(provider: string): void {
    if (provider === 'local') {
      return;
    }
    if (this.mode !== 'enabled' || !this.allowedProviders.has(provider)) {
      throw new RemoteProviderBlockedError(provider);
    }
  }
}
