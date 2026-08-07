import type { Auth } from "./auth";
import type { Organization } from "./db/schema";

type AuthSession = Auth["$Infer"]["Session"];

export type RequestIdentity = {
  user: AuthSession["user"];
  session: AuthSession["session"];
  organization: Organization;
  role: string;
};

declare module "hono" {
  interface ContextVariableMap extends RequestIdentity {
    requestId: string;
  }
}

export type AppContext = {
  Bindings: Env;
  Variables: RequestIdentity & { requestId: string };
};
