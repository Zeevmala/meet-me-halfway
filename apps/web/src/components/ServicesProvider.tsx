/**
 * Dependency injection boundary for the React tree.
 *
 * Hooks read their Firebase handles and graph ports from here rather than from
 * module-level singletons, which is what lets a test hand the tree a fake
 * object instead of calling `vi.mock` on `firebase/database`, `firebase/auth`,
 * `graph/ports` and the two API clients.
 */
import { createContext, useContext } from "react";
import type { ReactNode } from "react";
import type { Services } from "../lib/services";

const ServicesContext = createContext<Services | null>(null);

export function ServicesProvider({
  services,
  children,
}: {
  services: Services;
  children: ReactNode;
}) {
  return (
    <ServicesContext.Provider value={services}>
      {children}
    </ServicesContext.Provider>
  );
}

/**
 * @throws when rendered outside the provider. A hard failure beats silently
 *   falling back to a second set of Firebase handles, which is how the
 *   previous module singleton could hand two different components two
 *   different auth instances after an HMR re-evaluation.
 */
export function useServices(): Services {
  const services = useContext(ServicesContext);
  if (services === null) {
    throw new Error(
      "useServices must be used within <ServicesProvider>. " +
        "Services are created once in main.tsx and passed down.",
    );
  }
  return services;
}
