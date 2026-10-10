import type { Plugin } from "vite";
import { ranaProviderConfigMiddleware } from "./plugins/provider-config";
import { ranaSysStatusMiddleware } from "./plugins/sys-status";
import { ranaAvatarMiddleware } from "./plugins/avatar";
import { ranaNewsMiddleware } from "./plugins/news";
import { ranaStudyMiddleware } from "./plugins/study";
import { ranaEventsMiddleware } from "./plugins/events";
import { ranaBangumiMiddleware } from "./plugins/bangumi";
import { ranaLifeMiddleware } from "./plugins/life";
import { ranaFateMiddleware } from "./plugins/fate";
import { ranaModelParamsMiddleware } from "./plugins/model-params";
import { ranaModelTestMiddleware } from "./plugins/model-test";
import { ranaAgentInfoMiddleware } from "./plugins/agent-info";
import { ranaQqProfileMiddleware } from "./plugins/qq-profile";
import { ranaDshModelsMiddleware } from "./plugins/dsh-models";
import { ranaDevConfig } from "./plugins/dev-config";
import { ranaAgentsMiddleware } from "./plugins/agents";
import { ranaSessionsCleanupMiddleware } from "./plugins/sessions-cleanup";
import { ranaContextMiddleware } from "./plugins/context";
import { ranaApprovalsMiddleware } from "./plugins/approvals";
import { ranaMemoryMiddleware } from "./plugins/memory";
import { bridgeSyncMiddleware } from "./plugins/bridge-sync";

/** 按原有顺序装配全部 /__rana 中间件（react() 由 vite.config.ts 自行前置）。 */
export function buildServerPlugins(): Plugin[] {
  return [
    ranaDevConfig(),
    ranaAgentsMiddleware(),
    ranaProviderConfigMiddleware(),
    ranaSysStatusMiddleware(),
    ranaAvatarMiddleware(),
    ranaNewsMiddleware(),
    ranaStudyMiddleware(),
    ranaEventsMiddleware(),
    ranaBangumiMiddleware(),
    ranaLifeMiddleware(),
    ranaFateMiddleware(),
    ranaAgentInfoMiddleware(),
    ranaQqProfileMiddleware(),
    ranaDshModelsMiddleware(),
    ranaModelTestMiddleware(),
    ranaModelParamsMiddleware(),
    ranaSessionsCleanupMiddleware(),
    ranaApprovalsMiddleware(),
    ranaContextMiddleware(),
    ranaMemoryMiddleware(),
    bridgeSyncMiddleware(),
  ];
}
