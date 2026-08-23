type ClaimLinkNavigationRegistration = Readonly<{
  confirmLeave: () => boolean;
}>;

let activeRegistration: ClaimLinkNavigationRegistration | null = null;

/** Registers only a synchronous confirmation callback; no link secret enters this module. */
export function registerClaimLinkNavigationGuard(
  confirmLeave: () => boolean,
): () => void {
  const registration = Object.freeze({ confirmLeave });
  activeRegistration = registration;
  return () => {
    if (activeRegistration === registration) activeRegistration = null;
  };
}

/**
 * Runs before App accepts a hash route. A cancelled traversal is restored with
 * replaceState so no second hashchange or transient page unmount is triggered.
 */
export function guardClaimLinkHashNavigation(args: {
  acceptedHash: string;
  nextHash: string;
  restore: (hash: string) => void;
}): boolean {
  if (
    args.nextHash === args.acceptedHash ||
    activeRegistration === null ||
    activeRegistration.confirmLeave()
  ) {
    return true;
  }
  args.restore(args.acceptedHash);
  return false;
}

export function clearClaimLinkNavigationGuardForTests(): void {
  activeRegistration = null;
}
