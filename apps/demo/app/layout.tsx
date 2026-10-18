import type { Metadata } from "next";
import "@copilotkit/react-core/v2/styles.css";
import "./styles.css";

export const metadata: Metadata = {
  title: "Foundry + agentgateway tutors",
  description: "Compare delegated hosted-agent inference with prompt-agent OAuth2.",
};

export default function Layout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="en"><body>{children}</body></html>;
}
