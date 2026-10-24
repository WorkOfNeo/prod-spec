// =====================================================
// Change-request agent — tool implementations.
//
// The ONE list of tools the agent can call, implementing the contract in
// contract.ts (names fixed by AGENT_TOOL_NAMES). Read + draft only: see the
// rails at the top of contract.ts and design §2.
//
// Empty until the tools package lands; the job and the CLI import this list,
// so they can be built and tested against the contract in the meantime.
// =====================================================

import type { AgentTool } from "./contract";

export const AGENT_TOOLS: AgentTool[] = [];
