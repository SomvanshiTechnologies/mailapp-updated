import type { App, Environment } from "aws-cdk-lib";
import type { MailAppConfig } from "../config.js";
import { NetworkStack } from "./network-stack.js";
import { DataStack } from "./data-stack.js";
import { MessagingStack } from "./messaging-stack.js";
import { ComputeStack } from "./compute-stack.js";
import { ObservabilityStack } from "./observability-stack.js";

export interface MailAppStacks {
  network: NetworkStack;
  data: DataStack;
  messaging: MessagingStack;
  compute: ComputeStack;
  observability: ObservabilityStack;
}

/** Instantiate every stack in dependency order. Shared by bin/app.ts and the tests. */
export function buildStacks(app: App, config: MailAppConfig): MailAppStacks {
  const env: Environment = config.account
    ? { account: config.account, region: config.region }
    : { region: config.region };
  const prefix = `MailApp-${config.envName}`;

  const network = new NetworkStack(app, `${prefix}-Network`, { env, config });
  const data = new DataStack(app, `${prefix}-Data`, { env, config, network });
  const messaging = new MessagingStack(app, `${prefix}-Messaging`, { env, config, data });
  const compute = new ComputeStack(app, `${prefix}-Compute`, { env, config, network, data, messaging });
  const observability = new ObservabilityStack(app, `${prefix}-Observability`, {
    env,
    config,
    data,
    messaging,
    compute,
  });
  return { network, data, messaging, compute, observability };
}
