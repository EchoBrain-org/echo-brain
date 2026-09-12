import type { OrganizationPersonToolV3 } from '@echo-brain/organization-api';
import type { PersonAccessAuthorization } from "../application/ports/person-access-authorization.js";
import type { ProviderHttpApplicationV1 } from "../application/ports/provider-http-application-v1.js";

/**
 * Provider-neutral inputs available after the Person runtime has opened its
 * Authority session store. External identity providers own all connection,
 * token, and channel details behind this boundary.
 */
export interface PersonExternalIdentityRuntimeInputV1 {
  readonly state_directory: string;
  readonly authority_id: string;
  readonly organization_id: string;
  readonly state_lineage_id: string;
  readonly authentication: {
    authenticateAccess(input: {
      readonly access_token: string;
    }): PersonAccessAuthorization;
  };
  readonly membership_type: (input: {
    readonly principal_id: string;
    readonly membership_id: string;
  }) => "employee" | "owner";
}

export interface OpenedPersonExternalIdentityRuntimeV1 {
  /** The currently-versioned external-identity HTTP application. */
  readonly application: ProviderHttpApplicationV1;
  tools(accessToken: string): Promise<readonly OrganizationPersonToolV3[]>;
  close(): void;
}

/**
 * Builds an optional external-identity application. Person runtime does not
 * select a provider or inspect provider connection material.
 */
export interface PersonExternalIdentityRuntimeBundleV1 {
  open(
    input: PersonExternalIdentityRuntimeInputV1,
  ): OpenedPersonExternalIdentityRuntimeV1;
}

/** Closed composition of independently owned identity fragments and their status ports. */
export function composePersonExternalIdentityRuntimeBundlesV1(
  bundles: readonly PersonExternalIdentityRuntimeBundleV1[],
): PersonExternalIdentityRuntimeBundleV1 {
  const selected = Object.freeze([...bundles]);
  return Object.freeze({
    open(input: PersonExternalIdentityRuntimeInputV1): OpenedPersonExternalIdentityRuntimeV1 {
      const opened: OpenedPersonExternalIdentityRuntimeV1[] = [];
      let closed = false;
      const close = (): void => {
        if (closed) return;
        closed = true;
        let failure: unknown;
        for (const item of opened.slice().reverse()) {
          try { item.close(); } catch (error) { failure ??= error; }
        }
        if (failure !== undefined) throw failure;
      };
      try {
        for (const bundle of selected) opened.push(bundle.open(input));
        const paths = new Set<string>();
        const handlers = new Map<string, { application: ProviderHttpApplicationV1; route_id: string }>();
        const routes = opened.flatMap((item, index) => item.application.routes.map(route => {
          const key = `${route.method} ${route.path}`;
          if (paths.has(key)) throw new Error('Person identity fragments claim the same HTTP route');
          paths.add(key);
          const routeId = `${index}:${route.route_id}`;
          if (handlers.has(routeId)) throw new Error('Person identity fragment has duplicate route identifiers');
          handlers.set(routeId, { application: item.application, route_id: route.route_id });
          return Object.freeze({ ...route, route_id: routeId });
        }));
        return Object.freeze({
          application: Object.freeze({
            routes: Object.freeze(routes),
            async accept(request: Parameters<ProviderHttpApplicationV1["accept"]>[0]) {
              const handler = handlers.get(request.route_id);
              if (!handler) throw new Error('Person identity route is not registered');
              return handler.application.accept({ ...request, route_id: handler.route_id });
            },
          }),
          async tools(token: string) { return (await Promise.all(opened.map(item => item.tools(token)))).flat(); },
          close,
        });
      } catch (error) {
        try { close(); } catch { /* Keep the opening failure after closing every fragment. */ }
        throw error;
      }
    },
  });
}
