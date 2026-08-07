import { createContext, useContext } from "react";

export type WorkspaceAgent = {
  id: string;
  organizationId: string;
  slug: string;
  name: string;
  description: string;
  systemPrompt: string;
  model: string;
  creditCost: number;
  status: "draft" | "live" | "archived";
  visibility: "private" | "workspace" | "public";
  createdBy: string;
  createdAt: string;
  updatedAt: string;
};

export type WorkspaceSession = {
  user: {
    id: string;
    name: string;
    email: string;
    image?: string | null;
  };
  organization: {
    id: string;
    name: string;
    slug: string;
    logo?: string | null;
  };
  role: string;
  credits?: {
    balance: number;
    lifetimeGranted: number;
    lifetimeSpent: number;
  } | null;
  organizations: Array<{
    organization: {
      id: string;
      name: string;
      slug: string;
      logo?: string | null;
    };
    role: string;
  }>;
};

export type WorkspaceContextValue = {
  session: WorkspaceSession;
  agents: WorkspaceAgent[];
  refreshWorkspace: () => Promise<void>;
};

export const WorkspaceContext = createContext<WorkspaceContextValue | null>(null);

export function useWorkspace() {
  const value = useContext(WorkspaceContext);
  if (!value) throw new Error("WorkspaceContext is not available");
  return value;
}
