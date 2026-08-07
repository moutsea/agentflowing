import { DatabaseSync } from "node:sqlite";

import { betterAuth } from "better-auth";
import { organization } from "better-auth/plugins";

export const auth = betterAuth({
  appName: "AgentFlowing",
  baseURL: "http://localhost:5173",
  database: new DatabaseSync(":memory:"),
  emailAndPassword: {
    enabled: true,
  },
  plugins: [
    organization({
      allowUserToCreateOrganization: true,
      creatorRole: "owner",
    }),
  ],
  secret: "development-only-schema-generation-secret",
});
