import type { App, Environment } from "aws-cdk-lib";
import type { MailAppConfig } from "../config.js";
import { NetworkStack } from "./network-stack.js";
import { DataStack } from "./data-stack.js";
import { MessagingStack } from "./messaging-stack.js";
import { ComputeStack } from "./compute-stack.js";
import { ObservabilityStack } from "./observability-stack.js";
import { StorageStack } from "./storage-stack.js";
import { Ec2Stack } from "./ec2-stack.js";

export interface MailAppStacks {
  network: NetworkStack;
  data: DataStack;
  messaging: MessagingStack;
  compute: ComputeStack;
  observability: ObservabilityStack;
}

export interface MailAppEc2Stacks {
  storage: StorageStack;
  messaging: MessagingStack;
  ec2: Ec2Stack;
}

/** deployTarget=ec2: inbound bucket + SES config + one EC2 host (no VPC/RDS/ECS/ALB stacks). */
export function buildEc2Stacks(app: App, config: MailAppConfig): MailAppEc2Stacks {
  const env: Environment = config.account
    ? { account: config.account, region: config.region }
    : { region: config.region };
  const prefix = `MailApp-${config.envName}`;
  const storage = new StorageStack(app, `${prefix}-Storage`, { env, config });
  const messaging = new MessagingStack(app, `${prefix}-Messaging`, { env, config, data: storage });
  const ec2 = new Ec2Stack(app, `${prefix}-Ec2`, { env, config, storage, messaging });
  return { storage, messaging, ec2 };
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
